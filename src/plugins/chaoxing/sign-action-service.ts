import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { ChaoxingOwnerCoordinator } from './owner-coordinator.js';
import type { ChaoxingSignService, ChaoxingSignInput, ChaoxingSignType, DetectedSign } from './sign-service.js';
import type { ChaoxingTaskStore } from './store.js';
import {
  ChaoxingProtocolError,
  ChaoxingUserError,
  type ChaoxingSignAction,
  type OwnerIdentity,
} from './types.js';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_QR_TEXT_LENGTH = 4096;
const QR_ARM_TTL_MS = 120_000;
const QR_ARM_REFRESH_THRESHOLD_MS = 30_000;
const ACCEPTED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const UNCERTAIN_ERROR_CODES = new Set(['sign_outcome_unknown', 'sign_verification_failed']);

export interface ChaoxingSignActionRuntimeConfig {
  publicBaseUrl: string;
  actionPagePath: string;
  actionTokenTtlMs: number;
}

export interface ChaoxingSignActionMetadata {
  dynamicQr: boolean;
  targetLocation: {
    text: string;
    latitude: number;
    longitude: number;
    rangeMeters: number;
  } | null;
  activityEndAt: number | null;
}

export interface ChaoxingSignActionLink {
  activityId: string;
  courseName: string;
  activityTitle: string;
  signType: ChaoxingSignType;
  link: string;
  expiresAt: number;
}

export interface ChaoxingSignActionPageState {
  action: ChaoxingSignAction;
  metadata: ChaoxingSignActionMetadata;
}

export interface ChaoxingQrArmState {
  armedAt: number;
  expiresAt: number;
}

export interface ChaoxingSignActionSubmission {
  body?: Record<string, unknown>;
  image?: {
    bytes: Uint8Array;
    contentType: string;
    filename: string;
  };
}

export class ChaoxingSignActionService {
  private readonly armedQrActions = new Map<number, { detected: DetectedSign; armedAt: number; expiresAt: number }>();

  constructor(
    private readonly store: ChaoxingTaskStore,
    private readonly signService: ChaoxingSignService,
    private readonly coordinator: ChaoxingOwnerCoordinator,
    private readonly config: ChaoxingSignActionRuntimeConfig,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async createActions(identity: OwnerIdentity, signs: DetectedSign[]): Promise<ChaoxingSignActionLink[]> {
    for (const sign of signs) assertActionSupported(sign);
    const links: ChaoxingSignActionLink[] = [];
    for (const sign of signs) links.push(await this.createAction(identity, sign));
    return links;
  }

  async resolvePage(token: string): Promise<ChaoxingSignActionPageState> {
    const action = await this.requireAction(token);
    return { action, metadata: parseMetadata(action.metadataJson) };
  }

  async armQr(token: string): Promise<ChaoxingQrArmState> {
    const action = await this.requireAction(token);
    if (action.status !== 'created') throw new ChaoxingUserError('这个签到链接正在处理或已经失效。');
    if (action.signType !== 'qrcode') throw new ChaoxingUserError('这个链接不属于二维码签到。');
    return this.coordinator.run(action.ownerKey, async () => {
      const now = this.now();
      const cached = this.armedQrActions.get(action.id);
      if (cached && cached.expiresAt - now > QR_ARM_REFRESH_THRESHOLD_MS) {
        return { armedAt: cached.armedAt, expiresAt: cached.expiresAt };
      }
      this.armedQrActions.delete(action.id);
      const detected = await this.signService.resolveDetectedSignForAction(actionIdentity(action), action);
      if (detected.signType !== 'qrcode') throw new ChaoxingUserError('签到活动类型已经变化，请重新获取链接。');
      assertActionSupported(detected);
      const current = await this.requireAction(token);
      if (current.id !== action.id || current.status !== 'created') throw new ChaoxingUserError('这个签到链接正在处理或已经失效。');
      const armedAt = this.now();
      const expiresAt = Math.min(current.expiresAt, armedAt + QR_ARM_TTL_MS);
      this.armedQrActions.set(action.id, { detected, armedAt, expiresAt });
      return { armedAt, expiresAt };
    });
  }

  async submit(token: string, submission: ChaoxingSignActionSubmission): Promise<ChaoxingSignActionPageState> {
    const action = await this.requireAction(token);
    if (action.status === 'completed' || action.status === 'uncertain') {
      return { action, metadata: parseMetadata(action.metadataJson) };
    }
    if (action.status !== 'created') throw new ChaoxingUserError('这个签到链接正在处理或已经失效。');
    const attemptId = randomUUID();
    const claimed = await this.store.claimSignAction(action.id, attemptId, this.now());
    if (!claimed) throw new ChaoxingUserError('这个签到链接已被另一个请求占用，请刷新页面查看结果。');

    try {
      const result = await this.coordinator.run(claimed.ownerKey, async () => {
        const identity = actionIdentity(claimed);
        const detected = claimed.signType === 'qrcode'
          ? this.requireArmedQr(claimed)
          : await this.signService.resolveDetectedSignForAction(identity, claimed);
        if (detected.signType !== claimed.signType) throw new ChaoxingUserError('签到活动类型已经变化，请重新获取链接。');
        const input = await buildSignInput(detected, submission);
        return this.signService.execute(identity, detected, input);
      });
      const completed = await this.store.completeSignAction(claimed.id, attemptId, result.message, this.now());
      if (!completed) throw new Error('sign action completion lost ownership');
      this.armedQrActions.delete(claimed.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof ChaoxingProtocolError && UNCERTAIN_ERROR_CODES.has(error.code)) {
        await this.store.finishSignActionUncertain(claimed.id, attemptId, message, this.now());
        this.armedQrActions.delete(claimed.id);
      } else {
        await this.store.releaseSignAction(claimed.id, attemptId, message, this.now());
      }
      throw error;
    }
    const completedAction = await this.store.findSignActionByTokenHash(hashToken(token));
    if (!completedAction) throw new Error('completed sign action disappeared');
    return { action: completedAction, metadata: parseMetadata(completedAction.metadataJson) };
  }

  private requireArmedQr(action: ChaoxingSignAction): DetectedSign {
    const armed = this.armedQrActions.get(action.id);
    if (!armed || armed.expiresAt <= this.now()) {
      this.armedQrActions.delete(action.id);
      throw new ChaoxingUserError('连续扫码准备已过期，请点击“开始连续扫码”重新准备。');
    }
    if (armed.detected.activity.activityId !== action.activityId || armed.detected.signType !== action.signType) {
      this.armedQrActions.delete(action.id);
      throw new Error('armed QR action does not match its activity');
    }
    return armed.detected;
  }

  private async createAction(identity: OwnerIdentity, sign: DetectedSign): Promise<ChaoxingSignActionLink> {
    assertActionSupported(sign);
    const now = this.now();
    const expiresAt = Math.min(now + this.config.actionTokenTtlMs, sign.info.endAt ?? Number.POSITIVE_INFINITY);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) throw new ChaoxingUserError('签到活动已经截止。');
    if (await this.store.findSubmittingSignAction(identity.ownerKey, sign.activity.activityId)) {
      throw new ChaoxingUserError(`${sign.activity.title || '签到'}正在提交，请等待当前请求完成。`);
    }
    await this.store.cancelOpenSignActions(identity.ownerKey, sign.activity.activityId, now);
    if (await this.store.findSubmittingSignAction(identity.ownerKey, sign.activity.activityId)) {
      throw new ChaoxingUserError(`${sign.activity.title || '签到'}正在提交，请等待当前请求完成。`);
    }
    const token = randomBytes(32).toString('base64url');
    await this.store.createSignAction(identity, {
      tokenHash: hashToken(token),
      activityId: sign.activity.activityId,
      courseId: sign.course.courseId,
      classId: sign.course.classId,
      courseName: sign.course.name,
      activityTitle: sign.activity.title || '签到',
      signType: sign.signType,
      metadataJson: JSON.stringify(signMetadata(sign)),
      expiresAt,
    }, now);
    return {
      activityId: sign.activity.activityId,
      courseName: sign.course.name,
      activityTitle: sign.activity.title || '签到',
      signType: sign.signType,
      link: `${this.config.publicBaseUrl}${this.config.actionPagePath}?token=${encodeURIComponent(token)}`,
      expiresAt,
    };
  }

  private async requireAction(token: string): Promise<ChaoxingSignAction> {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) throw new ChaoxingUserError('签到链接无效。');
    const now = this.now();
    await this.store.cleanupExpiredSignActions(now);
    const action = await this.store.findSignActionByTokenHash(hashToken(token));
    if (!action || action.expiresAt <= now || action.status === 'expired' || action.status === 'cancelled') {
      throw new ChaoxingUserError('签到链接无效或已过期。');
    }
    return action;
  }
}

function signMetadata(sign: DetectedSign): ChaoxingSignActionMetadata {
  const latitude = sign.info.locationLatitude;
  const longitude = sign.info.locationLongitude;
  const rangeMeters = sign.info.locationRangeMeters;
  const targetLocation = sign.info.locationText
    && latitude !== null
    && longitude !== null
    && rangeMeters !== null
    && rangeMeters > 0
    ? { text: sign.info.locationText, latitude, longitude, rangeMeters }
    : null;
  return { dynamicQr: sign.info.ifRefreshQr, targetLocation, activityEndAt: sign.info.endAt };
}

function parseMetadata(value: string): ChaoxingSignActionMetadata {
  const parsed = JSON.parse(value) as Partial<ChaoxingSignActionMetadata>;
  if (typeof parsed.dynamicQr !== 'boolean' || !('targetLocation' in parsed) || !('activityEndAt' in parsed)) {
    throw new Error('invalid chaoxing sign action metadata');
  }
  return parsed as ChaoxingSignActionMetadata;
}

function assertActionSupported(sign: DetectedSign): void {
  if (sign.signType === 'unknown') throw new ChaoxingUserError('当前签到类型无法识别，不能生成交互链接。');
  if (sign.info.ifNeedVCode) throw new ChaoxingUserError('本次签到要求验证码，当前交互链接无法完成。');
  if (sign.info.openCheckFaceFlag) throw new ChaoxingUserError('本次签到要求人脸验证，当前交互链接无法代替本人验证。');
  if (sign.signType === 'location' && !signMetadata(sign).targetLocation) {
    throw new ChaoxingProtocolError('sign_location_fields', '位置签到缺少教师设置的完整坐标范围。');
  }
  if (sign.signType === 'qrcode' && sign.info.locationText && !signMetadata(sign).targetLocation) {
    throw new ChaoxingProtocolError('sign_location_fields', '教师设置了位置要求，但学习通没有返回完整坐标范围。');
  }
}

async function buildSignInput(detected: DetectedSign, submission: ChaoxingSignActionSubmission): Promise<ChaoxingSignInput> {
  if (detected.signType === 'normal') return { kind: 'normal' };
  if (detected.signType === 'gesture' || detected.signType === 'code') {
    const signCode = requiredText(submission.body?.signCode, '请填写签到码或手势顺序。', 128);
    return { kind: 'code', signCode };
  }
  if (detected.signType === 'location') return { kind: 'location', location: browserLocation(submission.body) };
  if (detected.signType === 'photo') {
    const image = requireImage(submission.image);
    return { kind: 'photo', ...image };
  }
  if (detected.signType === 'qrcode') {
    const qrText = requiredText(submission.body?.qrText, '请扫描或粘贴教师当前展示的二维码。', MAX_QR_TEXT_LENGTH);
    const qr = parseSignQrPayload(qrText, detected.activity.activityId);
    const location = signMetadata(detected).targetLocation ? browserLocation(submission.body) : undefined;
    return { kind: 'qrcode', ...qr, location };
  }
  throw new ChaoxingUserError('当前签到类型无法识别。');
}

export function parseSignQrPayload(raw: string, expectedActivityId: string): { enc: string; code?: string } {
  const text = raw.trim();
  if (!text || text.length > MAX_QR_TEXT_LENGTH) throw new ChaoxingUserError('二维码内容无效。');
  const params = qrParameters(text);
  const activityId = firstParam(params, ['activeId', 'activityId', 'aid', 'id']);
  if (activityId && activityId !== expectedActivityId) throw new ChaoxingUserError('二维码属于另一个签到活动。');
  const enc = firstParam(params, ['enc']);
  if (!enc || enc.length > 1024) throw new ChaoxingUserError('二维码缺少有效的 enc 参数。');
  const code = firstParam(params, ['Code', 'code']);
  return { enc, ...(code ? { code } : {}) };
}

function qrParameters(text: string): URLSearchParams {
  if (/^SIGNIN:/iu.test(text)) return new URLSearchParams(text.slice(text.indexOf(':') + 1));
  try {
    return new URL(text).searchParams;
  } catch {
    if (text.includes('=') && text.includes('&')) return new URLSearchParams(text);
    throw new ChaoxingUserError('无法识别二维码内容。');
  }
}

function requireImage(image: ChaoxingSignActionSubmission['image']): NonNullable<ChaoxingSignActionSubmission['image']> {
  if (!image || image.bytes.byteLength === 0) throw new ChaoxingUserError('请选择或拍摄图片。');
  if (image.bytes.byteLength > MAX_IMAGE_BYTES) throw new ChaoxingUserError('图片不能超过 8 MiB。');
  if (!ACCEPTED_IMAGE_TYPES.has(image.contentType)) throw new ChaoxingUserError('仅支持 JPEG、PNG 或 WebP 图片。');
  return image;
}

function browserLocation(body: Record<string, unknown> | undefined) {
  const latitude = Number(body?.latitude);
  const longitude = Number(body?.longitude);
  const accuracy = Number(body?.accuracy);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !Number.isFinite(accuracy)) {
    throw new ChaoxingUserError('请允许浏览器获取当前位置。');
  }
  return { latitude, longitude, accuracy };
}

function requiredText(value: unknown, message: string, maximumLength: number): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new ChaoxingUserError(message);
  if (text.length > maximumLength) throw new ChaoxingUserError('输入内容过长。');
  return text;
}

function firstParam(params: URLSearchParams, names: string[]): string {
  for (const name of names) {
    const value = params.get(name)?.trim();
    if (value) return value;
  }
  return '';
}

function actionIdentity(action: ChaoxingSignAction): OwnerIdentity {
  return { ownerKey: action.ownerKey, platform: action.platform, qqUserId: action.qqUserId, channelId: action.channelId };
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

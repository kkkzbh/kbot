import type { ChaoxingAuthService } from './auth-service.js';
import type { ChaoxingCatalogService } from './catalog-service.js';
import type { ChaoxingClient, ChaoxingSignInfo } from './client.js';
import type { ChaoxingTaskStore } from './store.js';
import {
  ChaoxingCaptchaRequiredError,
  ChaoxingProtocolError,
  ChaoxingUserError,
  type ChaoxingActivity,
  type ChaoxingCourse,
  type OwnerIdentity,
} from './types.js';

export type SupportedSignType = 'normal' | 'gesture' | 'code';
export type ChaoxingSignType = SupportedSignType | 'photo' | 'qrcode' | 'location' | 'unknown';

export interface DetectedSign {
  course: ChaoxingCourse;
  activity: ChaoxingActivity;
  signType: ChaoxingSignType;
  info: ChaoxingSignInfo;
}

export interface ChaoxingSignRuntimeConfig {
  requestIntervalMs: number;
}

export class ChaoxingSignService {
  constructor(
    private readonly authService: ChaoxingAuthService,
    private readonly catalogService: ChaoxingCatalogService,
    private readonly client: ChaoxingClient,
    private readonly store: ChaoxingTaskStore,
    private readonly config: ChaoxingSignRuntimeConfig,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async scanOpenSigns(identity: OwnerIdentity, courseQuery?: string): Promise<DetectedSign[]> {
    const courses = courseQuery
      ? [await this.catalogService.resolveCourse(identity, courseQuery)]
      : await this.catalogService.listCourses(identity);
    let auth = await this.authService.getAuthenticatedSession(identity);
    const detected: DetectedSign[] = [];
    for (const course of courses) {
      const activityResult = await this.client.getActivities(auth.cookieJar, course);
      auth = await this.authService.persistCookies(auth, activityResult.cookieJar);
      const openActivities = activityResult.activities.filter((activity) => activity.status === 1);
      for (const activity of openActivities) {
        const infoResult = await this.client.getSignInfo(auth.cookieJar, activity.activityId);
        auth = await this.authService.persistCookies(auth, infoResult.cookieJar);
        detected.push({ course, activity, info: infoResult.info, signType: classifySignType(infoResult.info) });
        await delay(this.config.requestIntervalMs);
      }
    }
    return detected;
  }

  async execute(identity: OwnerIdentity, detected: DetectedSign, signCode?: string, jobId?: number): Promise<{ status: 'succeeded' | 'already_signed'; message: string }> {
    const requestAudit = {
      activityId: detected.activity.activityId,
      courseId: detected.course.courseId,
      classId: detected.course.classId,
      signType: detected.signType,
      hasSignCode: Boolean(signCode),
    };
    try {
      assertSupported(detected, signCode);
      let auth = await this.authService.getAuthenticatedSession(identity);
      if (detected.info.ifNeedVCode) throw new ChaoxingCaptchaRequiredError('本次签到要求验证码，自动签到已暂停。');
      if (detected.info.openCheckFaceFlag) throw new ChaoxingUserError('本次签到要求人脸验证，第一阶段不执行。');
      const prepared = await this.client.prepareSign(auth.cookieJar, { activity: detected.activity, profile: auth.profile });
      auth = await this.authService.persistCookies(auth, prepared.cookieJar);
      if (signCode) {
        const checked = await this.client.checkSignCode(auth.cookieJar, detected.activity.activityId, signCode);
        auth = await this.authService.persistCookies(auth, checked.cookieJar);
        if (!checked.valid) throw new ChaoxingUserError('签到码或手势顺序不正确。');
      }
      if (!auth.profile.deviceCode) throw new Error('chaoxing profile is missing device code.');
      const submitted = await this.client.submitSign(auth.cookieJar, {
        activity: detected.activity,
        profile: auth.profile,
        deviceCode: auth.profile.deviceCode,
        signCode,
      });
      await this.authService.persistCookies(auth, submitted.cookieJar);
      await this.store.addSignRecord({
        ownerKey: identity.ownerKey, jobId: jobId ?? null, activityId: detected.activity.activityId,
        courseId: detected.course.courseId, classId: detected.course.classId, signType: detected.signType,
        status: submitted.status, requestJson: JSON.stringify(requestAudit), responseText: submitted.responseText, createdAt: this.now(),
      });
      return {
        status: submitted.status,
        message: submitted.status === 'succeeded' ? `${detected.course.name} / ${detected.activity.title}：签到成功。` : `${detected.course.name} / ${detected.activity.title}：此前已经签到。`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const remoteResponse = error instanceof ChaoxingProtocolError || error instanceof ChaoxingCaptchaRequiredError
        ? error.responseExcerpt
        : undefined;
      await this.store.addSignRecord({
        ownerKey: identity.ownerKey, jobId: jobId ?? null, activityId: detected.activity.activityId,
        courseId: detected.course.courseId, classId: detected.course.classId, signType: detected.signType,
        status: error instanceof ChaoxingCaptchaRequiredError ? 'waiting_input' : 'failed',
        requestJson: JSON.stringify(requestAudit),
        responseText: JSON.stringify({ message, remoteResponse: remoteResponse ?? null, signInfo: detected.info.raw }),
        createdAt: this.now(),
      });
      throw error;
    }
  }

  async resolveDetectedSign(identity: OwnerIdentity, activityId: string, courseQuery?: string): Promise<DetectedSign> {
    const signs = filterPendingSigns(await this.scanOpenSigns(identity, courseQuery));
    if (activityId) {
      const matched = signs.find((sign) => sign.activity.activityId === activityId);
      if (!matched) throw new ChaoxingUserError(`没有找到进行中的签到活动 ${activityId}。`);
      return matched;
    }
    if (signs.length === 0) throw new ChaoxingUserError('当前没有检测到进行中的签到。');
    if (signs.length > 1) throw new ChaoxingUserError(`检测到多个签到，请指定活动 ID：\n${formatDetectedSigns(signs)}`);
    return signs[0]!;
  }
}

export function classifySignType(info: Pick<ChaoxingSignInfo, 'otherId' | 'ifPhoto'>): ChaoxingSignType {
  if (info.otherId === '0') return info.ifPhoto ? 'photo' : 'normal';
  if (info.otherId === '1') return 'photo';
  if (info.otherId === '2') return 'qrcode';
  if (info.otherId === '3') return 'gesture';
  if (info.otherId === '4') return 'location';
  if (info.otherId === '5') return 'code';
  return 'unknown';
}

export function filterPendingSigns(signs: DetectedSign[]): DetectedSign[] {
  return signs.filter((sign) => sign.activity.userStatus !== 1);
}

export function formatDetectedSigns(signs: DetectedSign[]): string {
  if (signs.length === 0) return '当前没有进行中的签到。';
  return signs.map((sign) => {
    const type = signTypeLabel(sign.signType);
    const status = sign.activity.userStatus === 1 ? '已签到' : '待签到';
    const end = sign.info.endAt ? `，截止 ${formatDate(sign.info.endAt)}` : '';
    return `- ${sign.course.name} / ${sign.activity.title || '签到'}（${type}，${status}，活动ID ${sign.activity.activityId}${end}）`;
  }).join('\n');
}

function assertSupported(sign: DetectedSign, signCode?: string): asserts sign is DetectedSign & { signType: SupportedSignType } {
  if (sign.signType === 'gesture' || sign.signType === 'code') {
    if (!signCode?.trim()) throw new ChaoxingUserError(`${signTypeLabel(sign.signType)}需要提供签到码或手势顺序。`);
    return;
  }
  if (sign.signType === 'normal') return;
  throw new ChaoxingProtocolError('unsupported_sign_type', `${signTypeLabel(sign.signType)}将在第二阶段实现。`);
}

function signTypeLabel(type: ChaoxingSignType): string {
  if (type === 'normal') return '普通签到';
  if (type === 'gesture') return '手势签到';
  if (type === 'code') return '签到码签到';
  if (type === 'photo') return '拍照签到';
  if (type === 'qrcode') return '二维码签到';
  if (type === 'location') return '位置签到';
  return '未知签到类型';
}

function formatDate(value: number): string {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(value);
}

function delay(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

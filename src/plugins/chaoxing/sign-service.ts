import type { ChaoxingAuthService } from './auth-service.js';
import type { ChaoxingCatalogService } from './catalog-service.js';
import type { ChaoxingAttendance, ChaoxingClient, ChaoxingSignInfo } from './client.js';
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
  attendance: ChaoxingAttendance;
}

export interface ChaoxingSignRuntimeConfig {
  requestIntervalMs: number;
}

export interface ChaoxingSignExecutionResult {
  status: 'succeeded' | 'already_signed';
  officialStatus: number;
  message: string;
}

const SIGN_VERIFICATION_ATTEMPTS = 3;

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
        const attendanceResult = await this.client.getAttendInfo(auth.cookieJar, activity.activityId);
        auth = await this.authService.persistCookies(auth, attendanceResult.cookieJar);
        detected.push({
          course,
          activity,
          info: infoResult.info,
          signType: classifySignType(infoResult.info),
          attendance: attendanceResult.attendance,
        });
        await delay(this.config.requestIntervalMs);
      }
    }
    return detected;
  }

  async quickSign(identity: OwnerIdentity): Promise<string> {
    const signs = await this.scanOpenSigns(identity);
    const pending = filterPendingSigns(signs);
    if (pending.length === 0) {
      return signs.length === 0 ? '当前没有进行中的签到。' : `当前没有待签到。\n${formatDetectedSigns(signs)}`;
    }
    const automatic = pending.filter(isAutomaticallyExecutable);
    if (automatic.length !== 1) {
      const heading = automatic.length > 1
        ? '检测到多个可自动处理的普通签到，请指定活动 ID，避免批量误签：'
        : '检测到待签到活动，请按对应方式完成：';
      return `${heading}\n${formatSignActions(pending)}`;
    }
    const selected = automatic[0]!;
    const result = await this.execute(identity, selected);
    const remaining = pending.filter((sign) => sign.activity.activityId !== selected.activity.activityId);
    return remaining.length === 0
      ? result.message
      : `${result.message}\n\n其他待处理签到：\n${formatSignActions(remaining)}`;
  }

  async execute(identity: OwnerIdentity, detected: DetectedSign, signCode?: string, jobId?: number): Promise<ChaoxingSignExecutionResult> {
    const requestAudit = {
      activityId: detected.activity.activityId,
      courseId: detected.course.courseId,
      classId: detected.course.classId,
      signType: detected.signType,
      hasSignCode: Boolean(signCode),
      discoveredOfficialStatus: detected.attendance.status,
    };
    try {
      assertSupported(detected, signCode);
      let auth = await this.authService.getAuthenticatedSession(identity);
      if (detected.info.ifNeedVCode) throw new ChaoxingCaptchaRequiredError('本次签到要求验证码，自动签到已暂停。');
      if (detected.info.openCheckFaceFlag) throw new ChaoxingUserError('本次签到要求人脸验证，请在学习通 App 中完成。');

      const before = await this.client.getAttendInfo(auth.cookieJar, detected.activity.activityId);
      auth = await this.authService.persistCookies(auth, before.cookieJar);
      if (before.attendance.status !== 0) {
        if (!isAttendedStatus(before.attendance.status)) {
          throw new ChaoxingUserError(`当前官方状态为“${attendanceStatusLabel(before.attendance.status)}”，无法提交签到。`);
        }
        const result: ChaoxingSignExecutionResult = {
          status: 'already_signed',
          officialStatus: before.attendance.status,
          message: `${detected.course.name} / ${detected.activity.title}：此前已经签到（官方状态：${attendanceStatusLabel(before.attendance.status)}）。`,
        };
        await this.store.addSignRecord({
          ownerKey: identity.ownerKey, jobId: jobId ?? null, activityId: detected.activity.activityId,
          courseId: detected.course.courseId, classId: detected.course.classId, signType: detected.signType,
          status: result.status, requestJson: JSON.stringify(requestAudit),
          responseText: JSON.stringify({ officialStatus: result.officialStatus, submitted: false }), createdAt: this.now(),
        });
        return result;
      }

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
      auth = await this.authService.persistCookies(auth, submitted.cookieJar);
      const verified = await this.verifySubmittedAttendance(auth, detected.activity.activityId);
      const result: ChaoxingSignExecutionResult = {
        status: submitted.status,
        officialStatus: verified,
        message: submitted.status === 'already_signed'
          ? `${detected.course.name} / ${detected.activity.title}：此前已经签到（官方状态：${attendanceStatusLabel(verified)}）。`
          : `${detected.course.name} / ${detected.activity.title}：签到成功（官方状态：${attendanceStatusLabel(verified)}）。`,
      };
      await this.store.addSignRecord({
        ownerKey: identity.ownerKey, jobId: jobId ?? null, activityId: detected.activity.activityId,
        courseId: detected.course.courseId, classId: detected.course.classId, signType: detected.signType,
        status: result.status, requestJson: JSON.stringify(requestAudit),
        responseText: JSON.stringify({ submitResponse: submitted.responseText, officialStatus: verified }), createdAt: this.now(),
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.store.addSignRecord({
        ownerKey: identity.ownerKey, jobId: jobId ?? null, activityId: detected.activity.activityId,
        courseId: detected.course.courseId, classId: detected.course.classId, signType: detected.signType,
        status: error instanceof ChaoxingCaptchaRequiredError ? 'waiting_input' : 'failed',
        requestJson: JSON.stringify(requestAudit),
        responseText: JSON.stringify({
          message,
          errorCode: error instanceof ChaoxingProtocolError ? error.code : null,
        }),
        createdAt: this.now(),
      });
      throw error;
    }
  }

  async resolveDetectedSign(identity: OwnerIdentity, activityId: string, courseQuery?: string): Promise<DetectedSign> {
    const signs = filterPendingSigns(await this.scanOpenSigns(identity, courseQuery));
    if (activityId) {
      const matched = signs.find((sign) => sign.activity.activityId === activityId);
      if (!matched) throw new ChaoxingUserError(`没有找到待签到活动 ${activityId}。`);
      return matched;
    }
    if (signs.length === 0) throw new ChaoxingUserError('当前没有检测到待签到。');
    if (signs.length > 1) throw new ChaoxingUserError(`检测到多个待签到，请指定活动 ID：\n${formatDetectedSigns(signs)}`);
    return signs[0]!;
  }

  private async verifySubmittedAttendance(
    auth: Awaited<ReturnType<ChaoxingAuthService['getAuthenticatedSession']>>,
    activityId: string,
  ): Promise<number> {
    let current = auth;
    let status = 0;
    for (let attempt = 0; attempt < SIGN_VERIFICATION_ATTEMPTS; attempt += 1) {
      const checked = await this.client.getAttendInfo(current.cookieJar, activityId);
      current = await this.authService.persistCookies(current, checked.cookieJar);
      status = checked.attendance.status;
      if (isAttendedStatus(status)) return status;
      if (status !== 0) break;
      if (attempt + 1 < SIGN_VERIFICATION_ATTEMPTS) await delay(this.config.requestIntervalMs);
    }
    throw new ChaoxingProtocolError(
      'sign_verification_failed',
      `学习通提交接口已响应，但官方状态复查为“${attendanceStatusLabel(status)}”，本次不报告成功。`,
    );
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
  return signs.filter((sign) => sign.attendance.status === 0);
}

export function isAutomaticallyExecutable(sign: DetectedSign): boolean {
  return sign.signType === 'normal' && !sign.info.ifNeedVCode && !sign.info.openCheckFaceFlag;
}

export function formatDetectedSigns(signs: DetectedSign[]): string {
  if (signs.length === 0) return '当前没有进行中的签到。';
  return signs.map((sign) => {
    const type = signTypeLabel(sign.signType);
    const status = attendanceStatusLabel(sign.attendance.status);
    const end = sign.info.endAt ? `，截止 ${formatDate(sign.info.endAt)}` : '';
    return `- ${sign.course.name} / ${sign.activity.title || '签到'}（${type}，${status}，活动ID ${sign.activity.activityId}${end}）`;
  }).join('\n');
}

export function formatSignActions(signs: DetectedSign[]): string {
  return signs.map((sign) => {
    const prefix = `- ${sign.course.name} / ${sign.activity.title || '签到'}（${signTypeLabel(sign.signType)}，活动ID ${sign.activity.activityId}）`;
    return `${prefix}\n  ${signActionInstruction(sign)}`;
  }).join('\n');
}

export function signActionInstruction(sign: DetectedSign): string {
  if (sign.info.ifNeedVCode) return '本次要求验证码，请在学习通 App 中完成。';
  if (sign.info.openCheckFaceFlag) return '本次要求人脸验证，请在学习通 App 中完成。';
  if (sign.signType === 'normal') return `发送：学习通签到 ${sign.activity.activityId}`;
  if (sign.signType === 'gesture') return `发送：学习通签到 ${sign.activity.activityId} <手势顺序>`;
  if (sign.signType === 'code') return `发送：学习通签到 ${sign.activity.activityId} <签到码>`;
  if (sign.signType === 'qrcode') return '请在学习通 App 扫描教师展示的动态二维码。';
  if (sign.signType === 'location') return '请在学习通 App 授权定位后完成。';
  if (sign.signType === 'photo') return '请在学习通 App 拍照完成。';
  return '请在学习通 App 查看活动要求。';
}

export function attendanceStatusLabel(status: number): string {
  if (status === 0) return '待签到';
  if (status === 1) return '已签到';
  if (status === 2) return '教师代签';
  if (status === 4) return '请假';
  if (status === 5) return '缺勤';
  if (status === 9) return '迟到';
  if (status === 10) return '早退';
  if (status === 11) return '已过期';
  return `未知状态 ${status}`;
}

function isAttendedStatus(status: number): boolean {
  return status === 1 || status === 2 || status === 9;
}

function assertSupported(sign: DetectedSign, signCode?: string): asserts sign is DetectedSign & { signType: SupportedSignType } {
  if (sign.signType === 'gesture' || sign.signType === 'code') {
    if (!signCode?.trim()) throw new ChaoxingUserError(`${signTypeLabel(sign.signType)}需要提供签到码或手势顺序。`);
    return;
  }
  if (sign.signType === 'normal') return;
  throw new ChaoxingProtocolError('unsupported_sign_type', `${signTypeLabel(sign.signType)}需要在学习通 App 中完成。`);
}

export function signTypeLabel(type: ChaoxingSignType): string {
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

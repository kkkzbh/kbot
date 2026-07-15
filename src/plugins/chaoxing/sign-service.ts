import type { ChaoxingAuthService } from './auth-service.js';
import type { ChaoxingCatalogService } from './catalog-service.js';
import type {
  ChaoxingAttendance,
  ChaoxingClient,
  ChaoxingQrSignContext,
  ChaoxingSignInfo,
  ChaoxingSignSubmissionFields,
} from './client.js';
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

export interface ChaoxingBrowserLocation {
  latitude: number;
  longitude: number;
  accuracy: number;
}

export type ChaoxingSignInput =
  | { kind: 'normal' }
  | { kind: 'code'; signCode: string }
  | { kind: 'qrcode'; enc: string; code?: string; location?: ChaoxingBrowserLocation }
  | { kind: 'location'; location: ChaoxingBrowserLocation }
  | { kind: 'photo'; bytes: Uint8Array; contentType: string; filename: string };

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
    return this.scanCourses(identity, courses);
  }

  async resolveDetectedSignForAction(
    identity: OwnerIdentity,
    reference: { activityId: string; courseId: string; classId: string },
  ): Promise<DetectedSign> {
    const courses = await this.catalogService.listCourses(identity);
    const course = courses.find((candidate) => candidate.courseId === reference.courseId && candidate.classId === reference.classId);
    if (!course) throw new ChaoxingUserError('签到链接对应的课程已不在当前账号中。');
    let auth = await this.authService.getAuthenticatedSession(identity);
    const activityResult = await this.client.getActivities(auth.cookieJar, course);
    auth = await this.authService.persistCookies(auth, activityResult.cookieJar);
    const activity = activityResult.activities.find((candidate) => (
      candidate.activityId === reference.activityId && candidate.status === 1
    ));
    if (!activity) throw new ChaoxingUserError('这个签到已经完成、结束或不再可用。');
    const infoResult = await this.client.getSignInfo(auth.cookieJar, activity.activityId);
    auth = await this.authService.persistCookies(auth, infoResult.cookieJar);
    const attendanceResult = await this.client.getAttendInfo(auth.cookieJar, activity.activityId);
    await this.authService.persistCookies(auth, attendanceResult.cookieJar);
    if (attendanceResult.attendance.status !== 0) throw new ChaoxingUserError('这个签到已经完成、结束或不再可用。');
    return {
      course,
      activity,
      info: infoResult.info,
      signType: classifySignType(infoResult.info),
      attendance: attendanceResult.attendance,
    };
  }

  private async scanCourses(identity: OwnerIdentity, courses: ChaoxingCourse[]): Promise<DetectedSign[]> {
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

  async execute(identity: OwnerIdentity, detected: DetectedSign, input: ChaoxingSignInput, jobId?: number): Promise<ChaoxingSignExecutionResult> {
    const requestAudit = {
      activityId: detected.activity.activityId,
      courseId: detected.course.courseId,
      classId: detected.course.classId,
      signType: detected.signType,
      inputKind: input.kind,
      hasSignCode: input.kind === 'code',
      hasQrPayload: input.kind === 'qrcode',
      hasLocation: input.kind === 'location' || (input.kind === 'qrcode' && Boolean(input.location)),
      hasPhoto: input.kind === 'photo',
      discoveredOfficialStatus: detected.attendance.status,
    };
    try {
      assertInputMatchesSign(detected, input);
      let auth = await this.authService.getAuthenticatedSession(identity);
      if (detected.info.ifNeedVCode) throw new ChaoxingCaptchaRequiredError('本次签到要求验证码，交互签到已暂停。');
      if (detected.info.openCheckFaceFlag) throw new ChaoxingUserError('本次签到要求人脸验证，当前交互链接无法代替本人验证。');

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

      const prepared = await this.client.prepareSign(auth.cookieJar, {
        activity: detected.activity,
        profile: auth.profile,
        qr: qrContext(input),
      });
      auth = await this.authService.persistCookies(auth, prepared.cookieJar);
      if (input.kind === 'code') {
        const checked = await this.client.checkSignCode(auth.cookieJar, detected.activity.activityId, input.signCode);
        auth = await this.authService.persistCookies(auth, checked.cookieJar);
        if (!checked.valid) throw new ChaoxingUserError('签到码或手势顺序不正确。');
      }
      if (!auth.profile.deviceCode) throw new Error('chaoxing profile is missing device code.');
      const deviceCode = auth.profile.deviceCode;
      const fieldsResult = await this.buildSubmissionFields(auth, detected, input);
      auth = fieldsResult.auth;
      let submitted: Awaited<ReturnType<ChaoxingClient['submitSign']>>;
      let verified: number;
      try {
        submitted = await this.client.submitSign(auth.cookieJar, {
          activity: detected.activity,
          profile: auth.profile,
          deviceCode,
          fields: fieldsResult.fields,
        });
        auth = await this.authService.persistCookies(auth, submitted.cookieJar);
        verified = await this.verifySubmittedAttendance(auth, detected.activity.activityId);
      } catch (error) {
        if (error instanceof ChaoxingProtocolError || error instanceof ChaoxingUserError) throw error;
        throw new ChaoxingProtocolError(
          'sign_outcome_unknown',
          '签到请求已开始提交，但网络响应不完整。为避免重复提交，请查看官方状态后重新发起。',
        );
      }
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

  private async buildSubmissionFields(
    auth: Awaited<ReturnType<ChaoxingAuthService['getAuthenticatedSession']>>,
    detected: DetectedSign,
    input: ChaoxingSignInput,
  ): Promise<{
    auth: Awaited<ReturnType<ChaoxingAuthService['getAuthenticatedSession']>>;
    fields: ChaoxingSignSubmissionFields;
  }> {
    if (input.kind === 'normal') return { auth, fields: {} };
    if (input.kind === 'code') return { auth, fields: { signCode: input.signCode } };
    if (input.kind === 'qrcode') {
      return {
        auth,
        fields: {
          enc: input.enc,
          ...(input.location ? locationSubmissionFields(detected.info, input.location) : {}),
        },
      };
    }
    if (input.kind === 'location') return { auth, fields: locationSubmissionFields(detected.info, input.location) };
    const uploaded = await this.client.uploadSignPhoto(auth.cookieJar, {
      puid: auth.profile.puid,
      bytes: input.bytes,
      contentType: input.contentType,
      filename: input.filename,
    });
    const persisted = await this.authService.persistCookies(auth, uploaded.cookieJar);
    return { auth: persisted, fields: { objectId: uploaded.objectId } };
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

function assertInputMatchesSign(sign: DetectedSign, input: ChaoxingSignInput): void {
  if (sign.signType === 'unknown') throw new ChaoxingProtocolError('unsupported_sign_type', '当前签到类型无法识别。');
  if (sign.signType === 'normal' && input.kind === 'normal') return;
  if ((sign.signType === 'gesture' || sign.signType === 'code') && input.kind === 'code' && input.signCode.trim()) return;
  if (sign.signType === 'qrcode' && input.kind === 'qrcode' && input.enc.trim()) {
    if (sign.info.ifRefreshQr && !input.code?.trim()) throw new ChaoxingUserError('动态二维码缺少 Code，请重新扫描教师当前展示的二维码。');
    if (hasTargetLocation(sign.info) && !input.location) throw new ChaoxingUserError('本次二维码签到同时要求现场定位。');
    return;
  }
  if (sign.signType === 'location' && input.kind === 'location') return;
  if (sign.signType === 'photo' && input.kind === 'photo' && input.bytes.byteLength > 0) return;
  throw new ChaoxingUserError(`${signTypeLabel(sign.signType)}提交数据与活动要求不一致。`);
}

function qrContext(input: ChaoxingSignInput): ChaoxingQrSignContext | undefined {
  return input.kind === 'qrcode' ? { enc: input.enc, code: input.code } : undefined;
}

function locationSubmissionFields(info: ChaoxingSignInfo, location: ChaoxingBrowserLocation): ChaoxingSignSubmissionFields {
  assertFiniteLocation(location);
  if (!hasTargetLocation(info)) throw new ChaoxingProtocolError('sign_location_fields', '位置签到缺少教师设置的目标位置。');
  const distance = distanceMeters(location.latitude, location.longitude, info.locationLatitude, info.locationLongitude);
  if (distance > info.locationRangeMeters) {
    throw new ChaoxingUserError(`当前位置距离签到点约 ${Math.round(distance)} 米，超出 ${Math.round(info.locationRangeMeters)} 米范围。`);
  }
  return { address: info.locationText, latitude: location.latitude, longitude: location.longitude };
}

function hasTargetLocation(info: ChaoxingSignInfo): info is ChaoxingSignInfo & {
  locationLatitude: number;
  locationLongitude: number;
  locationRangeMeters: number;
} {
  return Boolean(
    info.locationText
    && Number.isFinite(info.locationLatitude)
    && Number.isFinite(info.locationLongitude)
    && Number.isFinite(info.locationRangeMeters)
    && (info.locationRangeMeters ?? 0) > 0,
  );
}

function assertFiniteLocation(location: ChaoxingBrowserLocation): void {
  if (!Number.isFinite(location.latitude) || location.latitude < -90 || location.latitude > 90
    || !Number.isFinite(location.longitude) || location.longitude < -180 || location.longitude > 180
    || !Number.isFinite(location.accuracy) || location.accuracy < 0) {
    throw new ChaoxingUserError('浏览器返回的定位数据无效。');
  }
}

function distanceMeters(latitude1: number, longitude1: number, latitude2: number, longitude2: number): number {
  const radians = (degrees: number): number => degrees * Math.PI / 180;
  const deltaLatitude = radians(latitude2 - latitude1);
  const deltaLongitude = radians(longitude2 - longitude1);
  const a = Math.sin(deltaLatitude / 2) ** 2
    + Math.cos(radians(latitude1)) * Math.cos(radians(latitude2)) * Math.sin(deltaLongitude / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
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

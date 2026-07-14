import { createCipheriv, createHash } from 'node:crypto';
import { load } from 'cheerio';
import { ChaoxingCookieJar } from './cookie-jar.js';
import {
  ChaoxingAuthError,
  ChaoxingCaptchaRequiredError,
  ChaoxingProtocolError,
  type ChaoxingActivity,
  type ChaoxingChapter,
  type ChaoxingCourse,
  type ChaoxingDeadlineItem,
  type ChaoxingProfile,
  type SerializedChaoxingCookieJar,
} from './types.js';

const LOGIN_AES_KEY = Buffer.from('u2oh6Vu^HWe4_AES', 'utf8');
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/136.0 Safari/537.36';
const PASSPORT_ORIGIN = 'https://passport2.chaoxing.com';
const MOOC1_ORIGIN = 'https://mooc1.chaoxing.com';
const COURSE_API_ORIGIN = 'https://mooc1-api.chaoxing.com';
const MOBILE_LEARN_ORIGIN = 'https://mobilelearn.chaoxing.com';

type RequestOptions = Omit<RequestInit, 'headers'> & { headers?: Record<string, string> };

export interface ChaoxingClientOptions {
  fetchImpl?: typeof fetch;
  userAgent?: string;
  requestTimeoutMs?: number;
}

export interface ChaoxingQrSession {
  uuid: string;
  enc: string;
  imageDataUrl: string;
  cookieJar: SerializedChaoxingCookieJar;
}

export type ChaoxingQrPollResult =
  | { kind: 'pending'; cookieJar: SerializedChaoxingCookieJar }
  | { kind: 'scanned'; cookieJar: SerializedChaoxingCookieJar }
  | { kind: 'expired'; cookieJar: SerializedChaoxingCookieJar }
  | { kind: 'confirmed'; cookieJar: SerializedChaoxingCookieJar; profile: ChaoxingProfile };

export interface ChaoxingLoginResult {
  cookieJar: SerializedChaoxingCookieJar;
  profile: ChaoxingProfile;
}

export interface ChaoxingCourseContext {
  enc: string;
  openc: string;
  t: string;
  workEnc: string;
  examEnc: string;
  chapterUrl: string | null;
  workUrl: string | null;
  examUrl: string | null;
  pageUrl: string;
}

export interface ChaoxingTaskCardDefaults {
  fid: string;
  userid: string;
  cpi: string;
  knowledgeid: string;
  ktoken: string;
  reportUrl: string;
  reportTimeInterval: number;
  courseEngineInfo: string;
}

export interface ChaoxingTaskAttachment {
  type: string;
  job: boolean;
  jobid: string;
  objectId: string;
  otherInfo: string;
  startTime: string;
  endTime: string;
  refererUrl: string;
  jtoken: string;
  enc: string;
  isPassed: boolean;
  playTime: number;
  attDuration: number;
  attDurationEnc: string;
  videoFaceCaptureEnc: string;
  property: Record<string, unknown>;
}

export interface ChaoxingTaskCard {
  defaults: ChaoxingTaskCardDefaults;
  attachments: ChaoxingTaskAttachment[];
  notOpen: boolean;
  faceRequired: boolean;
}

export interface ChaoxingVideoStatus {
  duration: number;
  dtoken: string;
}

export interface ChaoxingSignInfo {
  otherId: string;
  ifNeedVCode: boolean;
  openCheckFaceFlag: boolean;
  startAt: number | null;
  endAt: number | null;
  raw: Record<string, unknown>;
}

export class ChaoxingClient {
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;
  private readonly requestTimeoutMs: number;

  constructor(options: ChaoxingClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  async createQrSession(): Promise<ChaoxingQrSession> {
    const jar = new ChaoxingCookieJar();
    const page = await this.request(`${PASSPORT_ORIGIN}/mlogin?newversion=true`, { jar });
    assertOk(page, 'qr_login_page');
    const $ = load(page.text);
    const uuid = String($('#uuid').attr('value') ?? '').trim();
    const enc = String($('#enc').attr('value') ?? '').trim();
    if (!/^[a-f0-9]{32}$/iu.test(uuid) || !/^[a-f0-9]{32}$/iu.test(enc)) {
      throw new ChaoxingProtocolError('qr_fields_missing', '学习通扫码登录页没有返回二维码参数。', excerpt(page.text));
    }
    const image = await this.request(`${PASSPORT_ORIGIN}/createqr?uuid=${encodeURIComponent(uuid)}&fid=-1`, { jar, responseType: 'bytes' });
    assertOk(image, 'qr_image');
    const contentType = image.response.headers.get('content-type') || 'image/png';
    return {
      uuid,
      enc,
      imageDataUrl: `data:${contentType};base64,${Buffer.from(image.bytes).toString('base64')}`,
      cookieJar: jar.serialize(),
    };
  }

  async getQrImage(serialized: SerializedChaoxingCookieJar, uuid: string): Promise<{ imageDataUrl: string; cookieJar: SerializedChaoxingCookieJar }> {
    const jar = ChaoxingCookieJar.from(serialized);
    const image = await this.request(`${PASSPORT_ORIGIN}/createqr?uuid=${encodeURIComponent(uuid)}&fid=-1`, { jar, responseType: 'bytes' });
    assertOk(image, 'qr_image');
    const contentType = image.response.headers.get('content-type') || 'image/png';
    return {
      imageDataUrl: `data:${contentType};base64,${Buffer.from(image.bytes).toString('base64')}`,
      cookieJar: jar.serialize(),
    };
  }

  async pollQrLogin(serialized: SerializedChaoxingCookieJar, uuid: string, enc: string): Promise<ChaoxingQrPollResult> {
    const jar = ChaoxingCookieJar.from(serialized);
    const body = new URLSearchParams({ uuid, enc }).toString();
    const response = await this.request(`${PASSPORT_ORIGIN}/getauthstatus`, {
      jar,
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'x-requested-with': 'XMLHttpRequest',
        origin: PASSPORT_ORIGIN,
        referer: `${PASSPORT_ORIGIN}/mlogin?newversion=true`,
      },
      body,
    });
    assertOk(response, 'qr_poll');
    const payload = parseJsonObject(response.text, 'qr_poll_json');
    if (payload.status === true) {
      const profile = await this.getProfile(jar);
      await this.requireValidSession(jar);
      return { kind: 'confirmed', cookieJar: jar.serialize(), profile };
    }
    const type = numberValue(payload.type);
    if (type === 4) return { kind: 'scanned', cookieJar: jar.serialize() };
    if (type === 6) return { kind: 'expired', cookieJar: jar.serialize() };
    return { kind: 'pending', cookieJar: jar.serialize() };
  }

  async login(username: string, password: string): Promise<ChaoxingLoginResult> {
    const jar = new ChaoxingCookieJar();
    const body = new URLSearchParams({
      fid: '-1',
      uname: encryptChaoxingLoginField(username),
      password: encryptChaoxingLoginField(password),
      refer: 'https%3A%2F%2Fi.chaoxing.com',
      t: 'true',
      forbidotherlogin: '0',
      validate: '',
      doubleFactorLogin: '0',
      independentId: '0',
      independentNameId: '0',
    }).toString();
    const response = await this.request(`${PASSPORT_ORIGIN}/fanyalogin`, {
      jar,
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        origin: PASSPORT_ORIGIN,
        referer: `${PASSPORT_ORIGIN}/mlogin?newversion=true`,
      },
      body,
    });
    assertOk(response, 'password_login');
    const payload = parseJsonObject(response.text, 'password_login_json');
    if (payload.status !== true) {
      const message = stringValue(payload.msg2) || stringValue(payload.msg) || '学习通登录失败，请检查账号和密码。';
      throw new ChaoxingAuthError(message);
    }
    const profile = await this.getProfile(jar, username);
    await this.requireValidSession(jar);
    return { cookieJar: jar.serialize(), profile };
  }

  async validate(serialized: SerializedChaoxingCookieJar): Promise<boolean> {
    try {
      await this.requireValidSession(ChaoxingCookieJar.from(serialized));
      return true;
    } catch (error) {
      if (error instanceof ChaoxingAuthError) return false;
      throw error;
    }
  }

  async getProfile(jar: ChaoxingCookieJar, username?: string): Promise<ChaoxingProfile> {
    const response = await this.request('https://sso.chaoxing.com/apis/login/userLogin4Uname.do', { jar });
    assertOk(response, 'profile');
    const payload = parseJsonObject(response.text, 'profile_json');
    const msg = objectValue(payload.msg);
    const uid = idValue(msg.uid);
    const puid = idValue(msg.puid || msg.uid);
    const fid = idValue(msg.fid);
    const name = stringValue(msg.name);
    if (!uid || !puid || !fid || !name) {
      throw new ChaoxingProtocolError('profile_fields_missing', '学习通用户信息缺少必要字段。', excerpt(response.text));
    }
    const units = Array.isArray(msg.unitConfigInfos) ? msg.unitConfigInfos : [];
    const firstUnit = objectValue(units[0]);
    return {
      uid,
      puid,
      fid,
      name,
      schoolName: stringValue(msg.schoolname) || stringValue(firstUnit.schoolname) || '未知学校',
      username: username || stringValue(msg.uname) || undefined,
    };
  }

  async getCourses(serialized: SerializedChaoxingCookieJar): Promise<{ courses: ChaoxingCourse[]; cookieJar: SerializedChaoxingCookieJar }> {
    const jar = ChaoxingCookieJar.from(serialized);
    const courses = await this.getCoursesWithJar(jar);
    return { courses, cookieJar: jar.serialize() };
  }

  async getChapters(serialized: SerializedChaoxingCookieJar, course: ChaoxingCourse): Promise<{ chapters: ReturnType<typeof parseChapters>; cookieJar: SerializedChaoxingCookieJar }> {
    const jar = ChaoxingCookieJar.from(serialized);
    const context = await this.enterCourse(jar, course);
    if (!context.chapterUrl) return { chapters: [], cookieJar: jar.serialize() };
    const url = courseNavigationUrl(context.chapterUrl, course, context, 'chapter');
    const response = await this.request(url.href, { jar, headers: { referer: context.pageUrl } });
    assertAuthenticatedPage(response, 'chapters');
    return { chapters: parseChapters(response.text, course), cookieJar: jar.serialize() };
  }

  async getAcademicTasks(
    serialized: SerializedChaoxingCookieJar,
    course: ChaoxingCourse,
    kinds: readonly ('work' | 'exam')[],
  ): Promise<{ items: ChaoxingDeadlineItem[]; cookieJar: SerializedChaoxingCookieJar }> {
    const jar = ChaoxingCookieJar.from(serialized);
    const context = await this.enterCourse(jar, course);
    const items: ChaoxingDeadlineItem[] = [];
    if (kinds.includes('work') && context.workUrl) {
      if (!context.workEnc) throw new ChaoxingProtocolError('course_work_enc_missing', '课程页面缺少作业访问参数。');
      const url = courseNavigationUrl(context.workUrl, course, context, 'work');
      const response = await this.request(url.href, { jar, headers: { referer: context.pageUrl } });
      assertAuthenticatedPage(response, 'assignments');
      items.push(...parseAssignments(response.text, course));
    }
    if (kinds.includes('exam') && context.examUrl) {
      if (!context.examEnc || !context.openc) throw new ChaoxingProtocolError('course_exam_fields_missing', '课程页面缺少考试访问参数。');
      const url = courseNavigationUrl(context.examUrl, course, context, 'exam');
      const response = await this.request(url.href, { jar, headers: { referer: context.pageUrl } });
      assertAuthenticatedPage(response, 'exams');
      items.push(...parseExams(response.text, course));
    }
    return { items, cookieJar: jar.serialize() };
  }

  async getActivities(serialized: SerializedChaoxingCookieJar, course: ChaoxingCourse): Promise<{ activities: ChaoxingActivity[]; cookieJar: SerializedChaoxingCookieJar }> {
    const jar = ChaoxingCookieJar.from(serialized);
    const url = new URL('/v2/apis/active/student/activelist', MOBILE_LEARN_ORIGIN);
    url.searchParams.set('fid', '0');
    url.searchParams.set('showNotStartedActive', '0');
    url.searchParams.set('courseId', course.courseId);
    url.searchParams.set('classId', course.classId);
    const response = await this.request(url.href, { jar, headers: { referer: `${MOBILE_LEARN_ORIGIN}/widget/pcpick/stu/index?courseId=${course.courseId}&jclassId=${course.classId}` } });
    assertOk(response, 'activities');
    return { activities: parseActivities(response.text, course), cookieJar: jar.serialize() };
  }

  async getChapterTasks(
    serialized: SerializedChaoxingCookieJar,
    course: ChaoxingCourse,
    chapter: Pick<ChaoxingChapter, 'chapterId' | 'enc'>,
  ): Promise<{ card: ChaoxingTaskCard; cookieJar: SerializedChaoxingCookieJar }> {
    const jar = ChaoxingCookieJar.from(serialized);
    const studyUrl = new URL('/mycourse/studentstudy', MOOC1_ORIGIN);
    for (const [key, value] of Object.entries({
      chapterId: chapter.chapterId,
      courseId: course.courseId,
      clazzid: course.classId,
      cpi: course.cpi,
      enc: chapter.enc,
      mooc2: '1',
      hidetype: '0',
    })) studyUrl.searchParams.set(key, value);
    const studyPage = await this.request(studyUrl.href, { jar });
    assertAuthenticatedPage(studyPage, 'chapter_page');
    if (/章节未开放/u.test(studyPage.text)) {
      return { card: { defaults: emptyTaskDefaults(), attachments: [], notOpen: true, faceRequired: false }, cookieJar: jar.serialize() };
    }
    const cardCount = parseTaskCardCount(studyPage.text);
    if (cardCount === 0) {
      return { card: { defaults: emptyTaskDefaults(), attachments: [], notOpen: false, faceRequired: false }, cookieJar: jar.serialize() };
    }
    const cards: ChaoxingTaskCard[] = [];
    for (let cardIndex = 0; cardIndex < cardCount; cardIndex += 1) {
      const url = new URL('/mooc-ans/knowledge/cards', MOOC1_ORIGIN);
      url.searchParams.set('clazzid', course.classId);
      url.searchParams.set('courseid', course.courseId);
      url.searchParams.set('knowledgeid', chapter.chapterId);
      url.searchParams.set('num', String(cardIndex));
      url.searchParams.set('ut', 's');
      url.searchParams.set('cpi', course.cpi);
      url.searchParams.set('v', '2025-0424-1038-3');
      url.searchParams.set('mooc2', '1');
      url.searchParams.set('isMicroCourse', 'false');
      url.searchParams.set('editorPreview', '0');
      const response = await this.request(url.href, { jar, headers: { referer: studyPage.url } });
      assertAuthenticatedPage(response, 'task_card');
      if (/请输入(?:图片中的)?验证码/u.test(response.text)) throw new ChaoxingCaptchaRequiredError(undefined, excerpt(response.text));
      cards.push(parseTaskCard(response.text, response.url));
    }
    return { card: mergeTaskCards(cards), cookieJar: jar.serialize() };
  }

  async getVideoStatus(
    serialized: SerializedChaoxingCookieJar,
    args: { objectId: string; fid: string; refererUrl: string },
  ): Promise<{ status: ChaoxingVideoStatus; cookieJar: SerializedChaoxingCookieJar }> {
    const jar = ChaoxingCookieJar.from(serialized);
    const url = new URL(`/ananas/status/${encodeURIComponent(args.objectId)}`, COURSE_API_ORIGIN);
    url.searchParams.set('k', args.fid);
    url.searchParams.set('flag', 'normal');
    url.searchParams.set('_dc', String(Date.now()));
    const response = await this.request(url.href, {
      jar,
      headers: { referer: args.refererUrl, 'x-requested-with': 'XMLHttpRequest' },
    });
    assertOk(response, 'video_status');
    const payload = parseJsonObject(response.text, 'video_status_json');
    const duration = numberValue(payload.duration);
    const dtoken = stringValue(payload.dtoken);
    if (!duration || !dtoken) throw new ChaoxingProtocolError('video_status_fields', '视频状态缺少时长或令牌。', excerpt(response.text));
    return { status: { duration, dtoken }, cookieJar: jar.serialize() };
  }

  async reportVideoProgress(serialized: SerializedChaoxingCookieJar, args: {
    reportUrl: string; dtoken: string; classId: string; userId: string;
    jobId: string; objectId: string; otherInfo: string; playingTime: number; duration: number; rt: number;
    startTime: string; endTime: string; refererUrl: string;
    courseEngineInfo: string;
    attDuration?: number; attDurationEnc?: string; videoFaceCaptureEnc?: string;
  }): Promise<{ passed: boolean; cookieJar: SerializedChaoxingCookieJar; response: Record<string, unknown> }> {
    const jar = ChaoxingCookieJar.from(serialized);
    const url = new URL(`${args.reportUrl.replace(/\/$/u, '')}/${encodeURIComponent(args.dtoken)}`);
    const playingTime = Math.min(Math.floor(args.playingTime), Math.floor(args.duration));
    const duration = Math.floor(args.duration);
    const clipTime = `${args.startTime || '0'}_${args.endTime || duration}`;
    const enc = videoProgressEnc(args.classId, args.userId, args.jobId, args.objectId, playingTime, duration, clipTime);
    const [otherInfo, ...otherInfoFields] = args.otherInfo.split('&');
    const params: Record<string, string> = {
      clazzId: args.classId, playingTime: String(playingTime), duration: String(duration), clipTime, objectId: args.objectId,
      otherInfo: otherInfo ?? '', jobid: args.jobId, userid: args.userId,
      isdrag: playingTime >= duration ? '4' : '0', view: 'pc', enc, rt: String(args.rt),
      videoFaceCaptureEnc: args.videoFaceCaptureEnc ?? '', dtype: 'Video', _t: String(Date.now()),
      attDuration: String(args.attDuration ?? 0), attDurationEnc: args.attDurationEnc ?? '', courseEngineInfo: args.courseEngineInfo,
    };
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    for (const field of otherInfoFields) {
      const separator = field.indexOf('=');
      if (separator <= 0) throw new ChaoxingProtocolError('video_other_info', '视频任务的 otherInfo 参数格式无效。');
      url.searchParams.set(field.slice(0, separator), field.slice(separator + 1));
    }
    const response = await this.request(url.href, {
      jar,
      headers: { 'content-type': 'application/json', referer: args.refererUrl, 'x-requested-with': 'XMLHttpRequest' },
    });
    assertOk(response, 'video_progress');
    if (/请输入(?:图片中的)?验证码/u.test(response.text)) throw new ChaoxingCaptchaRequiredError(undefined, excerpt(response.text));
    const payload = parseJsonObject(response.text, 'video_progress_json');
    return { passed: payload.isPassed === true, cookieJar: jar.serialize(), response: payload };
  }

  async completeDocument(serialized: SerializedChaoxingCookieJar, args: { origin: string; course: ChaoxingCourse; chapterId: string; jobId: string; jtoken: string; refererUrl: string }): Promise<SerializedChaoxingCookieJar> {
    const jar = ChaoxingCookieJar.from(serialized);
    const url = new URL('/ananas/job/document', args.origin);
    setJobParams(url, args);
    const response = await this.request(url.href, { jar, headers: { referer: args.refererUrl } });
    assertOk(response, 'document_job');
    return jar.serialize();
  }

  async completeRead(serialized: SerializedChaoxingCookieJar, args: { origin: string; course: ChaoxingCourse; chapterId: string; jobId: string; jtoken: string; refererUrl: string }): Promise<SerializedChaoxingCookieJar> {
    const jar = ChaoxingCookieJar.from(serialized);
    const url = new URL('/ananas/job/readv2', args.origin);
    setJobParams(url, args);
    const response = await this.request(url.href, { jar, headers: { referer: args.refererUrl } });
    assertOk(response, 'read_job');
    const payload = parseJsonObject(response.text, 'read_job_json');
    if (payload.status !== true && numberValue(payload.status) !== 1) {
      throw new ChaoxingProtocolError('read_job_rejected', stringValue(payload.msg) || '阅读任务没有完成。', excerpt(response.text));
    }
    return jar.serialize();
  }

  async getSignInfo(serialized: SerializedChaoxingCookieJar, activityId: string): Promise<{ info: ChaoxingSignInfo; cookieJar: SerializedChaoxingCookieJar }> {
    const jar = ChaoxingCookieJar.from(serialized);
    const url = new URL('/v2/apis/active/getPPTActiveInfo', MOBILE_LEARN_ORIGIN);
    url.searchParams.set('activeId', activityId);
    const response = await this.request(url.href, { jar });
    assertOk(response, 'sign_info');
    const payload = parseJsonObject(response.text, 'sign_info_json');
    const data = objectValue(payload.data);
    return {
      info: {
        otherId: idValue(data.otherId),
        ifNeedVCode: numberValue(data.ifNeedVCode) === 1,
        openCheckFaceFlag: numberValue(data.openCheckFaceFlag) === 1,
        startAt: timestampValue(data.starttime),
        endAt: timestampValue(data.endTime),
        raw: data,
      },
      cookieJar: jar.serialize(),
    };
  }

  async prepareSign(serialized: SerializedChaoxingCookieJar, args: { activity: ChaoxingActivity; profile: ChaoxingProfile }): Promise<{ pageText: string; cookieJar: SerializedChaoxingCookieJar }> {
    const jar = ChaoxingCookieJar.from(serialized);
    const url = new URL('/newsign/preSign', MOBILE_LEARN_ORIGIN);
    for (const [key, value] of Object.entries({ general: '1', sys: '1', ls: '1', appType: '15', isTeacherViewOpen: '0',
      courseId: args.activity.courseId, classId: args.activity.classId, activePrimaryId: args.activity.activityId, uid: args.profile.puid })) {
      url.searchParams.set(key, value);
    }
    const response = await this.request(url.href, {
      jar,
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: new URLSearchParams({ ext: args.activity.ext }).toString(),
    });
    assertAuthenticatedPage(response, 'sign_preflight');
    if (response.text.includes('校验失败，未查询到活动数据')) throw new ChaoxingProtocolError('sign_no_permission', '当前账号不在签到班级中。');
    if (response.text.includes('下次早点哦') || response.text.includes('签到已结束')) throw new ChaoxingProtocolError('sign_expired', '签到已经结束。');
    await this.performSignAnalysis(jar, args.activity.activityId);
    return { pageText: response.text, cookieJar: jar.serialize() };
  }

  async checkSignCode(serialized: SerializedChaoxingCookieJar, activityId: string, signCode: string): Promise<{ valid: boolean; cookieJar: SerializedChaoxingCookieJar }> {
    const jar = ChaoxingCookieJar.from(serialized);
    const url = new URL('/widget/sign/pcStuSignController/checkSignCode', MOBILE_LEARN_ORIGIN);
    url.searchParams.set('activeId', activityId);
    url.searchParams.set('signCode', signCode);
    const response = await this.request(url.href, { jar });
    assertOk(response, 'sign_code_check');
    const payload = parseJsonObject(response.text, 'sign_code_json');
    return { valid: numberValue(payload.result) === 1, cookieJar: jar.serialize() };
  }

  async submitSign(serialized: SerializedChaoxingCookieJar, args: {
    activity: ChaoxingActivity; profile: ChaoxingProfile; deviceCode: string; signCode?: string;
  }): Promise<{ status: 'succeeded' | 'already_signed'; responseText: string; cookieJar: SerializedChaoxingCookieJar }> {
    const jar = ChaoxingCookieJar.from(serialized);
    const url = new URL('/pptSign/stuSignajax', MOBILE_LEARN_ORIGIN);
    const params: Record<string, string> = {
      clientip: '', appType: '15', ifTiJiao: '1', vpProbability: '-1', vpStrategy: '', latitude: '', longitude: '',
      activeId: args.activity.activityId, uid: args.profile.puid, name: args.profile.name, fid: args.profile.fid,
      courseId: args.activity.courseId, classId: args.activity.classId, deviceCode: args.deviceCode,
    };
    if (args.signCode) params.signCode = args.signCode;
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const response = await this.request(url.href, { jar });
    assertOk(response, 'sign_submit');
    const text = response.text.trim();
    if (text === 'success') return { status: 'succeeded', responseText: text, cookieJar: jar.serialize() };
    if (text === '您已签到过了') return { status: 'already_signed', responseText: text, cookieJar: jar.serialize() };
    if (text === 'validate') throw new ChaoxingCaptchaRequiredError(undefined, text);
    if (text === 'success2') throw new ChaoxingProtocolError('sign_expired', '迟到或签到已经结束。', text);
    throw new ChaoxingProtocolError('sign_rejected', `签到失败：${text || '学习通没有返回原因。'}`, text);
  }

  async requestText(serialized: SerializedChaoxingCookieJar, url: string, options: RequestOptions = {}): Promise<{ text: string; url: string; cookieJar: SerializedChaoxingCookieJar }> {
    const jar = ChaoxingCookieJar.from(serialized);
    const response = await this.request(url, { ...options, jar });
    assertAuthenticatedPage(response, 'request_text');
    return { text: response.text, url: response.url, cookieJar: jar.serialize() };
  }

  async postForm(serialized: SerializedChaoxingCookieJar, url: string, form: Record<string, string>, referer?: string): Promise<{ text: string; cookieJar: SerializedChaoxingCookieJar }> {
    const jar = ChaoxingCookieJar.from(serialized);
    const response = await this.request(url, {
      jar,
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'x-requested-with': 'XMLHttpRequest',
        ...(referer ? { referer } : {}),
      },
      body: new URLSearchParams(form).toString(),
    });
    assertAuthenticatedPage(response, 'post_form');
    return { text: response.text, cookieJar: jar.serialize() };
  }

  private async getCoursesWithJar(jar: ChaoxingCookieJar): Promise<ChaoxingCourse[]> {
    const response = await this.request(`${COURSE_API_ORIGIN}/mycourse/backclazzdata?view=json&rss=1`, { jar });
    assertOk(response, 'course_list');
    const payload = parseJsonObject(response.text, 'course_list_json');
    if (numberValue(payload.result) !== 1 || !Array.isArray(payload.channelList)) throw new ChaoxingAuthError();
    return parseCourseList(payload);
  }

  private async requireValidSession(jar: ChaoxingCookieJar): Promise<void> {
    const courses = await this.getCoursesWithJar(jar);
    if (!Array.isArray(courses)) throw new ChaoxingAuthError();
  }

  private async enterCourse(jar: ChaoxingCookieJar, course: Pick<ChaoxingCourse, 'courseId' | 'classId' | 'cpi'>): Promise<ChaoxingCourseContext> {
    const url = new URL('/visit/stucoursemiddle', MOOC1_ORIGIN);
    url.searchParams.set('courseid', course.courseId);
    url.searchParams.set('clazzid', course.classId);
    url.searchParams.set('cpi', course.cpi);
    url.searchParams.set('ismooc2', '1');
    url.searchParams.set('v', '2');
    const response = await this.request(url.href, { jar });
    assertAuthenticatedPage(response, 'course_entry');
    const finalUrl = new URL(response.url);
    const $ = load(response.text);
    const field = (selector: string): string => String($(selector).first().attr('value') ?? '').trim();
    const route = (module: string): string | null => {
      const anchor = $(`li[dataname="${module}"] a[data-url]`).first();
      const value = String(anchor.attr('data-url') ?? '').trim();
      return value ? new URL(value, response.url).href : null;
    };
    const enc = finalUrl.searchParams.get('enc') || field('#enc');
    const t = finalUrl.searchParams.get('t') || field('#t');
    if (!enc) throw new ChaoxingProtocolError('course_enc_missing', '课程页面缺少 enc 参数。', excerpt(response.text));
    if (!t) throw new ChaoxingProtocolError('course_t_missing', '课程页面缺少 t 参数。', excerpt(response.text));
    return {
      enc,
      openc: field('#openc'),
      t,
      workEnc: field('#workEnc'),
      examEnc: field('#examEnc'),
      chapterUrl: route('zj'),
      workUrl: route('zy'),
      examUrl: route('ks'),
      pageUrl: response.url,
    };
  }

  private async performSignAnalysis(jar: ChaoxingCookieJar, activityId: string): Promise<void> {
    const analysis = new URL('/pptSign/analysis', MOBILE_LEARN_ORIGIN);
    analysis.searchParams.set('vs', '1');
    analysis.searchParams.set('DB_STRATEGY', 'RANDOM');
    analysis.searchParams.set('aid', activityId);
    const first = await this.request(analysis.href, { jar });
    assertOk(first, 'sign_analysis');
    const code = first.text.match(/code='\+'([a-f0-9]+)'/iu)?.[1];
    if (!code) throw new ChaoxingProtocolError('sign_analysis_code', '签到校验没有返回分析码。', excerpt(first.text));
    const second = new URL('/pptSign/analysis2', MOBILE_LEARN_ORIGIN);
    second.searchParams.set('DB_STRATEGY', 'RANDOM');
    second.searchParams.set('code', code);
    const completed = await this.request(second.href, { jar });
    assertOk(completed, 'sign_analysis_complete');
  }

  private async request(input: string, options: RequestOptions & { jar: ChaoxingCookieJar; responseType?: 'text' | 'bytes' }): Promise<InternalResponse> {
    const { jar, responseType, ...requestInit } = options;
    let url = new URL(input);
    let method = String(options.method ?? 'GET').toUpperCase();
    let body = options.body;
    for (let redirectCount = 0; redirectCount <= 8; redirectCount += 1) {
      assertChaoxingUrl(url);
      const headers = new Headers(options.headers);
      headers.set('user-agent', this.userAgent);
      headers.set('accept', headers.get('accept') || '*/*');
      const cookie = jar.cookieHeader(url);
      if (cookie) headers.set('cookie', cookie);
      const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
      const signal = requestInit.signal ? AbortSignal.any([requestInit.signal, timeoutSignal]) : timeoutSignal;
      const response = await this.fetchImpl(url, { ...requestInit, method, body, headers, redirect: 'manual', signal });
      jar.absorb(response, url);
      if (![301, 302, 303, 307, 308].includes(response.status)) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        return { response, url: url.href, text: responseType === 'bytes' ? '' : Buffer.from(bytes).toString('utf8'), bytes };
      }
      const location = response.headers.get('location');
      if (!location) throw new ChaoxingProtocolError('redirect_location_missing', '学习通返回了无目标的重定向。');
      url = new URL(location, url);
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
      }
    }
    throw new ChaoxingProtocolError('too_many_redirects', '学习通请求重定向次数过多。');
  }
}

interface InternalResponse {
  response: Response;
  url: string;
  text: string;
  bytes: Uint8Array;
}

export function encryptChaoxingLoginField(value: string): string {
  const cipher = createCipheriv('aes-128-cbc', LOGIN_AES_KEY, LOGIN_AES_KEY);
  return Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]).toString('base64');
}

export function parseCourseList(payload: Record<string, unknown>): ChaoxingCourse[] {
  const channels = Array.isArray(payload.channelList) ? payload.channelList : [];
  const courses: ChaoxingCourse[] = [];
  for (const rawChannel of channels) {
    const channel = objectValue(rawChannel);
    const content = objectValue(channel.content);
    const courseEnvelope = objectValue(content.course);
    const data = Array.isArray(courseEnvelope.data) ? courseEnvelope.data : [];
    for (const rawCourse of data) {
      const course = objectValue(rawCourse);
      const courseId = idValue(course.id);
      const classId = idValue(content.id);
      const cpi = idValue(channel.cpi || content.cpi);
      const name = stringValue(course.name);
      if (!courseId || !classId || !cpi || !name) continue;
      courses.push({
        courseId, classId, cpi, name, className: stringValue(content.name), teacherName: stringValue(course.teacherfactor),
        schoolName: stringValue(course.schools), imageUrl: stringValue(course.imageurl), state: numberValue(content.state),
        isRetired: numberValue(content.isretire),
      });
    }
  }
  return courses;
}

export function parseChapters(html: string, course: Pick<ChaoxingCourse, 'courseId' | 'classId'>) {
  const $ = load(html);
  const chapterEnc = html.match(/\bvar\s+enc\s*=\s*["']([^"']+)["']/u)?.[1] ?? '';
  const chapters: Array<{ chapterId: string; courseId: string; classId: string; title: string; position: number; enc: string; courseOrigin: string }> = [];
  $('.chapter_item[onclick*="toOld"]').each((position, element) => {
    const root = $(element);
    const onclick = String(root.attr('onclick') ?? '');
    const args = onclick.match(/toOld\(\s*["']([^"']+)["']\s*,\s*["']([^"']+)["']\s*,\s*["']([^"']+)["']/u);
    if (!args) throw new ChaoxingProtocolError('chapter_route_fields', `第 ${position + 1} 个章节缺少导航参数。`);
    const [, routeCourseId, chapterId, routeClassId] = args;
    if (routeCourseId !== course.courseId || routeClassId !== course.classId) {
      throw new ChaoxingProtocolError('chapter_route_mismatch', `章节 ${chapterId} 的课程标识不一致。`);
    }
    const title = normalizeSpace(root.attr('title') || root.find('.clicktitle').first().text());
    if (!chapterId || !title) throw new ChaoxingProtocolError('chapter_fields_missing', `第 ${position + 1} 个章节缺少 ID 或标题。`);
    chapters.push({ chapterId, courseId: course.courseId, classId: course.classId, title, position, enc: chapterEnc, courseOrigin: MOOC1_ORIGIN });
  });
  if (chapters.length === 0 && !/暂无章节|还没有章节/u.test($.root().text())) {
    throw new ChaoxingProtocolError('chapter_dom_changed', '课程页面没有识别到章节目录。', excerpt(html));
  }
  if (chapters.length > 0 && !chapterEnc) throw new ChaoxingProtocolError('chapter_enc_missing', '章节目录缺少访问参数。', excerpt(html));
  return uniqueBy(chapters, (chapter) => chapter.chapterId);
}

export function parseAssignments(html: string, course: Pick<ChaoxingCourse, 'courseId' | 'classId' | 'name'>): ChaoxingDeadlineItem[] {
  return parseCourseListPage(html, course, 'work');
}

export function parseExams(html: string, course: Pick<ChaoxingCourse, 'courseId' | 'classId' | 'name'>): ChaoxingDeadlineItem[] {
  return parseCourseListPage(html, course, 'exam');
}

export function parseActivities(text: string, course: Pick<ChaoxingCourse, 'courseId' | 'classId' | 'name'>): ChaoxingActivity[] {
  const payload = parseJsonObject(text, 'activity_list_json');
  if (numberValue(payload.result) !== 1) throw new ChaoxingProtocolError('activity_list_rejected', stringValue(payload.errorMsg) || '课堂活动接口拒绝了请求。', excerpt(text));
  const data = objectValue(payload.data);
  const activeList = Array.isArray(data.activeList) ? data.activeList : [];
  return activeList.map((raw) => {
    const activity = objectValue(raw);
    return {
      activityId: idValue(activity.id), courseId: course.courseId, classId: course.classId,
      title: stringValue(activity.nameOne) || stringValue(activity.name), activityType: numberValue(activity.activeType || activity.type),
      signTypeCode: idValue(activity.otherId), status: numberValue(activity.status), userStatus: nullableNumber(activity.userStatus),
      startAt: timestampValue(activity.startTime), endAt: timestampValue(activity.endTime), ext: JSON.stringify(objectValue(data.ext)), raw: activity,
    } satisfies ChaoxingActivity;
  }).filter((activity) => activity.activityId && (activity.activityType === 2 || activity.activityType === 74));
}

export function parseTaskCard(html: string, refererUrl = ''): ChaoxingTaskCard {
  if (/章节未开放/u.test(html)) return { defaults: emptyTaskDefaults(), attachments: [], notOpen: true, faceRequired: false };
  const faceRequired = /人脸识别/u.test(html) && /title\s*:\s*["']人脸识别/u.test(html);
  const source = extractAssignedJson(html, 'mArg');
  const root = parseJsonObject(source, 'task_card_json');
  const rawDefaults = objectValue(root.defaults);
  const rawAttachments = Array.isArray(root.attachments) ? root.attachments : [];
  const defaults: ChaoxingTaskCardDefaults = {
    fid: idValue(rawDefaults.fid || rawDefaults.cFid), userid: idValue(rawDefaults.userid), cpi: idValue(rawDefaults.cpi),
    knowledgeid: idValue(rawDefaults.knowledgeid), ktoken: stringValue(rawDefaults.ktoken), reportUrl: stringValue(rawDefaults.reportUrl),
    reportTimeInterval: Math.max(1, numberValue(rawDefaults.reportTimeInterval) || 60),
    courseEngineInfo: stringValue(rawDefaults.courseEngineInfo) || 'false',
  };
  if (!defaults.fid || !defaults.userid || !defaults.cpi || !defaults.knowledgeid) {
    throw new ChaoxingProtocolError('task_defaults_missing', '章节任务卡缺少默认参数。', excerpt(html));
  }
  const attachments = rawAttachments.map((raw) => {
    const attachment = objectValue(raw);
    const type = stringValue(attachment.type).toLowerCase();
    return {
      type, job: attachment.job === true, jobid: idValue(attachment.jobid),
      objectId: idValue(attachment.objectId || objectValue(attachment.property).objectid),
      otherInfo: stringValue(attachment.otherInfo), startTime: stringValue(attachment.startTime), endTime: stringValue(attachment.endTime),
      refererUrl: type === 'video' && refererUrl ? new URL('/ananas/modules/video/index.html', refererUrl).href : refererUrl,
      jtoken: stringValue(attachment.jtoken), enc: stringValue(attachment.enc),
      isPassed: attachment.isPassed === true, playTime: Math.floor(numberValue(attachment.playTime) / 1000), attDuration: numberValue(attachment.attDuration),
      attDurationEnc: stringValue(attachment.attDurationEnc), videoFaceCaptureEnc: stringValue(attachment.videoFaceCaptureEnc),
      property: objectValue(attachment.property),
    } satisfies ChaoxingTaskAttachment;
  });
  return { defaults, attachments, notOpen: false, faceRequired };
}

export function parseTaskCardCount(html: string): number {
  const $ = load(html);
  const raw = String($('#cardcount').first().attr('value') ?? '').trim()
    || html.match(/\bcardcount\s*=\s*["']?(\d+)/u)?.[1]
    || '';
  const count = Number(raw);
  if (!Number.isInteger(count) || count < 0 || count > 200) {
    throw new ChaoxingProtocolError('task_card_count_missing', '章节页面缺少有效的任务卡数量。', excerpt(html));
  }
  return count;
}

function mergeTaskCards(cards: ChaoxingTaskCard[]): ChaoxingTaskCard {
  const first = cards[0];
  if (!first) throw new ChaoxingProtocolError('task_cards_empty', '章节任务卡列表为空。');
  for (const [index, card] of cards.entries()) {
    if (card.defaults.fid !== first.defaults.fid
      || card.defaults.userid !== first.defaults.userid
      || card.defaults.cpi !== first.defaults.cpi
      || card.defaults.knowledgeid !== first.defaults.knowledgeid) {
      throw new ChaoxingProtocolError('task_card_defaults_mismatch', `第 ${index + 1} 张任务卡的身份参数不一致。`);
    }
  }
  return {
    defaults: first.defaults,
    attachments: cards.flatMap((card) => card.attachments),
    notOpen: cards.some((card) => card.notOpen),
    faceRequired: cards.some((card) => card.faceRequired),
  };
}

export function videoProgressEnc(classId: string, userId: string, jobId: string, objectId: string, playingTime: number, duration: number, clipTime = `0_${duration}`): string {
  return createHash('md5').update(`[${classId}][${userId}][${jobId}][${objectId}][${playingTime * 1000}][d_yHJ!$pdA~5][${duration * 1000}][${clipTime}]`).digest('hex');
}

function parseCourseListPage(html: string, course: Pick<ChaoxingCourse, 'courseId' | 'classId' | 'name'>, kind: 'work' | 'exam'): ChaoxingDeadlineItem[] {
  const $ = load(html);
  const blocks = $('.task-list li');
  const bodyText = normalizeSpace($.root().text());
  if (blocks.length === 0) {
    const emptyPattern = kind === 'work' ? /暂无(?:作业|数据)|还没有作业/u : /暂无考试|还没有考试/u;
    if (emptyPattern.test(bodyText)) return [];
    throw new ChaoxingProtocolError(`${kind}_dom_changed`, `学习通${kind === 'work' ? '作业' : '考试'}列表结构无法识别。`, excerpt(html));
  }
  const items: ChaoxingDeadlineItem[] = [];
  blocks.each((index, element) => {
    const block = $(element);
    const text = normalizeLines(block.text());
    const title = normalizeSpace(block.find('.overHidden2, .tit, .title, .workName, h3, h4, a').first().text()) || text.split('\n')[0] || '';
    if (!title || /^(全部|已完成|未完成|筛选)$/u.test(title)) return;
    const route = String(block.attr('data') || block.find('[data]').first().attr('data') || block.attr('onclick') || block.find('[onclick]').first().attr('onclick') || '');
    const remoteId = extractRemoteId(route, kind) || `${kind}-${shortHash(`${course.courseId}:${course.classId}:${title}`)}`;
    const dates = [...text.matchAll(/\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(?:\s+\d{1,2}:\d{2})?/gu)].map((match) => parseDate(match[0]));
    const statusPattern = kind === 'work'
      ? /(未交|待批阅|已完成|已批阅|已交|已过期|已截止)/u
      : /(未开始|进行中|已结束|已完成|未交|待批阅|已过期|已截止)/u;
    const status = text.match(statusPattern)?.[1] || '';
    const score = text.match(/(\d+(?:\.\d+)?)\s*分(?!钟)/u)?.[1] ?? null;
    items.push({
      recordKey: `${kind}:${course.courseId}:${course.classId}:${remoteId}`, kind, courseId: course.courseId, classId: course.classId,
      remoteId, courseName: course.name, title, status, startAt: kind === 'exam' ? dates[0] ?? null : null,
      endAt: dates.at(-1) ?? null, score, source: { index, text, route },
    });
  });
  return items;
}

function extractRemoteId(href: string, kind: 'work' | 'exam'): string {
  if (!href) return '';
  const decoded = href.replaceAll('&amp;', '&');
  if (kind === 'exam') {
    const examId = decoded.match(/viewExamAnswer\(\s*["']([^"']+)["']/u)?.[1];
    if (examId) return examId;
  }
  try {
    const url = new URL(decoded, 'https://mooc1.chaoxing.com');
    const keys = kind === 'work' ? ['workId', 'workid', 'workAnswerId', 'id'] : ['examId', 'testId', 'id'];
    for (const key of keys) {
      const value = url.searchParams.get(key);
      if (value) return value;
    }
  } catch {
    return '';
  }
  return '';
}

function courseNavigationUrl(
  route: string,
  course: Pick<ChaoxingCourse, 'courseId' | 'classId' | 'cpi'>,
  context: Pick<ChaoxingCourseContext, 'enc' | 'openc' | 't' | 'workEnc' | 'examEnc'>,
  module: 'chapter' | 'work' | 'exam',
): URL {
  const url = new URL(route);
  if (module === 'work') {
    url.searchParams.set('courseId', course.courseId);
    url.searchParams.set('classId', course.classId);
  } else {
    url.searchParams.set('courseid', course.courseId);
    url.searchParams.set('clazzid', course.classId);
  }
  url.searchParams.set('cpi', course.cpi);
  url.searchParams.set('ut', 's');
  url.searchParams.set('t', context.t);
  url.searchParams.set('stuenc', context.enc);
  if (module === 'work') url.searchParams.set('enc', context.workEnc);
  if (module === 'exam') {
    url.searchParams.set('enc', context.examEnc);
    url.searchParams.set('openc', context.openc);
  }
  return url;
}

function setJobParams(url: URL, args: { course: ChaoxingCourse; chapterId: string; jobId: string; jtoken: string }): void {
  url.searchParams.set('jobid', args.jobId);
  url.searchParams.set('knowledgeid', args.chapterId);
  url.searchParams.set('courseid', args.course.courseId);
  url.searchParams.set('clazzid', args.course.classId);
  url.searchParams.set('jtoken', args.jtoken);
  url.searchParams.set('_dc', String(Date.now()));
}

function assertOk(response: InternalResponse, operation: string): void {
  if (new URL(response.url).pathname === '/antispiderShowVerify.ac'
    || /操作异常[^。]*请输入图片中的验证码|请输入(?:图片中的)?验证码/u.test(response.text)) {
    throw new ChaoxingCaptchaRequiredError(undefined, excerpt(response.text));
  }
  if (response.response.status >= 200 && response.response.status < 300) return;
  throw new ChaoxingProtocolError(`${operation}_http_${response.response.status}`, `学习通请求失败（${response.response.status}）。`, excerpt(response.text));
}

function assertAuthenticatedPage(response: InternalResponse, operation: string): void {
  assertOk(response, operation);
  if (new URL(response.url).hostname === 'passport2.chaoxing.com' || /name=["']uname["']|使用学习通APP扫码登录/u.test(response.text)) {
    throw new ChaoxingAuthError();
  }
}

function assertChaoxingUrl(url: URL): void {
  if (url.protocol !== 'https:' || !(url.hostname === 'chaoxing.com' || url.hostname.endsWith('.chaoxing.com'))) {
    throw new ChaoxingProtocolError('unexpected_redirect_origin', `拒绝向非学习通域名发送登录态：${url.origin}`);
  }
}

function extractAssignedJson(html: string, variableName: string): string {
  const assignment = new RegExp(`\\b${escapeRegExp(variableName)}\\s*=\\s*\\{`, 'gu').exec(html);
  if (!assignment) throw new ChaoxingProtocolError('assigned_json_missing', `页面没有找到 ${variableName} 对象数据。`, excerpt(html));
  const start = assignment.index + assignment[0].lastIndexOf('{');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < html.length; index += 1) {
    const char = html[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return html.slice(start, index + 1);
    }
  }
  throw new ChaoxingProtocolError('assigned_json_unclosed', `${variableName} 数据没有闭合。`, excerpt(html));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function parseJsonObject(text: string, code: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('root is not object');
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new ChaoxingProtocolError(code, '学习通返回了无法解析的数据。', excerpt(text));
  }
}

function objectValue(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function idValue(value: unknown): string {
  const text = stringValue(value);
  return /^(?:\d+|[a-z0-9_-]+)$/iu.test(text) ? text : '';
}

function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function timestampValue(value: unknown): number | null {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function parseDate(value: string): number | null {
  const normalized = value.replace(/[/.]/gu, '-');
  const parsed = Date.parse(normalized.replace(' ', 'T') + (normalized.includes(' ') ? ':00+08:00' : 'T00:00:00+08:00'));
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeSpace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function normalizeLines(value: string): string {
  return value.split(/\r?\n/u).map(normalizeSpace).filter(Boolean).join('\n');
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 20);
}

function uniqueBy<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const id = key(value);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function emptyTaskDefaults(): ChaoxingTaskCardDefaults {
  return { fid: '', userid: '', cpi: '', knowledgeid: '', ktoken: '', reportUrl: '', reportTimeInterval: 60, courseEngineInfo: 'false' };
}

function excerpt(value: string, maxLength = 600): string {
  return normalizeSpace(value).slice(0, maxLength);
}

import { createCipheriv } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { rootCertificates } from 'node:tls';
import { Agent, type Dispatcher } from 'undici';
import type {
  HbuJwCourseOffering,
  HbuJwCourseOfferingMeeting,
  HbuJwCourseSelectionCourse,
  HbuJwCourseSelectionResult,
  HbuJwExamPlanEvent,
  HbuJwScheduleCourse,
  HbuJwScheduleTimeAndPlace,
  HbuJwScoreRow,
  HbuJwSubitemScoreDetailRow,
  HbuJwSubitemScoreLookParams,
  HbuJwSubitemScoreLookResult,
  HbuJwSubitemScoreTerm,
  HbuJwStudentPlanProfile,
  HbuJwThisSemesterSchedule,
  HbuJwThisTermScoreRow,
  HbuJwTrainingPlanCategory,
  HbuJwTrainingPlanCourse,
  HbuJwTrainingPlanSnapshot,
  SerializedCookieJar,
} from './types.js';

export interface HbuJwLoginResult {
  cookieJar: SerializedCookieJar;
}

export interface HbuJwClientOptions {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  webVpnBaseUrl?: string;
  webVpnTransportBaseUrl?: string;
  webVpnDispatcher?: Dispatcher;
  webVpnBroker?: HbuWebVpnBrokerOptions;
  userAgent?: string;
}

export interface HbuWebVpnBrokerOptions {
  url: string;
  token: Buffer;
  fetchImpl?: typeof fetch;
}

interface NormalizedHbuWebVpnBrokerOptions {
  url: string;
  authorization: string;
  fetchImpl: typeof fetch;
}

type RequestOptions = Omit<RequestInit, 'headers'> & {
  headers?: Record<string, string>;
};

export class HbuJwLoginError extends Error {
  readonly code: string;
  readonly diagnostic: string;
  readonly category: HbuJwLoginErrorCategory;

  constructor(message: string, options: { code: string; diagnostic: string; category: HbuJwLoginErrorCategory; cause?: unknown }) {
    super(message);
    this.name = 'HbuJwLoginError';
    this.code = options.code;
    this.diagnostic = options.diagnostic;
    this.category = options.category;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

export type HbuJwLoginErrorCategory = 'credential' | 'interaction_required' | 'upstream' | 'protocol';

export class HbuJwQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HbuJwQueryError';
  }
}

export class HbuJwHttpClient {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly baseOrigin: string;
  private readonly webVpnOrigin: string;
  private readonly webVpnTransportOrigin: string;
  private readonly webVpnDispatcher?: Dispatcher;
  private readonly webVpnBroker?: NormalizedHbuWebVpnBrokerOptions;
  private readonly userAgent: string;
  private webVpnResourceBaseUrl: string | null = null;

  constructor(options: HbuJwClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = normalizeOrigin(options.baseUrl ?? 'https://zhjw.hbu.cn');
    this.baseOrigin = new URL(this.baseUrl).origin;
    this.webVpnOrigin = normalizeOrigin(options.webVpnBaseUrl ?? 'https://v.hbu.cn');
    this.webVpnTransportOrigin = normalizeOrigin(options.webVpnTransportBaseUrl ?? 'https://v.hbu.edu.cn');
    this.webVpnDispatcher = options.webVpnDispatcher
      ?? (options.fetchImpl ? undefined : createWebVpnDispatcher());
    this.webVpnBroker = normalizeBrokerOptions(options.webVpnBroker);
    this.userAgent = options.userAgent ?? 'qqbot-hbu-jw/1.0';
  }

  usesSharedBroker(): boolean {
    return this.webVpnBroker !== undefined;
  }

  prepareSession(cookieJar: unknown): SerializedCookieJar {
    const transport = this.webVpnBroker ? 'broker' : 'direct';
    if (isCurrentCookieJar(cookieJar) && cookieJar.transport === transport) return cookieJar;
    return {
      version: 1,
      transport,
      cookies: [],
    };
  }

  async login(username: string, password: string): Promise<HbuJwLoginResult> {
    try {
      const jar = new CookieJar(this.webVpnBroker ? 'broker' : 'direct');
      if (jar.transport === 'broker') {
        const logout = await this.request('/logout', { jar });
        if (isWebVpnLoginPageHtml(logout.text)) {
          throw new HbuJwLoginError('HBU WebVPN broker 返回了登录页，当前共享会话不可用。', {
            code: 'webvpn_broker_session_missing',
            diagnostic: 'broker-backed JW logout resolved to the WebVPN login page',
            category: 'upstream',
          });
        }
      }
      let loginPage = await this.request('/login', { jar });
      if (isWebVpnLoginPageHtml(loginPage.text)) {
        if (jar.transport === 'broker') {
          throw new HbuJwLoginError('HBU WebVPN broker 返回了登录页，当前共享会话不可用。', {
            code: 'webvpn_broker_session_missing',
            diagnostic: 'broker-backed JW login resolved to the WebVPN login page',
            category: 'upstream',
          });
        }
        await this.loginWebVpn(username, password, jar, loginPage.text);
        loginPage = await this.request('/login', { jar });
        if (isWebVpnLoginPageHtml(loginPage.text)) {
          throw new HbuJwLoginError('河北大学 WebVPN 登录成功后仍未建立教务访问会话，请稍后重试。', {
            code: 'webvpn_session_missing',
            diagnostic: `webvpn resource login resolved to ${loginPage.url}`,
            category: 'upstream',
          });
        }
      }
      if (isAuthenticatedHtml(loginPage.text) && jar.transport === 'broker') {
        throw new HbuJwLoginError('共享教务会话退出后仍保留了旧账号，已拒绝继续查询。', {
          code: 'jw_shared_session_not_cleared',
          diagnostic: `login page remained authenticated url=${loginPage.url}`,
          category: 'protocol',
        });
      }
      if (isAuthenticatedHtml(loginPage.text)) {
        return { cookieJar: jar.serialize() };
      }
      if (loginPage.response.status !== 200) {
        throw new HbuJwLoginError(`教务登录入口返回 HTTP ${loginPage.response.status}，自动登录暂时无法完成。`, {
          code: 'login_page_failed',
          diagnostic: `login_page status=${loginPage.response.status}`,
          category: 'upstream',
        });
      }
      if (!isLoginPageHtml(loginPage.text)) {
        throw new HbuJwLoginError('教务登录页结构发生变化，自动登录暂时无法完成。', {
          code: 'login_page_changed',
          diagnostic: `login_page url=${loginPage.url}`,
          category: 'protocol',
        });
      }

      const loginBody = new URLSearchParams({ username, password }).toString();
      const login = await this.request('/sigin', {
        jar,
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: this.baseUrl,
          referer: `${this.baseUrl}/login`,
        },
        body: loginBody,
      });
      if (isAuthenticatedHtml(login.text)) {
        if (jar.transport === 'broker') await this.assertAuthenticatedStudent(jar, username);
        return { cookieJar: jar.serialize() };
      }

      if (isWebVpnLoginPageHtml(login.text)) {
        throw new HbuJwLoginError('河北大学 WebVPN 会话在教务登录过程中失效，请稍后重试。', {
          code: 'webvpn_session_expired',
          diagnostic: `jw login resolved to webvpn login url=${login.url}`,
          category: 'upstream',
        });
      }
      if (isLoginPageHtml(login.text)) {
        const message = extractLoginFailureMessage(login.text) ?? '教务登录失败，教务系统未返回登录态。';
        throw new HbuJwLoginError(message, {
          code: 'login_rejected',
          diagnostic: `login_submit status=${login.response.status} url=${login.url} message=${message}`,
          category: message.includes('验证码') ? 'interaction_required' : 'credential',
        });
      }
      throw new HbuJwLoginError('教务登录协议发生变化，提交账号后没有获得登录态。', {
        code: 'not_authenticated',
        diagnostic: `login_submit status=${login.response.status} url=${login.url}`,
        category: 'protocol',
      });
    } catch (error) {
      if (error instanceof HbuJwLoginError) throw error;
      throw new HbuJwLoginError('教务系统当前无法访问，自动登录未完成，请稍后重试。', {
        code: 'request_failed',
        diagnostic: describeError(error),
        category: 'upstream',
        cause: error,
      });
    }
  }

  private async assertAuthenticatedStudent(jar: CookieJar, username: string): Promise<void> {
    const pagePath = '/student/rollManagement/rollInfo/index';
    const page = await this.request(pagePath, {
      jar,
      headers: { referer: `${this.baseUrl}/index` },
    });
    if (page.response.status !== 200) {
      throw new HbuJwLoginError(`教务账号登录后无法校验学籍身份（HTTP ${page.response.status}），已拒绝继续查询。`, {
        code: 'jw_identity_page_failed',
        diagnostic: `identity_page status=${page.response.status}`,
        category: 'upstream',
      });
    }
    const studentNumber = readProfileField(page.text, ['学号']);
    if (!studentNumber) {
      throw new HbuJwLoginError('教务学籍页缺少学号，已拒绝继续查询。', {
        code: 'jw_identity_missing',
        diagnostic: 'identity page is missing student number',
        category: 'protocol',
      });
    }
    if (studentNumber !== username) {
      throw new HbuJwLoginError('教务登录身份与绑定账号不一致，已拒绝返回数据。', {
        code: 'jw_identity_mismatch',
        diagnostic: 'authenticated student number does not match submitted username',
        category: 'protocol',
      });
    }
  }

  async validate(cookieJar: SerializedCookieJar): Promise<boolean> {
    const jar = CookieJar.from(cookieJar);
    try {
      const index = await this.request('/index', { jar });
      return index.response.status === 200 && isAuthenticatedHtml(index.text);
    } catch {
      return false;
    }
  }

  async getAllPassingScores(cookieJar: SerializedCookieJar): Promise<HbuJwScoreRow[]> {
    const jar = CookieJar.from(cookieJar);
    const pagePath = '/student/integratedQuery/scoreQuery/allPassingScores/index';
    const page = await this.request(pagePath, {
      jar,
      headers: { referer: `${this.baseUrl}/index` },
    });
    if (page.response.status !== 200) {
      throw new HbuJwQueryError(`全部及格成绩页面访问失败（HTTP ${page.response.status}）。`);
    }

    const callbackPath = findAllPassingScoresCallback(page.text);
    const callback = await this.request(callbackPath, {
      jar,
      headers: {
        accept: 'application/json, text/javascript, */*; q=0.01',
        'x-requested-with': 'XMLHttpRequest',
        referer: new URL(pagePath, this.baseUrl).href,
      },
    });
    if (callback.response.status !== 200) {
      throw new HbuJwQueryError(`全部及格成绩接口访问失败（HTTP ${callback.response.status}）。`);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(callback.text);
    } catch {
      throw new HbuJwQueryError('全部及格成绩接口返回了非 JSON 内容。');
    }
    return flattenAllPassingScores(payload);
  }

  async getThisTermScores(cookieJar: SerializedCookieJar): Promise<HbuJwThisTermScoreRow[]> {
    const jar = CookieJar.from(cookieJar);
    const pagePath = '/student/integratedQuery/scoreQuery/thisTermScores/index';
    const page = await this.request(pagePath, {
      jar,
      headers: { referer: `${this.baseUrl}/index` },
    });
    if (page.response.status !== 200) {
      throw new HbuJwQueryError(`本学期成绩页面访问失败（HTTP ${page.response.status}）。`);
    }

    const dataPath = findThisTermScoresDataPath(page.text);
    const data = await this.request(dataPath, {
      jar,
      headers: {
        accept: 'application/json, text/javascript, */*; q=0.01',
        'x-requested-with': 'XMLHttpRequest',
        referer: new URL(pagePath, this.baseUrl).href,
      },
    });
    if (data.response.status !== 200) {
      throw new HbuJwQueryError(`本学期成绩接口访问失败（HTTP ${data.response.status}）。`);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(data.text);
    } catch {
      throw new HbuJwQueryError('本学期成绩接口返回了非 JSON 内容。');
    }
    return flattenThisTermScores(payload);
  }

  async getSubitemScoreTerms(cookieJar: SerializedCookieJar): Promise<HbuJwSubitemScoreTerm[]> {
    const jar = CookieJar.from(cookieJar);
    const pagePath = '/student/integratedQuery/scoreQuery/subitemScore/index';
    const page = await this.request(pagePath, {
      jar,
      headers: { referer: `${this.baseUrl}/index` },
    });
    if (page.response.status !== 200) {
      throw new HbuJwQueryError(`分项成绩页面访问失败（HTTP ${page.response.status}）。`);
    }

    return parseSubitemScoreTerms(page.text);
  }

  async getSubitemScoreDetails(cookieJar: SerializedCookieJar, params: HbuJwSubitemScoreLookParams): Promise<HbuJwSubitemScoreLookResult> {
    const jar = CookieJar.from(cookieJar);
    const pagePath = '/student/integratedQuery/scoreQuery/subitemScore/index';
    const page = await this.request(pagePath, {
      jar,
      headers: { referer: `${this.baseUrl}/index` },
    });
    if (page.response.status !== 200) {
      throw new HbuJwQueryError(`分项成绩页面访问失败（HTTP ${page.response.status}）。`);
    }

    const lookPath = findSubitemScoreLookPath(page.text);
    const look = await this.request(lookPath, {
      jar,
      method: 'POST',
      headers: {
        accept: 'application/json, text/javascript, */*; q=0.01',
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'x-requested-with': 'XMLHttpRequest',
        referer: new URL(pagePath, this.baseUrl).href,
      },
      body: buildSubitemScoreLookBody(params),
    });
    if (look.response.status !== 200) {
      throw new HbuJwQueryError(`分项成绩查询接口访问失败（HTTP ${look.response.status}）。`);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(look.text);
    } catch {
      throw new HbuJwQueryError('分项成绩查询接口返回了非 JSON 内容。');
    }
    return parseSubitemScoreLookResult(params, payload);
  }

  async getExamSchedule(cookieJar: SerializedCookieJar): Promise<HbuJwExamPlanEvent[]> {
    const jar = CookieJar.from(cookieJar);
    const pagePath = '/student/examinationManagement/examPlan/index';
    const page = await this.request(pagePath, {
      jar,
      headers: { referer: `${this.baseUrl}/index` },
    });
    if (page.response.status !== 200) {
      throw new HbuJwQueryError(`考试安排页面访问失败（HTTP ${page.response.status}）。`);
    }

    const detailPath = findExamPlanDetailPath(page.text);
    const detail = await this.request(detailPath, {
      jar,
      headers: {
        accept: 'application/json, text/javascript, */*; q=0.01',
        'x-requested-with': 'XMLHttpRequest',
        referer: new URL(pagePath, this.baseUrl).href,
      },
    });
    if (detail.response.status !== 200) {
      throw new HbuJwQueryError(`考试安排接口访问失败（HTTP ${detail.response.status}）。`);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(detail.text);
    } catch {
      throw new HbuJwQueryError('考试安排接口返回了非 JSON 内容。');
    }
    return parseExamPlanEvents(payload);
  }

  async getThisSemesterSchedule(cookieJar: SerializedCookieJar): Promise<HbuJwThisSemesterSchedule> {
    const jar = CookieJar.from(cookieJar);
    const pagePath = '/student/courseSelect/thisSemesterCurriculum/index';
    const page = await this.request(pagePath, {
      jar,
      headers: { referer: `${this.baseUrl}/index` },
    });
    if (page.response.status !== 200) {
      throw new HbuJwQueryError(`本学期课表页面访问失败（HTTP ${page.response.status}）。`);
    }

    const callbackPath = findThisSemesterScheduleCallback(page.text);
    const callback = await this.request(callbackPath, {
      jar,
      method: 'POST',
      headers: {
        accept: 'application/json, text/javascript, */*; q=0.01',
        'x-requested-with': 'XMLHttpRequest',
        referer: new URL(pagePath, this.baseUrl).href,
      },
    });
    if (callback.response.status !== 200) {
      throw new HbuJwQueryError(`本学期课表接口访问失败（HTTP ${callback.response.status}）。`);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(callback.text);
    } catch {
      throw new HbuJwQueryError('本学期课表接口返回了非 JSON 内容。');
    }
    return parseThisSemesterSchedulePayload(payload);
  }

  async getCourseSelectionResult(cookieJar: SerializedCookieJar): Promise<HbuJwCourseSelectionResult> {
    const jar = CookieJar.from(cookieJar);
    const pagePath = '/student/courseSelect/courseSelectResult/index';
    const page = await this.request(pagePath, {
      jar,
      headers: { referer: `${this.baseUrl}/index` },
    });
    if (page.response.status !== 200) {
      throw new HbuJwQueryError(`选课结果页面访问失败（HTTP ${page.response.status}）。`);
    }

    const callbackPath = findCourseSelectionResultCallback(page.text);
    const callback = await this.request(callbackPath, {
      jar,
      headers: {
        accept: 'application/json, text/javascript, */*; q=0.01',
        'x-requested-with': 'XMLHttpRequest',
        referer: new URL(pagePath, this.baseUrl).href,
      },
    });
    if (callback.response.status !== 200) {
      throw new HbuJwQueryError(`选课结果接口访问失败（HTTP ${callback.response.status}）。`);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(callback.text);
    } catch {
      throw new HbuJwQueryError('选课结果接口返回了非 JSON 内容。');
    }
    return parseCourseSelectionResultPayload(payload);
  }

  async getStudentPlanProfile(cookieJar: SerializedCookieJar): Promise<HbuJwStudentPlanProfile> {
    const jar = CookieJar.from(cookieJar);
    const pagePath = '/student/rollManagement/rollInfo/index';
    const page = await this.request(pagePath, {
      jar,
      headers: { referer: `${this.baseUrl}/index` },
    });
    if (page.response.status !== 200) {
      throw new HbuJwQueryError(`学籍信息页面访问失败（HTTP ${page.response.status}）。`);
    }

    return parseStudentPlanProfile(page.text);
  }

  async getTrainingPlanSnapshot(
    cookieJar: SerializedCookieJar,
    profile: HbuJwStudentPlanProfile,
  ): Promise<HbuJwTrainingPlanSnapshot> {
    if (!profile.planNumber || !profile.planDetailPath) {
      throw new HbuJwQueryError('当前学生没有可查询的培养方案。');
    }
    const jar = CookieJar.from(cookieJar);
    const detail = await this.request(profile.planDetailPath, {
      jar,
      headers: {
        accept: 'application/json, text/javascript, */*; q=0.01',
        'x-requested-with': 'XMLHttpRequest',
        referer: new URL('/student/rollManagement/rollInfo/index', this.baseUrl).href,
      },
    });
    if (detail.response.status !== 200) {
      throw new HbuJwQueryError(`培养方案详情接口访问失败（HTTP ${detail.response.status}）。`);
    }
    const payload = parseJsonObject(detail.text, '培养方案详情接口');
    const metadata = requireRecord(payload.jhFajhb, '培养方案元数据');
    const treeList = requireRecordArray(payload.treeList, '培养方案课程树');
    const roots = treeList.filter((node) => stringValue(node.pId) === '0');
    if (roots.length === 0) {
      throw new HbuJwQueryError('培养方案课程树没有课组根节点。');
    }

    const categoryEntries = (await Promise.all(roots.map(async (root) => {
      const rootId = requireString(root.id, '课组根节点代码');
      const path = stringValue(root.info1 ?? root.urlPath ?? root.url);
      if (!path) throw new HbuJwQueryError('培养方案课组缺少查询地址。');
      const response = await this.request(path, {
        jar,
        headers: {
          accept: 'application/json, text/javascript, */*; q=0.01',
          'x-requested-with': 'XMLHttpRequest',
          referer: new URL(profile.planDetailPath!, this.baseUrl).href,
        },
      });
      if (response.response.status !== 200) {
        throw new HbuJwQueryError(`培养方案课组接口访问失败（HTTP ${response.response.status}）。`);
      }
      const categoryPayload = parseJsonObject(response.text, '培养方案课组接口');
      const category = requireRecord(categoryPayload.kz, '培养方案课组');
      const requiredCredits = requireNonNegativeNumber(category.zsxf, '课组最低学分');
      if (requiredCredits === 0) return null;
      return {
        rootId,
        category: {
          code: requireString(requireRecord(category.id, '培养方案课组标识').kzh, '课组代码'),
          name: requireString(cleanHtmlText(category.kzm), '课组名称'),
          requiredCredits,
        } satisfies HbuJwTrainingPlanCategory,
      };
    }))).filter((value): value is { rootId: string; category: HbuJwTrainingPlanCategory } => value !== null);
    const categories = categoryEntries.map((entry) => entry.category);
    if (categories.length === 0) {
      throw new HbuJwQueryError('培养方案没有正学分课组。');
    }

    const categoryByNode = new Map(categoryEntries.map((entry) => [entry.rootId, entry.category]));
    const courses: HbuJwTrainingPlanCourse[] = [];
    const seenCourses = new Set<string>();
    for (const node of treeList) {
      const category = categoryByNode.get(stringValue(node.pId));
      if (!category) continue;
      const courseNumber = extractPlanCourseNumber(stringValue(node.info1 ?? node.urlPath ?? node.url));
      const parsedName = parsePlanCourseName(cleanHtmlText(node.name));
      if (!courseNumber || !parsedName || seenCourses.has(courseNumber)) continue;
      seenCourses.add(courseNumber);
      courses.push({
        courseNumber,
        courseName: parsedName.courseName,
        categoryCode: category.code,
        categoryName: category.name,
        attribute: parsedName.attribute,
        credits: optionalPositiveNumber(node.xf ?? node.credit ?? node.info2),
        replacementCourseNumbers: parseReplacementCourseNumbers(node),
      });
    }
    if (courses.length === 0) {
      throw new HbuJwQueryError('培养方案没有可识别的课程。');
    }

    const snapshot: HbuJwTrainingPlanSnapshot = {
      planNumber: requireString(metadata.fajhh ?? profile.planNumber, '方案号'),
      planName: requireString(metadata.famc ?? payload.title, '方案名称'),
      majorCode: requireString(metadata.zyh, '专业代码'),
      majorName: requireString(metadata.zym ?? profile.majorName, '专业名称'),
      cohortYear: parseCohortYear(metadata.nj ?? metadata.njmc ?? profile.cohortYear),
      requiredCredits: requirePositiveNumber(metadata.yqzxf, '方案最低学分'),
      categories,
      courses,
    };
    if (snapshot.planNumber !== profile.planNumber || snapshot.majorName !== profile.majorName) {
      throw new HbuJwQueryError('培养方案元数据与当前学生学籍不一致。');
    }
    return snapshot;
  }

  async getPlanCourseOfferings(cookieJar: SerializedCookieJar, planNumber: string): Promise<HbuJwCourseOffering[]> {
    const jar = CookieJar.from(cookieJar);
    const pagePath = `/student/courseSelect/planCourse/index?fajhh=${encodeURIComponent(planNumber)}`;
    const page = await this.request(pagePath, { jar, headers: { referer: `${this.baseUrl}/index` } });
    if (page.response.status !== 200) throw new HbuJwQueryError(`方案选课页面访问失败（HTTP ${page.response.status}）。`);
    const callbackPath = findUniquePath(page.text, /[^"'\s<>]*planCourse\/courseList[^"'\s<>]*/g, '方案选课');
    const currentExecutionPlanNumber = readSelectedOptionValue(page.text, 'jhxn', '方案选课当前执行计划');
    const response = await this.request(callbackPath, {
      jar,
      method: 'POST',
      headers: ajaxFormHeaders(new URL(pagePath, this.baseUrl).href),
      body: new URLSearchParams({ fajhh: planNumber, jhxn: currentExecutionPlanNumber, kcsxdm: '', kch: '', kcm: '', kclbdm: '', xqh: '', xq: '0', jc: '0' }),
    });
    if (response.response.status !== 200) throw new HbuJwQueryError(`方案选课接口访问失败（HTTP ${response.response.status}）。`);
    const payload = parseJsonObject(response.text, '方案选课接口');
    return normalizeCourseOfferings(requireRecordArray(payload.rwfalist, '方案选课班次'), 'plan');
  }

  async getFreeCourseOfferings(cookieJar: SerializedCookieJar, categoryCode = '05'): Promise<HbuJwCourseOffering[]> {
    const jar = CookieJar.from(cookieJar);
    const pagePath = '/student/courseSelect/freeCourse/index';
    const page = await this.request(pagePath, { jar, headers: { referer: `${this.baseUrl}/index` } });
    if (page.response.status !== 200) throw new HbuJwQueryError(`自由选课页面访问失败（HTTP ${page.response.status}）。`);
    const callbackPath = findUniquePath(page.text, /[^"'\s<>]*freeCourse\/courseList[^"'\s<>]*/g, '自由选课');
    const response = await this.request(callbackPath, {
      jar,
      method: 'POST',
      headers: ajaxFormHeaders(new URL(pagePath, this.baseUrl).href),
      body: new URLSearchParams({ kkxsh: '', kch: '', kcm: '', skjs: '', xq: '0', jc: '0', kclbdm: categoryCode }),
    });
    if (response.response.status !== 200) throw new HbuJwQueryError(`自由选课接口访问失败（HTTP ${response.response.status}）。`);
    const payload = parseJsonObject(response.text, '自由选课接口');
    return normalizeCourseOfferings(requireRecordArray(payload.rwRxkZlList, '自由选课班次'), 'free');
  }

  private async loginWebVpn(username: string, password: string, jar: CookieJar, html: string): Promise<void> {
    const csrf = extractInputValue(html, '_csrf');
    if (!csrf) {
      throw new HbuJwLoginError('河北大学 WebVPN 登录协议发生变化，自动登录暂时无法完成。', {
        code: 'webvpn_login_page_changed',
        diagnostic: 'webvpn login page is missing _csrf',
        category: 'protocol',
      });
    }
    const body = new URLSearchParams({
      _csrf: csrf,
      auth_type: extractInputValue(html, 'auth_type') ?? 'local',
      username,
      password: encryptWebVpnPassword(password),
      captcha: '',
      needCaptcha: extractInputValue(html, 'needCaptcha') ?? 'false',
      captcha_id: extractInputValue(html, 'captcha_id') ?? '',
      remember_cookie: 'on',
    });
    const response = await this.request(`${this.webVpnOrigin}/do-login`, {
      jar,
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        origin: this.webVpnOrigin,
        referer: `${this.webVpnOrigin}/login`,
        'x-requested-with': 'XMLHttpRequest',
      },
      body,
    });
    if (response.response.status !== 200) {
      throw new HbuJwLoginError(`河北大学 WebVPN 登录接口返回 HTTP ${response.response.status}，自动登录暂时无法完成。`, {
        code: 'webvpn_login_http_error',
        diagnostic: `webvpn do-login status=${response.response.status}`,
        category: 'upstream',
      });
    }

    const payload = parseWebVpnLoginPayload(response.text);
    if (payload.success === true) {
      const successUrl = typeof payload.url === 'string' ? payload.url : '';
      if (!successUrl) {
        throw new HbuJwLoginError('河北大学 WebVPN 登录响应缺少教务访问地址。', {
          code: 'webvpn_login_response_changed',
          diagnostic: 'webvpn success response is missing url',
          category: 'protocol',
        });
      }
      const target = this.resolveRequestUrl(successUrl);
      if (target.origin !== this.webVpnOrigin) {
        throw new HbuJwLoginError('河北大学 WebVPN 返回了非预期访问地址。', {
          code: 'webvpn_success_cross_origin',
          diagnostic: `webvpn success origin=${target.origin}`,
          category: 'protocol',
        });
      }
      return;
    }
    throw createWebVpnLoginError(payload);
  }

  private async request(url: string, options: RequestOptions & { jar: CookieJar }): Promise<{ response: Response; text: string; url: string }> {
    const {
      jar,
      headers: configuredHeaders = {},
      method: configuredMethod,
      body: configuredBody,
      ...requestOptions
    } = options;
    let currentUrl = this.resolveRequestUrl(url, jar.transport === 'broker');
    let method = String(configuredMethod ?? 'GET').toUpperCase();
    let body = configuredBody;

    for (let redirectCount = 0; redirectCount <= 8; redirectCount += 1) {
      this.assertAllowedOrigin(currentUrl, 'cross_origin_request');
      const throughBroker = jar.transport === 'broker';
      const transportUrl = throughBroker ? currentUrl : this.toTransportUrl(currentUrl);
      const headers = throughBroker
        ? { ...configuredHeaders }
        : this.createRequestHeaders(configuredHeaders, jar, currentUrl);
      if ((method === 'GET' || method === 'HEAD') && body !== undefined) body = undefined;
      const response = throughBroker
        ? await this.requestThroughBroker({
            target: transportUrl,
            method,
            headers,
            body,
            requestOptions,
            cookies: jar.serialize().cookies,
          })
        : await this.fetchImpl(transportUrl.href, {
            ...requestOptions,
            method,
            body,
            headers,
            redirect: 'manual' as const,
            ...(currentUrl.origin === this.webVpnOrigin && this.webVpnDispatcher
              ? { dispatcher: this.webVpnDispatcher }
              : {}),
          } as RequestInit & { dispatcher?: Dispatcher });
      jar.remember(readSetCookieHeaders(response.headers));
      const text = await response.text();
      const location = response.headers.get('location');
      if (!location || !isRedirectStatus(response.status)) {
        return { response, text, url: currentUrl.href };
      }
      if (redirectCount === 8) {
        throw new HbuJwLoginError('教务入口重定向次数过多，自动登录暂时无法完成。', {
          code: 'too_many_redirects',
          diagnostic: `last_url=${currentUrl.href} location=${location}`,
          category: 'upstream',
        });
      }

      const rawRedirectedUrl = this.canonicalizeWebVpnUrl(new URL(location, currentUrl));
      const redirectedUrl = currentUrl.origin === this.webVpnOrigin
        && rawRedirectedUrl.origin === this.baseOrigin
        && this.webVpnResourceBaseUrl
        ? this.resolveRequestUrl(rawRedirectedUrl.href)
        : rawRedirectedUrl;
      if (currentUrl.origin === this.baseOrigin && redirectedUrl.origin === this.webVpnOrigin) {
        this.captureWebVpnResourceBase(currentUrl, redirectedUrl);
      } else if (redirectedUrl.origin !== currentUrl.origin) {
        throw new HbuJwLoginError('教务系统返回了非预期跨域跳转。', {
          code: 'cross_origin_redirect',
          diagnostic: `redirect from=${currentUrl.origin} to=${redirectedUrl.origin}`,
          category: 'protocol',
        });
      }
      this.assertAllowedOrigin(redirectedUrl, 'cross_origin_redirect');
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
      }
      currentUrl = redirectedUrl;
    }
    throw new Error('unreachable redirect loop');
  }

  private resolveRequestUrl(value: string, throughBroker = false): URL {
    if (throughBroker) {
      const target = new URL(value, this.baseUrl);
      if (target.origin !== this.baseOrigin) {
        throw new HbuJwLoginError('HBU WebVPN broker 收到非预期教务地址。', {
          code: 'webvpn_broker_cross_origin',
          diagnostic: `broker request origin=${target.origin}`,
          category: 'protocol',
        });
      }
      return target;
    }
    if (this.webVpnResourceBaseUrl && value.startsWith(new URL(this.webVpnResourceBaseUrl).pathname)) {
      return new URL(value, this.webVpnOrigin);
    }
    const target = this.canonicalizeWebVpnUrl(new URL(value, this.baseUrl));
    if (target.origin === this.baseOrigin && this.webVpnResourceBaseUrl) {
      return new URL(`${new URL(this.webVpnResourceBaseUrl).pathname}${target.pathname}${target.search}${target.hash}`, this.webVpnOrigin);
    }
    return target;
  }

  private captureWebVpnResourceBase(source: URL, target: URL): void {
    const resourcePath = source.pathname;
    if (!target.pathname.endsWith(resourcePath)) {
      throw new HbuJwLoginError('河北大学 WebVPN 返回了无法识别的教务资源地址。', {
        code: 'webvpn_resource_path_changed',
        diagnostic: `source_path=${resourcePath} target_path=${target.pathname}`,
        category: 'protocol',
      });
    }
    const prefix = target.pathname.slice(0, -resourcePath.length);
    if (!/^\/(?:http|https)\/[a-f0-9]+$/i.test(prefix)) {
      throw new HbuJwLoginError('河北大学 WebVPN 返回了无法识别的教务资源地址。', {
        code: 'webvpn_resource_path_changed',
        diagnostic: `resource_prefix=${prefix}`,
        category: 'protocol',
      });
    }
    this.webVpnResourceBaseUrl = new URL(prefix, this.webVpnOrigin).href.replace(/\/$/, '');
  }

  private canonicalizeWebVpnUrl(target: URL): URL {
    const base = new URL(this.baseUrl);
    if (target.hostname === base.hostname && target.protocol === 'http:' && base.protocol === 'https:') {
      target.protocol = 'https:';
    }
    if (target.origin !== this.webVpnTransportOrigin) return target;
    return new URL(`${target.pathname}${target.search}${target.hash}`, this.webVpnOrigin);
  }

  private toTransportUrl(target: URL): URL {
    if (target.origin !== this.webVpnOrigin) return target;
    return new URL(`${target.pathname}${target.search}${target.hash}`, this.webVpnTransportOrigin);
  }

  private assertAllowedOrigin(target: URL, code: 'cross_origin_request' | 'cross_origin_redirect'): void {
    if (target.origin === this.baseOrigin || target.origin === this.webVpnOrigin) return;
    throw new HbuJwLoginError('教务系统返回了非预期跨域地址。', {
      code,
      diagnostic: `request origin=${target.origin}`,
      category: 'protocol',
    });
  }

  private createRequestHeaders(configured: Record<string, string>, jar: CookieJar, target: URL): Record<string, string> {
    const headers: Record<string, string> = {
      'user-agent': this.userAgent,
      ...configured,
    };
    for (const name of ['origin', 'referer'] as const) {
      const value = headers[name];
      if (!value) continue;
      const headerUrl = new URL(value);
      if (headerUrl.origin === this.baseOrigin && this.webVpnResourceBaseUrl) {
        headers[name] = name === 'origin'
          ? this.webVpnOrigin
          : new URL(`${new URL(this.webVpnResourceBaseUrl).pathname}${headerUrl.pathname}${headerUrl.search}`, this.webVpnOrigin).href;
      }
    }
    if (target.origin === this.webVpnOrigin) headers.host = new URL(this.webVpnOrigin).host;
    const cookieHeader = jar.header();
    if (cookieHeader) headers.cookie = cookieHeader;
    return headers;
  }

  private async requestThroughBroker(args: {
    target: URL;
    method: string;
    headers: Record<string, string>;
    body: BodyInit | null | undefined;
    requestOptions: Omit<RequestInit, 'headers' | 'method' | 'body'>;
    cookies: SerializedCookieJar['cookies'];
  }): Promise<Response> {
    const broker = this.webVpnBroker;
    if (!broker) throw new Error('HBU WebVPN broker transport is not configured');
    if (Object.keys(args.requestOptions).length > 0) {
      throw new HbuJwLoginError('HBU WebVPN broker 收到了不支持的请求选项。', {
        code: 'webvpn_broker_request_options',
        diagnostic: `options=${Object.keys(args.requestOptions).sort().join(',')}`,
        category: 'protocol',
      });
    }
    let bodyBase64: string | undefined;
    if (args.body !== undefined && args.body !== null) {
      if (typeof args.body !== 'string' && !Buffer.isBuffer(args.body) && !(args.body instanceof URLSearchParams)) {
        throw new HbuJwLoginError('HBU WebVPN broker 收到了不支持的请求体。', {
          code: 'webvpn_broker_request_body',
          diagnostic: `body=${Object.prototype.toString.call(args.body)}`,
          category: 'protocol',
        });
      }
      bodyBase64 = Buffer.from(args.body instanceof URLSearchParams ? args.body.toString() : args.body).toString('base64');
    }

    let brokerResponse: Response;
    try {
      brokerResponse = await broker.fetchImpl(`${broker.url}/v1/fetch`, {
        method: 'POST',
        headers: {
          authorization: broker.authorization,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          targetUrl: args.target.href,
          method: args.method,
          headers: args.headers,
          cookies: args.cookies,
          ...(bodyBase64 === undefined ? {} : { bodyBase64 }),
        }),
        signal: AbortSignal.timeout(25_000),
      });
    } catch (error) {
      throw new HbuJwLoginError('km6 的 HBU WebVPN broker 当前无法访问。', {
        code: 'webvpn_broker_unreachable',
        diagnostic: describeError(error),
        category: 'upstream',
        cause: error,
      });
    }

    const payload = await parseBrokerPayload(brokerResponse);
    if (!brokerResponse.ok || payload.ok !== true) {
      const code = typeof payload.code === 'string' ? payload.code : 'webvpn_broker_failed';
      throw new HbuJwLoginError(`km6 的 HBU WebVPN 共享会话当前不可用（broker HTTP ${brokerResponse.status}）。`, {
        code,
        diagnostic: `broker status=${brokerResponse.status} code=${code}`,
        category: 'upstream',
      });
    }
    const status = requireBrokerStatus(payload.status);
    const headers = requireBrokerResponseHeaders(payload.headers);
    for (const cookie of requireBrokerSetCookies(payload.setCookies)) headers.append('set-cookie', cookie);
    const responseBody = decodeBrokerResponseBody(payload.bodyBase64);
    return new Response(new Uint8Array(responseBody), { status, headers });
  }
}

interface WebVpnLoginPayload {
  success?: boolean;
  url?: unknown;
  error?: unknown;
  message?: unknown;
}

function normalizeOrigin(value: string): string {
  const target = new URL(value);
  return target.origin;
}

function normalizeBrokerOptions(options: HbuWebVpnBrokerOptions | undefined): NormalizedHbuWebVpnBrokerOptions | undefined {
  if (!options) return undefined;
  const target = new URL(options.url);
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || target.pathname !== '/' || target.search || target.hash) {
    throw new Error('HBU WebVPN broker URL must be an HTTP loopback origin');
  }
  if (!Buffer.isBuffer(options.token) || options.token.length !== 32) {
    throw new Error('HBU WebVPN broker token must be 32 bytes');
  }
  return {
    url: target.origin,
    authorization: `Bearer ${options.token.toString('base64url')}`,
    fetchImpl: options.fetchImpl ?? fetch,
  };
}

function isCurrentCookieJar(value: unknown): value is SerializedCookieJar {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const jar = value as Partial<SerializedCookieJar>;
  return jar.version === 1
    && (jar.transport === 'direct' || jar.transport === 'broker')
    && Array.isArray(jar.cookies);
}

async function parseBrokerPayload(response: Response): Promise<Record<string, unknown>> {
  let payload: unknown;
  try {
    payload = JSON.parse(await response.text());
  } catch {
    throw new HbuJwLoginError('HBU WebVPN broker 返回了无效响应。', {
      code: 'webvpn_broker_invalid_json',
      diagnostic: `broker status=${response.status}`,
      category: 'protocol',
    });
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new HbuJwLoginError('HBU WebVPN broker 返回了无效响应。', {
      code: 'webvpn_broker_invalid_payload',
      diagnostic: `broker status=${response.status}`,
      category: 'protocol',
    });
  }
  return payload as Record<string, unknown>;
}

function requireBrokerStatus(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 200 || Number(value) > 599) {
    throw new HbuJwLoginError('HBU WebVPN broker 返回了无效 HTTP 状态。', {
      code: 'webvpn_broker_invalid_status',
      diagnostic: `status=${String(value)}`,
      category: 'protocol',
    });
  }
  return Number(value);
}

function requireBrokerResponseHeaders(value: unknown): Headers {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HbuJwLoginError('HBU WebVPN broker 返回了无效响应头。', {
      code: 'webvpn_broker_invalid_headers',
      diagnostic: 'headers are not an object',
      category: 'protocol',
    });
  }
  const headers = new Headers();
  for (const [name, headerValue] of Object.entries(value)) {
    if (typeof headerValue !== 'string' || /[\0\r\n]/.test(headerValue) || name.toLowerCase() === 'set-cookie') {
      throw new HbuJwLoginError('HBU WebVPN broker 返回了无效响应头。', {
        code: 'webvpn_broker_invalid_headers',
        diagnostic: `header=${name}`,
        category: 'protocol',
      });
    }
    headers.set(name, headerValue);
  }
  return headers;
}

function requireBrokerSetCookies(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 128 || value.some((cookie) => typeof cookie !== 'string' || /[\0\r\n]/.test(cookie))) {
    throw new HbuJwLoginError('HBU WebVPN broker 返回了无效 Cookie。', {
      code: 'webvpn_broker_invalid_cookies',
      diagnostic: 'setCookies are invalid',
      category: 'protocol',
    });
  }
  return value as string[];
}

function decodeBrokerResponseBody(value: unknown): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new HbuJwLoginError('HBU WebVPN broker 返回了无效响应体。', {
      code: 'webvpn_broker_invalid_body',
      diagnostic: 'bodyBase64 is invalid',
      category: 'protocol',
    });
  }
  const body = Buffer.from(value, 'base64');
  if (body.toString('base64') !== value || body.length > 8 * 1024 * 1024) {
    throw new HbuJwLoginError('HBU WebVPN broker 返回了无效响应体。', {
      code: 'webvpn_broker_invalid_body',
      diagnostic: `decoded bytes=${body.length}`,
      category: 'protocol',
    });
  }
  return body;
}

function createWebVpnDispatcher(): Dispatcher {
  // The official v.hbu.cn service presents the v.hbu.edu.cn certificate and omits
  // this public intermediate. Use the certificate-matching transport host and
  // add only the missing issuer while retaining Node's normal root trust store.
  const intermediateCa = readFileSync(join(__dirname, 'assets/xcc-trust-ov-ssl-ca.pem'), 'utf8');
  return new Agent({
    connect: {
      ca: [...rootCertificates, intermediateCa],
    },
  });
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function isWebVpnLoginPageHtml(html: string): boolean {
  return /<form\b[^>]*\bid=["']form["'][^>]*>/i.test(html)
    && /(?:\/do-login|WEBVPN资源访问系统|wengine-vpn)/i.test(html)
    && /name=["']auth_type["']/i.test(html);
}

function extractInputValue(html: string, name: string): string | null {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tag = html.match(new RegExp(`<input\\b[^>]*\\bname=["']${escapedName}["'][^>]*>`, 'i'))?.[0];
  if (!tag) return null;
  const value = tag.match(/\bvalue=["']([^"']*)["']/i)?.[1];
  return value === undefined ? '' : decodeBasicHtmlEntities(value);
}

function encryptWebVpnPassword(password: string): string {
  const key = Buffer.from('wrdvpnisawesome!', 'utf8');
  const iv = Buffer.from('wrdvpnisawesome!', 'utf8');
  const sourceLength = password.length;
  const padded = sourceLength % 16 === 0
    ? password
    : password.padEnd(sourceLength + (16 - sourceLength % 16), '0');
  const cipher = createCipheriv('aes-128-cfb', key, iv);
  const encrypted = Buffer.concat([cipher.update(Buffer.from(padded, 'utf8')), cipher.final()]);
  return `${iv.toString('hex')}${encrypted.subarray(0, sourceLength).toString('hex')}`;
}

function parseWebVpnLoginPayload(text: string): WebVpnLoginPayload {
  try {
    const payload = JSON.parse(text) as unknown;
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) return payload as WebVpnLoginPayload;
  } catch {
    // Converted into the structured protocol error below.
  }
  throw new HbuJwLoginError('河北大学 WebVPN 登录响应格式发生变化，自动登录暂时无法完成。', {
    code: 'webvpn_login_response_changed',
    diagnostic: `webvpn response=${clipDiagnostic(text)}`,
    category: 'protocol',
  });
}

function createWebVpnLoginError(payload: WebVpnLoginPayload): HbuJwLoginError {
  const error = typeof payload.error === 'string' ? payload.error : 'UNKNOWN';
  const serverMessage = typeof payload.message === 'string' ? clipDiagnostic(payload.message) : '';
  const diagnostic = `webvpn error=${error}${serverMessage ? ` message=${serverMessage}` : ''}`;
  switch (error) {
    case 'INVALID_ACCOUNT':
      return new HbuJwLoginError('河北大学 WebVPN 拒绝了账号或密码，请确认统一认证密码后重新绑定。', {
        code: 'webvpn_invalid_account',
        diagnostic,
        category: 'credential',
      });
    case 'CAPTCHA_FAILED':
      return new HbuJwLoginError('河北大学 WebVPN 要求图片验证码，机器人无法自动完成本次登录，请稍后重试。', {
        code: 'webvpn_captcha_required',
        diagnostic,
        category: 'interaction_required',
      });
    case 'NEED_TWO_STEP':
      return new HbuJwLoginError('河北大学 WebVPN 要求短信二次验证，请先在 WebVPN 网页完成验证后重试。', {
        code: 'webvpn_sms_required',
        diagnostic,
        category: 'interaction_required',
      });
    case 'NEED_TWO_STEP_TOTP':
      return new HbuJwLoginError('河北大学 WebVPN 要求六位动态口令，请先在 WebVPN 网页完成验证后重试。', {
        code: 'webvpn_totp_required',
        diagnostic,
        category: 'interaction_required',
      });
    case 'NEED_CONFIRM':
      return new HbuJwLoginError('河北大学 WebVPN 检测到其他登录会话，需要人工确认是否继续登录。', {
        code: 'webvpn_login_confirmation_required',
        diagnostic,
        category: 'interaction_required',
      });
    case 'WEEK_PASSWORD_FORBID':
      return new HbuJwLoginError('河北大学 WebVPN 禁止弱密码登录，请先修改统一认证密码。', {
        code: 'webvpn_weak_password_forbidden',
        diagnostic,
        category: 'interaction_required',
      });
    case 'WECHAT_BINDING':
      return new HbuJwLoginError('河北大学 WebVPN 要求先完成企业微信账号绑定。', {
        code: 'webvpn_wechat_binding_required',
        diagnostic,
        category: 'interaction_required',
      });
    case 'IP_FORBIDDEN':
      return new HbuJwLoginError('河北大学 WebVPN 拒绝了当前服务器 IP，请联系管理员检查访问策略。', {
        code: 'webvpn_ip_forbidden',
        diagnostic,
        category: 'upstream',
      });
    case 'TOO_MANY_ATTEMPTS':
      return new HbuJwLoginError('河北大学 WebVPN 登录尝试过多，请稍后再试。', {
        code: 'webvpn_too_many_attempts',
        diagnostic,
        category: 'upstream',
      });
    default:
      return new HbuJwLoginError(serverMessage
        ? `河北大学 WebVPN 登录失败：${serverMessage}`
        : '河北大学 WebVPN 返回了无法识别的登录错误。', {
        code: 'webvpn_unknown_error',
        diagnostic,
        category: 'protocol',
      });
  }
}

function clipDiagnostic(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 300);
}

class CookieJar {
  private readonly cookies = new Map<string, string>();

  constructor(readonly transport: SerializedCookieJar['transport']) {}

  static from(serialized: SerializedCookieJar): CookieJar {
    if (!isCurrentCookieJar(serialized)) throw new Error('HBU JW cookie jar has not been migrated');
    const jar = new CookieJar(serialized.transport);
    for (const cookie of serialized.cookies ?? []) {
      if (cookie.name) jar.cookies.set(cookie.name, cookie.value);
    }
    return jar;
  }

  remember(headers: string[]): void {
    for (const raw of headers) {
      for (const header of splitSetCookieHeader(raw)) {
        const pair = header.split(';', 1)[0] ?? '';
        const index = pair.indexOf('=');
        if (index > 0) {
          this.cookies.set(pair.slice(0, index), pair.slice(index + 1));
        }
      }
    }
  }

  header(): string {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  serialize(): SerializedCookieJar {
    return {
      version: 1,
      transport: this.transport,
      cookies: [...this.cookies.entries()].map(([name, value]) => ({ name, value })),
    };
  }
}

function readSetCookieHeaders(headers: Headers): string[] {
  const extended = headers as Headers & { getSetCookie?: () => string[] };
  const setCookies = extended.getSetCookie?.();
  if (setCookies) return setCookies;
  const value = headers.get('set-cookie');
  return value ? [value] : [];
}

function splitSetCookieHeader(header: string): string[] {
  return header.split(/,(?=\s*[^;,]+=)/).map((value) => value.trim()).filter(Boolean);
}

function isAuthenticatedHtml(html: string): boolean {
  return /URP综合教务系统首页|本学期课程表|个人管理|教学资源|选课|成绩/.test(html) && !/name=["']password["']|j_spring_security_check/.test(html);
}

function isLoginPageHtml(html: string): boolean {
  return /<form\b[\s\S]*?(?:\/sigin|j_spring_security_check)[\s\S]*?<\/form>/i.test(html)
    || /name=["']password["']|name=["']j_password["']|id=["']cas["']|id=["']native["']/.test(html);
}

function extractLoginFailureMessage(html: string): string | null {
  const text = decodeBasicHtmlEntities(html)
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const patterns = [
    /账号不存在/,
    /用户名或密码错误/,
    /账号或密码错误/,
    /密码错误/,
    /验证码错误/,
    /登录失败[，,。；;：:\s]*[^。；;，,\s]{0,40}/,
  ];
  for (const pattern of patterns) {
    const matched = text.match(pattern)?.[0]?.trim();
    if (matched) return matched;
  }
  return null;
}

function decodeBasicHtmlEntities(value: string): string {
  return value
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'");
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? ` cause=${error.cause.name}:${error.cause.message}` : '';
    return `${error.name}:${error.message}${cause}`;
  }
  return String(error);
}

function findAllPassingScoresCallback(html: string): string {
  const matches = [...html.matchAll(/[^"'\s<>]*allPassingScores\/callback[^"'\s<>]*/g)]
    .map((match) => match[0].replace(/\\\//g, '/'));
  if (matches.length !== 1) {
    throw new HbuJwQueryError('全部及格成绩页面没有唯一的回调地址。');
  }
  return matches[0]!;
}

function findThisTermScoresDataPath(html: string): string {
  const matches = [...html.matchAll(/[^"'\s<>]*thisTermScores\/data[^"'\s<>]*/g)]
    .map((match) => match[0].replace(/\\\//g, '/'));
  if (matches.length !== 1) {
    throw new HbuJwQueryError('本学期成绩页面没有唯一的数据地址。');
  }
  return matches[0]!;
}

function findSubitemScoreLookPath(html: string): string {
  const matches = [...html.matchAll(/[^"'\s<>]*subitemScore\/(?:[^"'\s<>]*\/)?look[^"'\s<>]*/g)]
    .map((match) => match[0].replace(/\\\//g, '/'));
  if (matches.length !== 1) {
    throw new HbuJwQueryError('分项成绩页面没有唯一的查看地址。');
  }
  return matches[0]!;
}

function parseSubitemScoreTerms(html: string): HbuJwSubitemScoreTerm[] {
  const select = html.match(/<select\b[^>]*id=["']zxjxjhh["'][\s\S]*?<\/select>/i)?.[0];
  if (!select) {
    throw new HbuJwQueryError('分项成绩页面没有学期列表。');
  }
  const terms = [...select.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)].map((match) => {
    const attrs = match[1] ?? '';
    const value = attrs.match(/\bvalue=["']([^"']*)["']/i)?.[1]?.trim() ?? '';
    const label = decodeBasicHtmlEntities((match[2] ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    return {
      code: value,
      label,
      selected: /\bselected\b/i.test(attrs),
    };
  }).filter((term) => term.code && term.label);
  if (terms.length === 0) {
    throw new HbuJwQueryError('分项成绩页面学期列表为空。');
  }
  return terms;
}

function findExamPlanDetailPath(html: string): string {
  const matches = [...html.matchAll(/[^"'\s<>]*examinationManagement\/examPlan\/detail[^"'\s<>]*/g)]
    .map((match) => match[0].replace(/\\\//g, '/'));
  if (matches.length !== 1) {
    throw new HbuJwQueryError('考试安排页面没有唯一的数据地址。');
  }
  return matches[0]!;
}

function findThisSemesterScheduleCallback(html: string): string {
  const matches = [...html.matchAll(/[^"'\s<>]*thisSemesterCurriculum\/[^"'\s<>]*\/ajaxStudentSchedule\/curr\/callback[^"'\s<>]*/g)]
    .map((match) => match[0].replace(/\\\//g, '/'));
  if (matches.length !== 1) {
    throw new HbuJwQueryError('本学期课表页面没有唯一的回调地址。');
  }
  return matches[0]!;
}

function findCourseSelectionResultCallback(html: string): string {
  const matches = [...html.matchAll(/[^"'\s<>]*courseSelect\/thisSemesterCurriculum\/callback[^"'\s<>]*/g)]
    .map((match) => match[0].replace(/\\\//g, '/'));
  if (matches.length !== 1) {
    throw new HbuJwQueryError('选课结果页面没有唯一的回调地址。');
  }
  return matches[0]!;
}

function flattenAllPassingScores(payload: unknown): HbuJwScoreRow[] {
  if (!isRecord(payload) || !Array.isArray(payload.lnList)) {
    throw new HbuJwQueryError('全部及格成绩接口结构异常。');
  }
  const rows: HbuJwScoreRow[] = [];
  for (const year of payload.lnList) {
    if (!isRecord(year) || !Array.isArray(year.cjList)) {
      throw new HbuJwQueryError('全部及格成绩接口结构异常。');
    }
    for (const row of year.cjList) {
      if (!isRecord(row)) {
        throw new HbuJwQueryError('全部及格成绩接口结构异常。');
      }
      rows.push(row as HbuJwScoreRow);
    }
  }
  return rows;
}

function flattenThisTermScores(payload: unknown): HbuJwThisTermScoreRow[] {
  if (!Array.isArray(payload)) {
    throw new HbuJwQueryError('本学期成绩接口结构异常。');
  }
  const rows: HbuJwThisTermScoreRow[] = [];
  for (const block of payload) {
    if (!isRecord(block) || !Array.isArray(block.list)) {
      throw new HbuJwQueryError('本学期成绩接口结构异常。');
    }
    for (const row of block.list) {
      if (!isRecord(row)) {
        throw new HbuJwQueryError('本学期成绩接口结构异常。');
      }
      rows.push(row as HbuJwThisTermScoreRow);
    }
  }
  return rows;
}

export function buildSubitemScoreLookParamsFromThisTermRow(row: HbuJwThisTermScoreRow): HbuJwSubitemScoreLookParams {
  return requireSubitemScoreLookParams({
    zxjxjhh: row.id?.executiveEducationPlanNumber,
    kch: row.id?.courseNumber,
    kxh: row.coureSequenceNumber,
    kssj: row.id?.examtime,
    kcsxdm: row.coursePropertyCode,
  }, row.courseName);
}

export function buildSubitemScoreLookParamsFromScoreRow(row: HbuJwScoreRow): HbuJwSubitemScoreLookParams {
  const id = isRecord(row.id) ? row.id : {};
  return requireSubitemScoreLookParams({
    zxjxjhh: id.executiveEducationPlanNumber,
    kch: id.courseNumber,
    kxh: id.coureSequenceNumber,
    kssj: id.startTime ?? row.examTime,
    kcsxdm: row.xkcsxdm ?? row.courseAttributeCode,
  }, row.courseName);
}

function requireSubitemScoreLookParams(input: Record<keyof HbuJwSubitemScoreLookParams, unknown>, courseName: unknown): HbuJwSubitemScoreLookParams {
  const params = {
    zxjxjhh: readRequiredParam(input.zxjxjhh, 'zxjxjhh', courseName),
    kch: readRequiredParam(input.kch, 'kch', courseName),
    kxh: readRequiredParam(input.kxh, 'kxh', courseName),
    kssj: readRequiredParam(input.kssj, 'kssj', courseName),
    kcsxdm: readRequiredParam(input.kcsxdm, 'kcsxdm', courseName),
  };
  return params;
}

function readRequiredParam(value: unknown, key: string, courseName: unknown): string {
  const text = String(value ?? '').trim();
  if (!text) {
    const name = String(courseName ?? '').trim() || '未知课程';
    throw new HbuJwQueryError(`课程 ${name} 缺少分项成绩参数 ${key}。`);
  }
  return text;
}

function buildSubitemScoreLookBody(params: HbuJwSubitemScoreLookParams): string {
  return new URLSearchParams({
    zxjxjhh: params.zxjxjhh,
    kch: params.kch,
    kxh: params.kxh,
    kssj: params.kssj,
    kcsxdm: params.kcsxdm,
  }).toString();
}

function parseSubitemScoreLookResult(params: HbuJwSubitemScoreLookParams, payload: unknown): HbuJwSubitemScoreLookResult {
  if (!isRecord(payload) || !Array.isArray(payload.scoreDetailList)) {
    throw new HbuJwQueryError('分项成绩查询接口结构异常。');
  }
  for (const row of payload.scoreDetailList) {
    if (!isRecord(row)) {
      throw new HbuJwQueryError('分项成绩查询接口结构异常。');
    }
  }
  return {
    params,
    rows: payload.scoreDetailList as HbuJwSubitemScoreDetailRow[],
    message: typeof payload.msg === 'string' ? payload.msg : '',
  };
}

function parseExamPlanEvents(payload: unknown): HbuJwExamPlanEvent[] {
  if (!Array.isArray(payload)) {
    throw new HbuJwQueryError('考试安排接口结构异常。');
  }
  return payload.map((row) => {
    if (!isRecord(row) || typeof row.title !== 'string' || typeof row.start !== 'string') {
      throw new HbuJwQueryError('考试安排接口结构异常。');
    }
    return row as HbuJwExamPlanEvent;
  });
}

function parseThisSemesterSchedulePayload(payload: unknown): HbuJwThisSemesterSchedule {
  if (!isRecord(payload) || !Array.isArray(payload.dateList)) {
    throw new HbuJwQueryError('本学期课表接口结构异常。');
  }
  const totalUnits = parseRequiredNumber(payload.allUnits, '本学期课表总学分异常。');
  const courses: HbuJwScheduleCourse[] = [];
  let programPlanName = '';
  let executiveEducationPlanNumber = '';

  for (const plan of payload.dateList) {
    if (!isRecord(plan) || !Array.isArray(plan.selectCourseList)) {
      throw new HbuJwQueryError('本学期课表接口结构异常。');
    }
    const planName = String(plan.programPlanName ?? '').trim();
    if (!programPlanName && planName) {
      programPlanName = planName;
    }
    for (const row of plan.selectCourseList) {
      const course = parseScheduleCourse(row);
      if (!executiveEducationPlanNumber) {
        executiveEducationPlanNumber = course.executiveEducationPlanNumber;
      }
      courses.push(course);
    }
  }

  if (!programPlanName || !executiveEducationPlanNumber) {
    throw new HbuJwQueryError('本学期课表接口结构异常。');
  }
  return {
    executiveEducationPlanNumber,
    programPlanName,
    totalUnits,
    courses,
  };
}

function parseCourseSelectionResultPayload(payload: unknown): HbuJwCourseSelectionResult {
  if (!isRecord(payload) || !Array.isArray(payload.dateList)) {
    throw new HbuJwQueryError('选课结果接口结构异常。');
  }
  const totalUnits = parseRequiredNumber(payload.allUnits, '选课结果总学分异常。');
  const groups = payload.dateList.map((value) => {
    if (!isRecord(value) || !Array.isArray(value.selectCourseList)) {
      throw new HbuJwQueryError('选课结果接口结构异常。');
    }
    return {
      programPlanCode: String(value.programPlanCode ?? '').trim(),
      programPlanName: String(value.programPlanName ?? '').trim() || '未归入培养方案',
      totalUnits: parseRequiredNumber(value.totalUnits, '选课结果培养方案学分异常。'),
      courses: value.selectCourseList.map(parseCourseSelectionCourse),
    };
  });
  return { totalUnits, groups };
}

function parseCourseSelectionCourse(value: unknown): HbuJwCourseSelectionCourse {
  if (!isRecord(value) || !isRecord(value.id)) {
    throw new HbuJwQueryError('选课结果接口结构异常。');
  }
  return {
    courseNumber: readCourseSelectionRequiredString(value.id.coureNumber, '课程号'),
    sequenceNumber: readCourseSelectionRequiredString(value.id.coureSequenceNumber, '课序号'),
    executiveEducationPlanNumber: readCourseSelectionRequiredString(value.id.executiveEducationPlanNumber, '执行计划号'),
    courseName: readCourseSelectionRequiredString(value.courseName, '课程名'),
    unit: parseRequiredNumber(value.unit, '选课结果课程学分异常。'),
    coursePropertiesName: String(value.coursePropertiesName ?? '').trim(),
    courseCategoryName: String(value.courseCategoryName ?? '').trim(),
    examTypeName: String(value.examTypeName ?? '').trim(),
    teacherName: String(value.attendClassTeacher ?? '').replace(/\s+/g, ' ').trim(),
    studyModeName: String(value.studyModeName ?? '').trim(),
    selectCourseStatusName: String(value.selectCourseStatusName ?? '').trim(),
    restrictedCondition: String(value.restrictedCondition ?? '').trim(),
    courseSelectionTime: String(value.courseSelectionTime ?? '').trim(),
    timeAndPlaceList: parseScheduleTimeAndPlaceList(value.timeAndPlaceList, '选课结果接口结构异常。'),
  };
}

function readCourseSelectionRequiredString(value: unknown, label: string): string {
  const text = String(value ?? '').trim();
  if (!text) throw new HbuJwQueryError(`选课结果接口缺少${label}。`);
  return text;
}

function parseScheduleCourse(value: unknown): HbuJwScheduleCourse {
  if (!isRecord(value) || !isRecord(value.id)) {
    throw new HbuJwQueryError('本学期课表接口结构异常。');
  }
  const courseNumber = readRequiredString(value.id.coureNumber, '课程号');
  const sequenceNumber = readRequiredString(value.id.coureSequenceNumber, '课序号');
  const executiveEducationPlanNumber = readRequiredString(value.id.executiveEducationPlanNumber, '执行计划号');
  return {
    courseNumber,
    sequenceNumber,
    executiveEducationPlanNumber,
    courseName: readRequiredString(value.courseName, '课程名'),
    unit: parseRequiredNumber(value.unit, '课程学分异常。'),
    coursePropertiesName: String(value.coursePropertiesName ?? '').trim(),
    courseCategoryName: String(value.courseCategoryName ?? '').trim(),
    examTypeName: String(value.examTypeName ?? '').trim(),
    teacherName: String(value.attendClassTeacher ?? '').replace(/\s+/g, ' ').trim(),
    selectCourseStatusName: String(value.selectCourseStatusName ?? '').trim(),
    timeAndPlaceList: parseScheduleTimeAndPlaceList(value.timeAndPlaceList, '本学期课表接口结构异常。'),
  };
}

function parseScheduleTimeAndPlaceList(value: unknown, invalidMessage: string): HbuJwScheduleTimeAndPlace[] {
  if (value === null) return [];
  if (!Array.isArray(value)) {
    throw new HbuJwQueryError(invalidMessage);
  }
  return value.map(parseScheduleTimeAndPlace);
}

function parseScheduleTimeAndPlace(value: unknown): HbuJwScheduleTimeAndPlace {
  if (!isRecord(value)) {
    throw new HbuJwQueryError('本学期课表接口结构异常。');
  }
  const classDay = parseRequiredInteger(value.classDay, '上课星期异常。');
  const classSessions = parseRequiredInteger(value.classSessions, '上课节次异常。');
  const continuingSession = parseRequiredInteger(value.continuingSession, '连续节次数异常。');
  if (classDay < 1 || classDay > 7 || classSessions < 1 || classSessions > 11 || continuingSession < 1 || classSessions + continuingSession - 1 > 11) {
    throw new HbuJwQueryError('本学期课表接口结构异常。');
  }
  return {
    classDay,
    classSessions,
    continuingSession,
    classWeek: readRequiredString(value.classWeek, '上课周次'),
    weekDescription: readRequiredString(value.weekDescription, '周次说明'),
    campusName: String(value.campusName ?? '').trim(),
    teachingBuildingName: String(value.teachingBuildingName ?? '').trim(),
    classroomName: String(value.classroomName ?? '').trim(),
  };
}

function readRequiredString(value: unknown, label: string): string {
  const text = String(value ?? '').trim();
  if (!text) {
    throw new HbuJwQueryError(`本学期课表接口缺少${label}。`);
  }
  return text;
}

function parseRequiredNumber(value: unknown, message: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new HbuJwQueryError(message);
  }
  return parsed;
}

function parseRequiredInteger(value: unknown, message: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new HbuJwQueryError(message);
  }
  return parsed;
}

function parseStudentPlanProfile(html: string): HbuJwStudentPlanProfile {
  const majorName = readProfileField(html, ['专业']);
  const cohortLabel = readProfileField(html, ['入学年级', '年级']);
  const planNumber = readInputValue(html, 'zx');
  return {
    majorName: requireString(majorName, '学籍专业'),
    cohortYear: parseCohortYear(cohortLabel),
    planNumber: planNumber || null,
    planDetailPath: planNumber ? findTrainingPlanDetailPath(html, planNumber) : null,
  };
}

function readProfileField(html: string, labels: string[]): string {
  const acceptedLabels = new Set(labels);
  const fields = html.matchAll(
    /<div\b[^>]*class=["'][^"']*\bprofile-info-name\b[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*<div\b[^>]*class=["'][^"']*\bprofile-info-value\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi,
  );
  for (const field of fields) {
    const label = cleanHtmlText(field[1]).replace(/[：:]$/, '').trim();
    if (!acceptedLabels.has(label)) continue;
    const value = cleanHtmlText(field[2]);
    if (value) return value;
  }
  return '';
}

function readInputValue(html: string, id: string): string {
  const tags = [...html.matchAll(/<input\b[^>]*>/gi)].map((match) => match[0]);
  const tag = tags.find((value) => new RegExp(`\\bid=["']${escapeRegExp(id)}["']`, 'i').test(value));
  return tag?.match(/\bvalue=["']([^"']*)["']/i)?.[1]?.trim() ?? '';
}

function findTrainingPlanDetailPath(html: string, planNumber: string): string {
  const normalized = html.replace(/\\\//g, '/');
  const literal = normalized.match(new RegExp(`[^"'\\s<>]*rollManagement/project/[^"'\\s<>+]+/${escapeRegExp(planNumber)}/1/detail`))?.[0];
  if (literal) return literal;

  const expression = normalized.match(/(?:url\s*[:=]\s*)?(["'][^"']*rollManagement\/project\/[^"']*\/["'])\s*\+\s*(?:fajhh|zx)\s*\+\s*(["']\/1\/detail[^"']*["'])/i);
  if (expression?.[1] && expression[2]) {
    const prefix = expression[1].slice(1, -1);
    const suffix = expression[2].slice(1, -1);
    return `${prefix}${planNumber}${suffix}`;
  }
  throw new HbuJwQueryError('学籍页面没有唯一的培养方案回调地址。');
}

function parseJsonObject(text: string, label: string): Record<string, unknown> {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new HbuJwQueryError(`${label}返回了非 JSON 内容。`);
  }
  return requireRecord(payload, label);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new HbuJwQueryError(`${label}结构异常。`);
  return value;
}

function requireRecordArray(value: unknown, label: string): Array<Record<string, unknown>> {
  if (!Array.isArray(value) || value.some((item) => !isRecord(item))) {
    throw new HbuJwQueryError(`${label}结构异常。`);
  }
  return value as Array<Record<string, unknown>>;
}

function stringValue(value: unknown): string {
  return String(value ?? '').trim();
}

function requireString(value: unknown, label: string): string {
  const text = stringValue(value);
  if (!text) throw new HbuJwQueryError(`${label}缺失。`);
  return text;
}

function requireNonNegativeNumber(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new HbuJwQueryError(`${label}异常。`);
  return parsed;
}

function requireFiniteNumber(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new HbuJwQueryError(`${label}异常。`);
  return parsed;
}

function requirePositiveNumber(value: unknown, label: string): number {
  const parsed = requireNonNegativeNumber(value, label);
  if (parsed <= 0) throw new HbuJwQueryError(`${label}异常。`);
  return parsed;
}

function optionalPositiveNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function isBlankValue(value: unknown): boolean {
  return value == null || String(value).trim() === '';
}

function parseReplacementCourseNumbers(node: Record<string, unknown>): string[] {
  const value = node.tdkch ?? node['替代课程号'] ?? node.replacementCourseNumbers ?? node.replaceCourseNumbers;
  if (Array.isArray(value)) return [...new Set(value.map(stringValue).filter(Boolean))];
  return [...new Set(stringValue(value).split(/[,，;；\s]+/).filter(Boolean))];
}

function parseCohortYear(value: unknown): number {
  const year = stringValue(value).match(/(?:19|20)\d{2}/)?.[0];
  if (!year) throw new HbuJwQueryError('学籍年级异常。');
  return Number(year);
}

function cleanHtmlText(value: unknown): string {
  return decodeBasicHtmlEntities(stringValue(value))
    .replace(/<br\s*\/?\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractPlanCourseNumber(path: string): string {
  const matched = path.match(/@([^/?#"']+)/);
  if (!matched?.[1]) return '';
  try {
    return decodeURIComponent(matched[1]).trim();
  } catch {
    throw new HbuJwQueryError('培养方案课程号编码异常。');
  }
}

function parsePlanCourseName(value: string): Pick<HbuJwTrainingPlanCourse, 'courseName' | 'attribute'> | null {
  const matched = value.match(/^(.*?)\s*(必修|限选|任选)\s*$/);
  if (!matched?.[1] || !matched[2]) return null;
  const attributes = {
    必修: 'required',
    限选: 'limited',
    任选: 'elective',
  } as const;
  return { courseName: matched[1].trim(), attribute: attributes[matched[2] as keyof typeof attributes] };
}

function findUniquePath(html: string, pattern: RegExp, label: string): string {
  const paths = [...new Set([...html.replace(/\\\//g, '/').matchAll(pattern)].map((match) => match[0]))];
  if (paths.length !== 1) throw new HbuJwQueryError(`${label}页面没有唯一的数据地址。`);
  return paths[0]!;
}

function readSelectedOptionValue(html: string, selectId: string, label: string): string {
  const select = html.match(new RegExp(`<select\\b[^>]*\\bid=["']${escapeRegExp(selectId)}["'][^>]*>[\\s\\S]*?<\\/select>`, 'i'))?.[0];
  if (!select) throw new HbuJwQueryError(`${label}缺失。`);
  const selectedOption = [...select.matchAll(/<option\b([^>]*)>[\s\S]*?<\/option>/gi)]
    .find((match) => /\bselected(?:\s*=\s*["'][^"']*["'])?/i.test(match[1] ?? ''));
  const value = selectedOption?.[1]?.match(/\bvalue=["']([^"']+)["']/i)?.[1];
  return requireString(value, label);
}

function ajaxFormHeaders(referer: string): Record<string, string> {
  return {
    accept: 'application/json, text/javascript, */*; q=0.01',
    'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'x-requested-with': 'XMLHttpRequest',
    referer,
  };
}

function normalizeCourseOfferings(
  rows: Array<Record<string, unknown>>,
  source: 'plan' | 'free',
): HbuJwCourseOffering[] {
  const offerings = new Map<string, HbuJwCourseOffering>();
  for (const row of rows) {
    const courseNumber = requireString(source === 'plan' ? row.courseNum : row.kch, '开课课程号');
    const sequenceNumber = requireString(source === 'plan' ? row.classNum : row.kxh, '开课课序号');
    const executionPlanNumber = requireString(source === 'plan' ? row.jhxnxqdm : row.zxjxjhh, '开课执行计划号');
    const key = `${executionPlanNumber}@${courseNumber}@${sequenceNumber}`;
    const meetings = normalizeOfferingMeetings(row, source);
    const existing = offerings.get(key);
    if (existing) {
      existing.meetings.push(...meetings);
      continue;
    }
    offerings.set(key, {
      executionPlanNumber,
      courseNumber,
      sequenceNumber,
      courseName: requireString(row.kcm ?? row.courseName, '开课课程名'),
      credits: requirePositiveNumber(row.xf ?? row.unit, '开课学分'),
      courseAttributeCode: stringValue(row.kcsxdm),
      courseAttributeName: stringValue(row.kcsxmc),
      categoryCode: stringValue(row.kclbdm),
      categoryName: stringValue(row.kclbmc),
      planCategoryCode: stringValue(row.kzh),
      planCategoryName: stringValue(row.kzm),
      teacherName: cleanHtmlText(row.skjs ?? row.attendClassTeacher),
      capacity: requireNonNegativeNumber(row.bkskrl ?? row.skrl ?? 0, '开课容量'),
      remainingSeats: requireFiniteNumber(row.bkskyl ?? row.skyl ?? row.kyl ?? 0, '开课余量'),
      meetings,
    });
  }
  return [...offerings.values()];
}

function normalizeOfferingMeetings(row: Record<string, unknown>, source: 'plan' | 'free'): HbuJwCourseOfferingMeeting[] {
  const scheduleValues = source === 'plan'
    ? [row.weekNum, row.courseStartNum, row.cxjc, row.zcsm]
    : [row.skxq, row.skjc, row.cxjc, row.skzc];
  if (scheduleValues.every(isBlankValue)) {
    return [];
  }
  const weekday = Number(scheduleValues[0]);
  const startSection = Number(scheduleValues[1]);
  const sectionCount = Number(scheduleValues[2]);
  if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7
    || !Number.isInteger(startSection) || startSection < 1 || startSection > 11
    || !Number.isInteger(sectionCount) || sectionCount < 1 || startSection + sectionCount - 1 > 11) {
    throw new HbuJwQueryError('开课时间结构异常。');
  }
  return [{
    classWeek: requireString(source === 'plan' ? row.zcsm : row.skzc, '开课周次'),
    weekday,
    startSection,
    sectionCount,
    campusName: stringValue(row.kkxqm),
    teachingBuildingName: stringValue(row.jxlm),
    classroomName: stringValue(row.jasm),
  }];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

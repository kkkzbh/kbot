import type {
  HbuJwScheduleCourse,
  HbuJwScheduleTimeAndPlace,
  HbuJwScoreRow,
  HbuJwThisSemesterSchedule,
  HbuJwThisTermScoreRow,
  SerializedCookieJar,
} from './types.js';

export interface HbuJwLoginResult {
  cookieJar: SerializedCookieJar;
}

export interface HbuJwClientOptions {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  userAgent?: string;
}

type RequestOptions = Omit<RequestInit, 'headers'> & {
  headers?: Record<string, string>;
};

export class HbuJwLoginError extends Error {
  readonly code: string;
  readonly diagnostic: string;

  constructor(message: string, options: { code: string; diagnostic: string; cause?: unknown }) {
    super(message);
    this.name = 'HbuJwLoginError';
    this.code = options.code;
    this.diagnostic = options.diagnostic;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

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
  private readonly userAgent: string;

  constructor(options: HbuJwClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = options.baseUrl ?? 'https://zhjw.hbu.cn';
    this.baseOrigin = new URL(this.baseUrl).origin;
    this.userAgent = options.userAgent ?? 'qqbot-hbu-jw/1.0';
  }

  async login(username: string, password: string): Promise<HbuJwLoginResult> {
    try {
      const jar = new CookieJar();
      const loginPage = await this.request('/login', { jar });
      if (loginPage.response.status !== 200) {
        throw new HbuJwLoginError('教务登录页访问失败，请稍后重试。', {
          code: 'login_page_failed',
          diagnostic: `login_page status=${loginPage.response.status}`,
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
        return { cookieJar: jar.serialize() };
      }

      const redirect = login.response.headers.get('location');
      if (!redirect && isLoginPageHtml(login.text)) {
        const message = extractLoginFailureMessage(login.text) ?? '教务登录失败，教务系统未返回登录态。';
        throw new HbuJwLoginError(message, {
          code: 'login_rejected',
          diagnostic: `login_submit status=${login.response.status} redirect=none message=${message}`,
        });
      }

      const target = redirect ? this.normalizeSameOriginUrl(redirect) : `${this.baseUrl}/index`;
      const index = await this.request(target, { jar, headers: { referer: `${this.baseUrl}/login` } });
      if (!isAuthenticatedHtml(index.text)) {
        const message = extractLoginFailureMessage(index.text) ?? extractLoginFailureMessage(login.text) ?? '教务登录失败，教务系统未返回登录态。';
        throw new HbuJwLoginError(message, {
          code: 'not_authenticated',
          diagnostic: `login_submit status=${login.response.status} redirect=${redirect ? 'same-origin' : 'none'} index status=${index.response.status} message=${message}`,
        });
      }
      return { cookieJar: jar.serialize() };
    } catch (error) {
      if (error instanceof HbuJwLoginError) throw error;
      throw new HbuJwLoginError('教务登录请求失败，请检查网络或代理配置。', {
        code: 'request_failed',
        diagnostic: describeError(error),
        cause: error,
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
      throw new HbuJwQueryError('全部及格成绩页面访问失败。');
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
      throw new HbuJwQueryError('全部及格成绩接口访问失败。');
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
      throw new HbuJwQueryError('本学期成绩页面访问失败。');
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
      throw new HbuJwQueryError('本学期成绩接口访问失败。');
    }

    let payload: unknown;
    try {
      payload = JSON.parse(data.text);
    } catch {
      throw new HbuJwQueryError('本学期成绩接口返回了非 JSON 内容。');
    }
    return flattenThisTermScores(payload);
  }

  async getThisSemesterSchedule(cookieJar: SerializedCookieJar): Promise<HbuJwThisSemesterSchedule> {
    const jar = CookieJar.from(cookieJar);
    const pagePath = '/student/courseSelect/thisSemesterCurriculum/index';
    const page = await this.request(pagePath, {
      jar,
      headers: { referer: `${this.baseUrl}/index` },
    });
    if (page.response.status !== 200) {
      throw new HbuJwQueryError('本学期课表页面访问失败。');
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
      throw new HbuJwQueryError('本学期课表接口访问失败。');
    }

    let payload: unknown;
    try {
      payload = JSON.parse(callback.text);
    } catch {
      throw new HbuJwQueryError('本学期课表接口返回了非 JSON 内容。');
    }
    return parseThisSemesterSchedulePayload(payload);
  }

  private async request(url: string, options: RequestOptions & { jar: CookieJar }): Promise<{ response: Response; text: string }> {
    const { jar, ...requestOptions } = options;
    const target = url.startsWith('http://') || url.startsWith('https://') ? url : new URL(url, this.baseUrl).href;
    const targetUrl = new URL(target);
    if (targetUrl.origin !== this.baseOrigin) {
      throw new HbuJwLoginError('教务系统返回了非预期跳转。', {
        code: 'cross_origin_request',
        diagnostic: `request origin=${targetUrl.origin}`,
      });
    }
    const headers: Record<string, string> = {
      'user-agent': this.userAgent,
      ...(options.headers ?? {}),
    };
    const cookieHeader = jar.header();
    if (cookieHeader) headers.cookie = cookieHeader;
    const response = await this.fetchImpl(target, {
      ...requestOptions,
      headers,
      redirect: 'manual',
    });
    jar.remember(readSetCookieHeaders(response.headers));
    return { response, text: await response.text() };
  }

  private normalizeSameOriginUrl(value: string): string {
    const target = new URL(value, this.baseUrl);
    const base = new URL(this.baseUrl);
    if (target.hostname === base.hostname && target.protocol === 'http:' && base.protocol === 'https:') {
      target.protocol = 'https:';
    }
    if (target.origin !== this.baseOrigin) {
      throw new HbuJwLoginError('教务系统返回了非预期跳转。', {
        code: 'cross_origin_redirect',
        diagnostic: `redirect origin=${target.origin}`,
      });
    }
    return target.href;
  }
}

class CookieJar {
  private readonly cookies = new Map<string, string>();

  static from(serialized: SerializedCookieJar): CookieJar {
    const jar = new CookieJar();
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

function findThisSemesterScheduleCallback(html: string): string {
  const matches = [...html.matchAll(/[^"'\s<>]*thisSemesterCurriculum\/[^"'\s<>]*\/ajaxStudentSchedule\/curr\/callback[^"'\s<>]*/g)]
    .map((match) => match[0].replace(/\\\//g, '/'));
  if (matches.length !== 1) {
    throw new HbuJwQueryError('本学期课表页面没有唯一的回调地址。');
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

function parseScheduleCourse(value: unknown): HbuJwScheduleCourse {
  if (!isRecord(value) || !isRecord(value.id) || !Array.isArray(value.timeAndPlaceList)) {
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
    timeAndPlaceList: value.timeAndPlaceList.map(parseScheduleTimeAndPlace),
  };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

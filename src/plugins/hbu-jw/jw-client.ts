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

  async getSubitemScoreTerms(cookieJar: SerializedCookieJar): Promise<HbuJwSubitemScoreTerm[]> {
    const jar = CookieJar.from(cookieJar);
    const pagePath = '/student/integratedQuery/scoreQuery/subitemScore/index';
    const page = await this.request(pagePath, {
      jar,
      headers: { referer: `${this.baseUrl}/index` },
    });
    if (page.response.status !== 200) {
      throw new HbuJwQueryError('分项成绩页面访问失败。');
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
      throw new HbuJwQueryError('分项成绩页面访问失败。');
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
      throw new HbuJwQueryError('分项成绩查询接口访问失败。');
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
      throw new HbuJwQueryError('考试安排页面访问失败。');
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
      throw new HbuJwQueryError('考试安排接口访问失败。');
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

  async getCourseSelectionResult(cookieJar: SerializedCookieJar): Promise<HbuJwCourseSelectionResult> {
    const jar = CookieJar.from(cookieJar);
    const pagePath = '/student/courseSelect/courseSelectResult/index';
    const page = await this.request(pagePath, {
      jar,
      headers: { referer: `${this.baseUrl}/index` },
    });
    if (page.response.status !== 200) {
      throw new HbuJwQueryError('选课结果页面访问失败。');
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
      throw new HbuJwQueryError('选课结果接口访问失败。');
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
      throw new HbuJwQueryError('学籍信息页面访问失败。');
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
      throw new HbuJwQueryError('培养方案详情接口访问失败。');
    }
    const payload = parseJsonObject(detail.text, '培养方案详情接口');
    const metadata = requireRecord(payload.jhFajhb, '培养方案元数据');
    const treeList = requireRecordArray(payload.treeList, '培养方案课程树');
    const roots = treeList.filter((node) => stringValue(node.pId) === '0');
    if (roots.length === 0) {
      throw new HbuJwQueryError('培养方案课程树没有课组根节点。');
    }

    const categories = (await Promise.all(roots.map(async (root) => {
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
        throw new HbuJwQueryError('培养方案课组接口访问失败。');
      }
      const categoryPayload = parseJsonObject(response.text, '培养方案课组接口');
      const category = requireRecord(categoryPayload.kz, '培养方案课组');
      const requiredCredits = requireNonNegativeNumber(category.zsxf, '课组最低学分');
      if (requiredCredits === 0) return null;
      return {
        code: requireString(category.kzh ?? category.id ?? root.id, '课组代码'),
        name: cleanHtmlText(category.kzm ?? category.name ?? root.name),
        catalogCredits: requireNonNegativeNumber(category.kczxf ?? requiredCredits, '课组课程总学分'),
        requiredCredits,
      } satisfies HbuJwTrainingPlanCategory;
    }))).filter((value): value is HbuJwTrainingPlanCategory => value !== null);
    if (categories.length === 0) {
      throw new HbuJwQueryError('培养方案没有正学分课组。');
    }

    const categoryByNode = new Map<string, HbuJwTrainingPlanCategory>();
    for (const root of roots) {
      const rootId = stringValue(root.id);
      const rootCode = stringValue(root.kzh ?? rootId);
      const category = categories.find((item) => item.code === rootCode)
        ?? categories.find((item) => item.name === cleanHtmlText(root.name));
      if (rootId && category) categoryByNode.set(rootId, category);
    }
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
    if (page.response.status !== 200) throw new HbuJwQueryError('方案选课页面访问失败。');
    const callbackPath = findUniquePath(page.text, /[^"'\s<>]*planCourse\/courseList[^"'\s<>]*/g, '方案选课');
    const response = await this.request(callbackPath, {
      jar,
      method: 'POST',
      headers: ajaxFormHeaders(new URL(pagePath, this.baseUrl).href),
      body: new URLSearchParams({ fajhh: planNumber, jhxn: '', kcsxdm: '', kch: '', kcm: '', kclbdm: '', xqh: '', xq: '0', jc: '0' }),
    });
    if (response.response.status !== 200) throw new HbuJwQueryError('方案选课接口访问失败。');
    const payload = parseJsonObject(response.text, '方案选课接口');
    return normalizeCourseOfferings(requireRecordArray(payload.rwfalist, '方案选课班次'), 'plan');
  }

  async getFreeCourseOfferings(cookieJar: SerializedCookieJar, categoryCode = '05'): Promise<HbuJwCourseOffering[]> {
    const jar = CookieJar.from(cookieJar);
    const pagePath = '/student/courseSelect/freeCourse/index';
    const page = await this.request(pagePath, { jar, headers: { referer: `${this.baseUrl}/index` } });
    if (page.response.status !== 200) throw new HbuJwQueryError('自由选课页面访问失败。');
    const callbackPath = findUniquePath(page.text, /[^"'\s<>]*freeCourse\/courseList[^"'\s<>]*/g, '自由选课');
    const response = await this.request(callbackPath, {
      jar,
      method: 'POST',
      headers: ajaxFormHeaders(new URL(pagePath, this.baseUrl).href),
      body: new URLSearchParams({ kkxsh: '', kch: '', kcm: '', skjs: '', xq: '0', jc: '0', kclbdm: categoryCode }),
    });
    if (response.response.status !== 200) throw new HbuJwQueryError('自由选课接口访问失败。');
    const payload = parseJsonObject(response.text, '自由选课接口');
    return normalizeCourseOfferings(requireRecordArray(payload.rwRxkZlList, '自由选课班次'), 'free');
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
  if (!isRecord(value) || !isRecord(value.id) || !Array.isArray(value.timeAndPlaceList)) {
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
    timeAndPlaceList: value.timeAndPlaceList.map(parseScheduleTimeAndPlace),
  };
}

function readCourseSelectionRequiredString(value: unknown, label: string): string {
  const text = String(value ?? '').trim();
  if (!text) throw new HbuJwQueryError(`选课结果接口缺少${label}。`);
  return text;
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
  for (const label of labels) {
    const escaped = escapeRegExp(label);
    const row = html.match(new RegExp(`<[^>]+class=["'][^"']*profile-info-row[^"']*["'][^>]*>[\\s\\S]*?${escaped}[：:]?[\\s\\S]*?<\\/[^>]+>`, 'i'))?.[0];
    if (!row) continue;
    const text = cleanHtmlText(row);
    const value = text.replace(new RegExp(`^.*?${escaped}[：:]?\\s*`), '').trim();
    if (value) return value;
  }
  const text = cleanHtmlText(html);
  for (const label of labels) {
    const matched = text.match(new RegExp(`${escapeRegExp(label)}[：:]\\s*([^\\s]{2,40})`));
    if (matched?.[1]) return matched[1];
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

function requirePositiveNumber(value: unknown, label: string): number {
  const parsed = requireNonNegativeNumber(value, label);
  if (parsed <= 0) throw new HbuJwQueryError(`${label}异常。`);
  return parsed;
}

function optionalPositiveNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
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
    const executionPlanNumber = requireString(source === 'plan' ? row.schemeNum : row.zxjxjhh, '开课执行计划号');
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
      remainingSeats: requireNonNegativeNumber(row.bkskyl ?? row.skyl ?? row.kyl ?? 0, '开课余量'),
      meetings,
    });
  }
  return [...offerings.values()];
}

function normalizeOfferingMeetings(row: Record<string, unknown>, source: 'plan' | 'free'): HbuJwCourseOfferingMeeting[] {
  const raw = source === 'plan' && Array.isArray(row.kcsjddlist)
    ? requireRecordArray(row.kcsjddlist, '方案选课上课时间')
    : [row];
  return raw.map((meeting) => {
    const weekday = Number(meeting.skxq ?? meeting.classDay ?? row.skxq ?? row.classDay);
    const startSection = Number(meeting.skjc ?? meeting.classSessions ?? row.skjc ?? row.classSessions);
    const sectionCount = Number(meeting.cxjc ?? meeting.continuingSession ?? row.cxjc ?? row.continuingSession ?? 1);
    if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7
      || !Number.isInteger(startSection) || startSection < 1
      || !Number.isInteger(sectionCount) || sectionCount < 1) {
      throw new HbuJwQueryError('开课时间结构异常。');
    }
    return {
      classWeek: requireString(meeting.skzc ?? meeting.classWeek ?? row.skzc ?? row.classWeek, '开课周次'),
      weekday,
      startSection,
      sectionCount,
      campusName: stringValue(meeting.kkxqm ?? meeting.campusName),
      teachingBuildingName: stringValue(meeting.jxlm ?? meeting.teachingBuildingName),
      classroomName: stringValue(meeting.jsm ?? meeting.classroomName),
    };
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

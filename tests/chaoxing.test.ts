import { describe, expect, it, vi } from 'vitest';
import { normalizeAnswer, parseQuestionResultStatuses, parseWorkPage } from '../src/plugins/chaoxing/answer-service.js';
import { ChaoxingCookieJar, parseSetCookie } from '../src/plugins/chaoxing/cookie-jar.js';
import {
  ChaoxingClient,
  parseActivities,
  parseAssignments,
  parseChapters,
  parseCourseList,
  parseExams,
  parseTaskCard,
  parseTaskCardCount,
  videoProgressEnc,
} from '../src/plugins/chaoxing/client.js';
import { parseChaoxingCommand } from '../src/plugins/chaoxing/commands.js';
import { ChaoxingDeadlineService, filterPendingTasks } from '../src/plugins/chaoxing/deadline-service.js';
import { ChaoxingOwnerCoordinator } from '../src/plugins/chaoxing/owner-coordinator.js';
import { ChaoxingSignService, classifySignType, filterPendingSigns, formatDetectedSigns } from '../src/plugins/chaoxing/sign-service.js';
import { selectResumableStudyJob } from '../src/plugins/chaoxing/study-runner.js';
import type { ChaoxingQuestion } from '../src/plugins/chaoxing/types.js';
import { renderChaoxingBindPage } from '../src/plugins/chaoxing/web/bind-page.js';

describe('chaoxing protocol parsers', () => {
  it('normalizes remote course class identifiers at the client boundary', () => {
    expect(parseCourseList({
      channelList: [{
        cpi: '300',
        content: {
          id: '200',
          name: '软件工程 1 班',
          state: 1,
          isretire: 0,
          course: { data: [{ id: '100', name: '软件工程', teacherfactor: '张老师', schools: '河北大学' }] },
        },
      }],
    })).toEqual([expect.objectContaining({ courseId: '100', classId: '200', cpi: '300', name: '软件工程' })]);
  });

  it('extracts chapters and removes duplicate chapter links', () => {
    const chapters = parseChapters(`
      <script>var enc = "chapter-enc";</script>
      <div class="chapter_item" title="第一章" onclick="toOld('100', '10', '200', 0)"></div>
      <div class="chapter_item" title="第一章" onclick="toOld('100', '10', '200', 0)"></div>
      <div class="chapter_item" title="第二章" onclick="toOld('100', '11', '200', 0)"></div>
    `, { courseId: '100', classId: '200' });
    expect(chapters).toEqual([
      expect.objectContaining({ chapterId: '10', enc: 'chapter-enc', title: '第一章' }),
      expect.objectContaining({ chapterId: '11', enc: 'chapter-enc', title: '第二章' }),
    ]);
  });

  it('parses task-card defaults and authoritative completion flags', () => {
    const card = parseTaskCard(`<script>var mArg = ""; try { mArg = ${JSON.stringify({
      defaults: { fid: '1', userid: '2', cpi: '3', knowledgeid: '4', ktoken: 'token', reportUrl: 'https://mooc1-api.chaoxing.com/multimedia/log/a', reportTimeInterval: 30 },
      attachments: [
        { type: 'video', job: true, jobid: 'job-1', objectId: 'object-1', isPassed: false, playTime: 12_000, property: { rt: 1 } },
        { type: 'document', job: true, jobid: 'job-2', jtoken: 'document-token', isPassed: true },
      ],
    })}; } catch (error) {}</script>`);
    expect(card.defaults).toMatchObject({ fid: '1', userid: '2', knowledgeid: '4', reportTimeInterval: 30 });
    expect(card.attachments).toEqual([
      expect.objectContaining({ type: 'video', jobid: 'job-1', isPassed: false, playTime: 12 }),
      expect.objectContaining({ type: 'document', jobid: 'job-2', isPassed: true }),
    ]);
  });

  it('reads the authoritative task-card count from the chapter page', () => {
    expect(parseTaskCardCount('<input id="cardcount" value="3">')).toBe(3);
    expect(parseTaskCardCount('<script>var cardcount = "2";</script>')).toBe(2);
  });

  it('uses the LearningPass video progress signature contract', () => {
    expect(videoProgressEnc('100', '200', 'job-1', 'object-1', 30, 60)).toBe('ffc8c5149a35bd3564c0fb4624c6fb3c');
  });

  it('parses current assignment and exam list items', () => {
    const course = { courseId: '100', classId: '200', name: '软件工程' };
    const assignments = parseAssignments(`
      <ul class="task-list"><li data="/mooc2/work/view?workId=work-1">
        <p class="overHidden2">需求分析作业</p>
        <p class="status">未交</p><p>截止 2026-07-20 23:59</p>
      </li></ul>
    `, course);
    expect(assignments).toEqual([expect.objectContaining({ remoteId: 'work-1', title: '需求分析作业', status: '未交' })]);

    const exams = parseExams(`
      <ul class="task-list"><li onclick="viewExamAnswer('exam-1', 'answer-1')">
        <p class="overHidden2">软件工程期末考试</p>
        <p class="status">已过期</p><p>2026-07-10 09:00 至 2026-07-10 11:00</p>
      </li></ul>
    `, course);
    expect(exams).toEqual([expect.objectContaining({ remoteId: 'exam-1', title: '软件工程期末考试', status: '已过期' })]);
  });

  it('parses sign activities', () => {
    const course = { courseId: '100', classId: '200', name: '软件工程' };

    const activities = parseActivities(JSON.stringify({
      result: 1,
      data: { activeList: [{ id: 900, nameOne: '课堂签到', activeType: 2, otherId: 5, status: 1, userStatus: 0, startTime: 1_721_000_000 }] },
    }), course);
    expect(activities).toEqual([expect.objectContaining({ activityId: '900', classId: '200', signTypeCode: '5', status: 1 })]);
  });

  it('reads the photo requirement used to distinguish normal and photo signs', async () => {
    const client = new ChaoxingClient({
      fetchImpl: vi.fn().mockResolvedValue(new Response(JSON.stringify({
        result: 1,
        data: { id: 900, otherId: 0, ifphoto: 1, ifNeedVCode: 0, openCheckFaceFlag: 0 },
      }), { status: 200 })) as typeof fetch,
    });

    const result = await client.getSignInfo({ cookies: [] }, '900');

    expect(result.info).toMatchObject({ otherId: '0', ifPhoto: true, ifNeedVCode: false, openCheckFaceFlag: false });
  });

  it('uses course-declared routes and current navigation fields for academic tasks', async () => {
    const requested: URL[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input));
      requested.push(url);
      if (url.pathname === '/visit/stucoursemiddle') {
        return new Response('', { status: 302, headers: { location: 'https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu' } });
      }
      if (url.pathname === '/mooc2-ans/mycourse/stu') {
        return new Response(`
          <input id="enc" value="course-enc"><input id="t" value="course-t">
          <input id="workEnc" value="work-enc"><input id="examEnc" value="exam-enc"><input id="openc" value="open-enc">
          <li dataname="zy"><a data-url="https://mooc1.chaoxing.com/mooc2/work/list"></a></li>
          <li dataname="ks"><a data-url="https://mooc1.chaoxing.com/exam-ans/mooc2/exam/exam-list"></a></li>
        `, { status: 200 });
      }
      if (url.pathname === '/mooc2/work/list') {
        return new Response('<ul class="task-list"><li data="/view?workId=w1"><p class="overHidden2">作业一</p><p>未交</p></li></ul>', { status: 200 });
      }
      if (url.pathname === '/exam-ans/mooc2/exam/exam-list') {
        return new Response('<ul class="task-list"><li onclick="viewExamAnswer(\'e1\', \'a1\')"><p class="overHidden2">考试一</p><p>未开始</p></li></ul>', { status: 200 });
      }
      return new Response('unexpected route', { status: 404 });
    });
    const client = new ChaoxingClient({ fetchImpl: fetchImpl as typeof fetch });
    const course = {
      courseId: '100', classId: '200', cpi: '300', name: '软件工程', className: '', teacherName: '', schoolName: '', imageUrl: '', state: 1, isRetired: 0,
    };
    const result = await client.getAcademicTasks({ cookies: [] }, course, ['work', 'exam']);

    expect(result.items).toEqual([
      expect.objectContaining({ kind: 'work', remoteId: 'w1' }),
      expect.objectContaining({ kind: 'exam', remoteId: 'e1' }),
    ]);
    const workUrl = requested.find((url) => url.pathname === '/mooc2/work/list')!;
    expect(Object.fromEntries(workUrl.searchParams)).toMatchObject({
      courseId: '100', classId: '200', cpi: '300', stuenc: 'course-enc', enc: 'work-enc', t: 'course-t', ut: 's',
    });
    const examUrl = requested.find((url) => url.pathname === '/exam-ans/mooc2/exam/exam-list')!;
    expect(Object.fromEntries(examUrl.searchParams)).toMatchObject({
      courseid: '100', clazzid: '200', cpi: '300', stuenc: 'course-enc', enc: 'exam-enc', openc: 'open-enc', t: 'course-t', ut: 's',
    });
  });

  it('classifies the 202 anti-spider page as a captcha pause', async () => {
    const client = new ChaoxingClient({
      fetchImpl: vi.fn().mockResolvedValue(new Response('【9010】操作异常，请输入图片中的验证码', { status: 202 })) as typeof fetch,
    });
    const course = {
      courseId: '100', classId: '200', cpi: '300', name: '软件工程', className: '', teacherName: '', schoolName: '', imageUrl: '', state: 1, isRetired: 0,
    };

    await expect(client.getAcademicTasks({ cookies: [] }, course, ['work'])).rejects.toMatchObject({
      name: 'ChaoxingCaptchaRequiredError',
      message: '学习通要求完成验证码，任务已暂停。',
    });
  });

  it('parses supported chapter quiz questions and preserves submit fields', () => {
    const parsed = parseWorkPage(`
      <form action="/mooc-ans/work/addStudentWorkNew">
        <input name="workId" value="work-1">
        <div class="singleQuesId" data="q1"><div class="TiMu" data="0"></div><div class="Zy_TItle">1. TCP 属于哪一层？</div>
          <ul><li><input value="A">A. 网络层</li><li><input value="B">B. 传输层</li></ul>
        </div>
        <div class="singleQuesId" data="q2"><div class="TiMu" data="3"></div><div class="Zy_TItle">2. UDP 面向连接。</div></div>
      </form>
    `, 'https://mooc2-ans.chaoxing.com/mooc-ans/api/work', 'work-1');
    expect(parsed.form).toEqual({ workId: 'work-1' });
    expect(parsed.submitUrl).toBe('https://mooc2-ans.chaoxing.com/mooc-ans/work/addStudentWorkNew');
    expect(parsed.questions).toEqual([
      expect.objectContaining({ id: 'q1', type: 'single', options: [{ key: 'A', text: '网络层' }, { key: 'B', text: '传输层' }] }),
      expect.objectContaining({ id: 'q2', type: 'judgement' }),
    ]);
  });

  it('classifies graded answers for wrong-answer persistence', () => {
    expect([...parseQuestionResultStatuses(`
      <div class="singleQuesId" data="1"><i class="trueGreen"></i></div>
      <div class="singleQuesId" data="2"><i class="falseRed"></i></div>
      <div class="singleQuesId" data="3"><i class="halfTrueGreen"></i></div>
    `)]).toEqual([['1', 'correct'], ['2', 'wrong'], ['3', 'partial']]);
  });

  it('preserves each remote field for multi-blank completion questions', () => {
    const parsed = parseWorkPage(`
      <form><div class="singleQuesId" data="q3">
        <div class="TiMu" data="2"></div><div class="Zy_TItle">协议由语法和语义组成。</div>
        <textarea name="answerq31"></textarea><textarea name="answerq32"></textarea>
        <input name="tiankongsizeq3" value="2">
      </div></form>
    `, 'https://mooc2-ans.chaoxing.com/mooc-ans/api/work', 'work-2');
    expect(parsed.questions[0]).toMatchObject({ type: 'completion', answerFields: ['answerq31', 'answerq32'] });
  });
});

describe('chaoxing local contracts', () => {
  it('scans open signs from retired courses and keeps display status separate from pending execution', async () => {
    const identity = { ownerKey: 'onebot:10001', platform: 'onebot', qqUserId: '10001', channelId: 'group:1' };
    const retiredCourse = {
      courseId: '100', classId: '200', cpi: '300', name: '签到测试课', className: '', teacherName: '', schoolName: '', imageUrl: '', state: 0, isRetired: 1,
    };
    const activities = [
      {
        activityId: 'open-signed', courseId: '100', classId: '200', title: '普通签到', activityType: 2,
        signTypeCode: '0', status: 1, userStatus: 1, startAt: null, endAt: null, ext: '{}', raw: {},
      },
      {
        activityId: 'open-pending', courseId: '100', classId: '200', title: '普通签到', activityType: 2,
        signTypeCode: '0', status: 1, userStatus: 0, startAt: null, endAt: null, ext: '{}', raw: {},
      },
      {
        activityId: 'closed', courseId: '100', classId: '200', title: '已结束签到', activityType: 2,
        signTypeCode: '0', status: 2, userStatus: 0, startAt: null, endAt: null, ext: '{}', raw: {},
      },
    ];
    const auth = {
      ownerKey: identity.ownerKey, cookieJar: { cookies: [] },
      profile: { uid: '1', puid: '2', fid: '3', name: '测试', schoolName: '学校', username: 'user', deviceCode: 'device' },
      credentialVersion: 1,
    };
    const getActivities = vi.fn().mockResolvedValue({ activities, cookieJar: { cookies: [] } });
    const getSignInfo = vi.fn().mockImplementation(async (_cookieJar, activityId: string) => ({
      info: {
        otherId: '0', ifPhoto: false, ifNeedVCode: false, openCheckFaceFlag: false,
        startAt: null, endAt: null, raw: { id: activityId },
      },
      cookieJar: { cookies: [] },
    }));
    const service = new ChaoxingSignService(
      {
        getAuthenticatedSession: vi.fn().mockResolvedValue(auth),
        persistCookies: vi.fn().mockImplementation(async (current, cookieJar) => ({ ...current, cookieJar })),
      } as never,
      { listCourses: vi.fn().mockResolvedValue([retiredCourse]) } as never,
      { getActivities, getSignInfo } as never,
      {} as never,
      { requestIntervalMs: 0 },
    );

    const signs = await service.scanOpenSigns(identity);

    expect(getActivities).toHaveBeenCalledWith({ cookies: [] }, retiredCourse);
    expect(signs.map((sign) => sign.activity.activityId)).toEqual(['open-signed', 'open-pending']);
    expect(signs.every((sign) => sign.signType === 'normal')).toBe(true);
    expect(filterPendingSigns(signs).map((sign) => sign.activity.activityId)).toEqual(['open-pending']);
    expect(formatDetectedSigns(signs)).toContain('普通签到，已签到，活动ID open-signed');
    expect(formatDetectedSigns(signs)).toContain('普通签到，待签到，活动ID open-pending');
    await expect(service.resolveDetectedSign(identity, 'open-signed')).rejects.toThrow('没有找到进行中的签到活动 open-signed');
    await expect(service.resolveDetectedSign(identity, 'open-pending')).resolves.toMatchObject({
      activity: { activityId: 'open-pending' },
    });
  });

  it('classifies ordinary and photo signs using both remote fields', () => {
    expect(classifySignType({ otherId: '0', ifPhoto: false })).toBe('normal');
    expect(classifySignType({ otherId: '0', ifPhoto: true })).toBe('photo');
    expect(classifySignType({ otherId: '1', ifPhoto: false })).toBe('photo');
    expect(classifySignType({ otherId: '2', ifPhoto: false })).toBe('qrcode');
    expect(classifySignType({ otherId: '3', ifPhoto: false })).toBe('gesture');
    expect(classifySignType({ otherId: '4', ifPhoto: false })).toBe('location');
    expect(classifySignType({ otherId: '5', ifPhoto: false })).toBe('code');
    expect(classifySignType({ otherId: '', ifPhoto: false })).toBe('unknown');
  });

  it('does not report expired or closed remote tasks as pending', () => {
    expect(filterPendingTasks([
      { status: '已过期', endAt: null } as never,
      { status: '已截止', endAt: null } as never,
      { status: '未交', endAt: null } as never,
    ])).toEqual([{ status: '未交', endAt: null }]);
  });

  it('selects the latest resumable study checkpoint for the same course', () => {
    const base = {
      ownerKey: 'onebot:1', platform: 'onebot', qqUserId: '1', channelId: 'group:1', type: 'study' as const,
      courseId: '100', classId: '200', courseQuery: '软件工程', payloadJson: '{}', progressJson: '{}', resultJson: null,
      errorMessage: null, runAfter: 0, lockedAt: null, startedAt: null, finishedAt: null, createdAt: 1,
    };
    const jobs = [
      { ...base, id: 1, status: 'failed' as const, updatedAt: 10 },
      { ...base, id: 2, status: 'waiting_input' as const, updatedAt: 20 },
      { ...base, id: 3, status: 'cancelled' as const, courseId: 'other', updatedAt: 30 },
    ];

    expect(selectResumableStudyJob(jobs, { courseId: '100', classId: '200' })?.id).toBe(2);
  });

  it('syncs only the task type requested by the user', async () => {
    const identity = { ownerKey: 'onebot:10001', platform: 'onebot', qqUserId: '10001', channelId: 'group:1' };
    const course = {
      courseId: '100', classId: '200', cpi: '300', name: '软件工程', className: '', teacherName: '', schoolName: '', imageUrl: '', state: 1, isRetired: 0,
    };
    const getAcademicTasks = vi.fn().mockResolvedValue({ items: [], cookieJar: { cookies: [] } });
    const getActivities = vi.fn().mockRejectedValue(new Error('sign must not be queried'));
    const auth = { ownerKey: identity.ownerKey, cookieJar: { cookies: [] }, profile: {}, credentialVersion: 1 };
    const service = new ChaoxingDeadlineService(
      {
        getAuthenticatedSession: vi.fn().mockResolvedValue(auth),
        persistCookies: vi.fn().mockImplementation(async (current) => current),
      } as never,
      { listCourses: vi.fn().mockResolvedValue([course]) } as never,
      { getAcademicTasks, getActivities } as never,
      {
        listTasks: vi.fn().mockResolvedValue([]),
        replaceTaskSnapshot: vi.fn().mockResolvedValue([]),
        pruneTasks: vi.fn().mockResolvedValue(undefined),
        markTaskNotified: vi.fn(),
        markTaskReminded: vi.fn(),
      } as never,
      { send: vi.fn() },
      { requestIntervalMs: 0, reminderLeadMs: 86_400_000 },
    );

    await service.query(identity, 'work');

    expect(getAcademicTasks).toHaveBeenCalledWith({ cookies: [] }, course, ['work']);
    expect(getActivities).not.toHaveBeenCalled();
  });

  it('keeps the account after login failure while clearing the password', () => {
    const html = renderChaoxingBindPage({
      qq: '10001', token: 'bind-token', state: 'error', passwordSubmitPath: '/chaoxing/bind/password',
      username: 'student<123>', persistCredentialConsent: true, message: '账号验证失败',
    });
    expect(html).toContain('value="student&lt;123&gt;"');
    expect(html).toContain('name="persistCredentialConsent" value="yes" checked');
    expect(html).toContain('name="password" autocomplete="current-password" required');
    expect(html).not.toContain('fixture-password');
  });

  it('renders a copy button on the successful binding page', () => {
    const html = renderChaoxingBindPage({ qq: '10001', state: 'success', confirmCode: '123456' });
    expect(html).toContain('data-copy-confirm-command');
    expect(html).toContain('data-copy-text="学习通确认 123456"');
    expect(html).toContain('复制确认消息');
    expect(html).toContain('navigator.clipboard.writeText');
  });

  it('enforces cookie domain, path, secure, and expiry boundaries', () => {
    const now = Date.UTC(2026, 6, 15);
    const cookie = parseSetCookie('UID=abc; Domain=.chaoxing.com; Path=/mooc; Secure; HttpOnly; Max-Age=60', new URL('https://mooc1.chaoxing.com/mooc/login'), now);
    expect(cookie).toMatchObject({ domain: 'chaoxing.com', path: '/mooc', hostOnly: false, secure: true, httpOnly: true, expiresAt: now + 60_000 });
    const jar = ChaoxingCookieJar.from({ cookies: [cookie!] });
    expect(jar.cookieHeader(new URL('https://mooc2.chaoxing.com/mooc/course'), now)).toBe('UID=abc');
    expect(jar.cookieHeader(new URL('https://mooc2.chaoxing.com/other'), now)).toBe('');
    expect(jar.cookieHeader(new URL('http://mooc2.chaoxing.com/mooc/course'), now)).toBe('');
    expect(jar.cookieHeader(new URL('https://mooc2.chaoxing.com/mooc/course'), now + 60_001)).toBe('');
  });

  it('normalizes supported answer types without guessing option text', () => {
    const base = { id: '1', position: 1, typeCode: '0', title: '题目', options: [{ key: 'A', text: '甲' }, { key: 'B', text: '乙' }, { key: 'C', text: '丙' }], answerFields: ['answer1'] };
    expect(normalizeAnswer({ ...base, type: 'single' } satisfies ChaoxingQuestion, '乙')).toBe('B');
    expect(normalizeAnswer({ ...base, type: 'multiple' } satisfies ChaoxingQuestion, 'C,A')).toBe('AC');
    expect(normalizeAnswer({ ...base, type: 'judgement', options: [] } satisfies ChaoxingQuestion, '正确')).toBe('true');
    expect(() => normalizeAnswer({ ...base, type: 'single' } satisfies ChaoxingQuestion, '乙项')).toThrow('没有匹配到选项');
    expect(normalizeAnswer({ ...base, type: 'completion', options: [], answerFields: ['answer11', 'answer12'] } satisfies ChaoxingQuestion, '甲||乙')).toBe('["甲","乙"]');
  });

  it('routes specific sign and answer commands before generic commands', () => {
    expect(parseChaoxingCommand('学习通签到监听 软件工程')).toEqual({ kind: 'sign_watch', courseQuery: '软件工程' });
    expect(parseChaoxingCommand('学习通签到 900 1234')).toEqual({ kind: 'sign_execute', activityId: '900', code: '1234' });
    expect(parseChaoxingCommand('学习通答题补充 8 2 B')).toEqual({ kind: 'answer_supplement', jobId: 8, questionPosition: 2, answer: 'B' });
    expect(parseChaoxingCommand('学习通答题 软件工程')).toEqual({ kind: 'answer_start', courseQuery: '软件工程' });
  });

  it('serializes cookie-bearing work per owner while allowing different owners to proceed', async () => {
    const coordinator = new ChaoxingOwnerCoordinator();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = coordinator.run('qq:1', async () => { events.push('first-start'); await gate; events.push('first-end'); });
    const second = coordinator.run('qq:1', async () => { events.push('second'); });
    const other = coordinator.run('qq:2', async () => { events.push('other'); });
    await other;
    expect(events).toEqual(['first-start', 'other']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(['first-start', 'other', 'first-end', 'second']);
  });
});

import { describe, expect, it } from 'vitest';
import { normalizeAnswer, parseQuestionResultStatuses, parseWorkPage } from '../src/plugins/chaoxing/answer-service.js';
import { ChaoxingCookieJar, parseSetCookie } from '../src/plugins/chaoxing/cookie-jar.js';
import {
  parseActivities,
  parseAssignments,
  parseChapters,
  parseCourseList,
  parseTaskCard,
  videoProgressEnc,
} from '../src/plugins/chaoxing/client.js';
import { parseChaoxingCommand } from '../src/plugins/chaoxing/commands.js';
import { ChaoxingOwnerCoordinator } from '../src/plugins/chaoxing/owner-coordinator.js';
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
      <a href="/mooc2-ans/mycourse/studentstudy?chapterId=10&enc=chapter-enc">第一章</a>
      <a href="/mooc2-ans/mycourse/studentstudy?chapterId=10&enc=chapter-enc">第一章</a>
      <a href="/mooc2-ans/mycourse/studentstudy?chapterId=11">第二章</a>
    `, { courseId: '100', classId: '200' }, { origin: 'https://mooc2-ans.chaoxing.com', enc: 'course-enc' });
    expect(chapters).toEqual([
      expect.objectContaining({ chapterId: '10', enc: 'chapter-enc', title: '第一章' }),
      expect.objectContaining({ chapterId: '11', enc: 'course-enc', title: '第二章' }),
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

  it('uses the LearningPass video progress signature contract', () => {
    expect(videoProgressEnc('100', '200', 'job-1', 'object-1', 30, 60)).toBe('ffc8c5149a35bd3564c0fb4624c6fb3c');
  });

  it('parses assignment deadlines and sign activities', () => {
    const course = { courseId: '100', classId: '200', name: '软件工程' };
    const assignments = parseAssignments(`
      <div class="ulDiv"><ul><li>
        <a class="tit" href="/mooc-ans/work/view?workId=work-1">需求分析作业</a>
        <p>未交</p><p>截止 2026-07-20 23:59</p>
      </li></ul></div>
    `, course);
    expect(assignments).toEqual([expect.objectContaining({ remoteId: 'work-1', title: '需求分析作业', status: '未交' })]);

    const activities = parseActivities(JSON.stringify({
      result: 1,
      data: { activeList: [{ id: 900, nameOne: '课堂签到', activeType: 2, otherId: 5, status: 1, userStatus: 0, startTime: 1_721_000_000 }] },
    }), course);
    expect(activities).toEqual([expect.objectContaining({ activityId: '900', classId: '200', signTypeCode: '5', status: 1 })]);
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

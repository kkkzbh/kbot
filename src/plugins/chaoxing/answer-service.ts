import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import type { ChaoxingAuthService } from './auth-service.js';
import type { ChaoxingClient, ChaoxingTaskAttachment, ChaoxingTaskCardDefaults } from './client.js';
import type { ChaoxingTaskStore } from './store.js';
import {
  ChaoxingProtocolError,
  ChaoxingUserError,
  type ChaoxingAnswerCandidate,
  type ChaoxingCourse,
  type ChaoxingQuestion,
  type ChaoxingQuestionOption,
  type ChaoxingQuestionType,
  type OwnerIdentity,
} from './types.js';

export interface ChaoxingAnswerProvider {
  readonly id: string;
  query(question: ChaoxingQuestion): Promise<ChaoxingAnswerCandidate | null>;
}

export interface ChaoxingAnswerRuntimeConfig {
  providerUrl?: string;
  providerApiKey?: string;
  providerTimeoutMs: number;
}

export interface ChaoxingAnswerDraftEntry {
  question: ChaoxingQuestion;
  candidate: ChaoxingAnswerCandidate | null;
}

export interface ChaoxingAnswerDraft {
  workId: string;
  jobId: string;
  courseId: string;
  classId: string;
  chapterId: string;
  courseName: string;
  workUrl: string;
  submitUrl: string;
  form: Record<string, string>;
  entries: ChaoxingAnswerDraftEntry[];
}

export class ChaoxingAnswerService {
  private readonly providers: ChaoxingAnswerProvider[];

  constructor(
    private readonly authService: ChaoxingAuthService,
    private readonly client: ChaoxingClient,
    private readonly store: ChaoxingTaskStore,
    config: ChaoxingAnswerRuntimeConfig,
    providers: ChaoxingAnswerProvider[] = [],
    private readonly now: () => number = () => Date.now(),
  ) {
    this.providers = [new LocalAnswerCacheProvider(store), ...providers];
    if (config.providerUrl) this.providers.push(new HttpAnswerProvider(config.providerUrl, config.providerApiKey, config.providerTimeoutMs));
  }

  async prepareDraft(identity: OwnerIdentity, args: {
    course: ChaoxingCourse;
    chapterId: string;
    chapterOrigin: string;
    attachment: ChaoxingTaskAttachment;
    defaults: ChaoxingTaskCardDefaults;
  }): Promise<ChaoxingAnswerDraft> {
    const workId = args.attachment.jobid.replace(/^work-/u, '');
    if (!workId || !args.attachment.enc || !args.defaults.ktoken) {
      throw new ChaoxingProtocolError('work_attachment_fields', '章节测验任务缺少 workId、enc 或 ktoken。');
    }
    let auth = await this.authService.getAuthenticatedSession(identity);
    const workUrl = new URL('/mooc-ans/api/work', args.chapterOrigin);
    for (const [key, value] of Object.entries({
      api: '1', workId, jobid: args.attachment.jobid, originJobId: args.attachment.jobid, needRedirect: 'true', skipHeader: 'true',
      knowledgeid: args.chapterId, ktoken: args.defaults.ktoken, cpi: args.defaults.cpi, ut: 's', clazzId: args.course.classId,
      type: '', enc: args.attachment.enc, mooc2: '1', courseid: args.course.courseId,
    })) workUrl.searchParams.set(key, value);
    const page = await this.client.requestText(auth.cookieJar, workUrl.href, { headers: { referer: args.attachment.refererUrl } });
    await this.authService.persistCookies(auth, page.cookieJar);
    const parsed = parseWorkPage(page.text, page.url, workId);
    const entries: ChaoxingAnswerDraftEntry[] = [];
    for (const question of parsed.questions) {
      entries.push({ question, candidate: await this.queryAnswer(question) });
    }
    return {
      workId,
      jobId: args.attachment.jobid,
      courseId: args.course.courseId,
      classId: args.course.classId,
      chapterId: args.chapterId,
      courseName: args.course.name,
      workUrl: page.url,
      submitUrl: parsed.submitUrl,
      form: parsed.form,
      entries,
    };
  }

  async supplementDraft(draft: ChaoxingAnswerDraft, questionPosition: number, rawAnswer: string): Promise<ChaoxingAnswerDraft> {
    const index = questionPosition - 1;
    const entry = draft.entries[index];
    if (!entry) throw new ChaoxingUserError(`题号 ${questionPosition} 不存在。`);
    const answer = normalizeAnswer(entry.question, rawAnswer);
    const candidate = { answer, source: 'manual', confidence: 1 } satisfies ChaoxingAnswerCandidate;
    const entries = draft.entries.map((current, currentIndex) => currentIndex === index ? { ...current, candidate } : current);
    return { ...draft, entries };
  }

  async submitDraft(identity: OwnerIdentity, jobId: number, draft: ChaoxingAnswerDraft, mode: 'save' | 'submit'): Promise<{ status: string; message: string }> {
    if (draft.entries.length === 0) throw new ChaoxingUserError('章节测验没有可填写的题目。');
    const missing = draft.entries.filter((entry) => !entry.candidate);
    if (mode === 'submit' && missing.length > 0) throw new ChaoxingUserError(`仍有 ${missing.length} 道题没有答案，不能确认提交。`);
    const form: Record<string, string> = { ...draft.form, pyFlag: mode === 'save' ? '1' : '' };
    form.answerwqbid = `${draft.entries.map((entry) => entry.question.id).join(',')},`;
    for (const entry of draft.entries) {
      if (entry.question.type === 'completion') {
        const values = entry.candidate ? completionValues(entry.question, entry.candidate.answer) : entry.question.answerFields.map(() => '');
        entry.question.answerFields.forEach((field, index) => { form[field] = values[index] ?? ''; });
      } else {
        form[entry.question.answerFields[0]!] = entry.candidate?.answer ?? '';
      }
      form[`answertype${entry.question.id}`] = entry.question.typeCode;
    }
    let auth = await this.authService.getAuthenticatedSession(identity);
    const result = await this.client.postForm(auth.cookieJar, draft.submitUrl, form, draft.workUrl);
    auth = await this.authService.persistCookies(auth, result.cookieJar);
    const payload = parseSubmitResponse(result.text);
    const status = payload.success ? 'succeeded' : 'failed';
    let questionStatuses = new Map<string, QuestionResultStatus>();
    let resultMessage = payload.message;
    if (payload.success && mode === 'submit') {
      try {
        const review = await this.client.requestText(auth.cookieJar, draft.workUrl);
        auth = await this.authService.persistCookies(auth, review.cookieJar);
        questionStatuses = parseQuestionResultStatuses(review.text);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await this.store.appendJobEvent(jobId, identity.ownerKey, 'answer_review_unavailable', { workId: draft.workId, reason }, this.now());
        resultMessage = `${payload.message}；错题状态暂未读取。`;
      }
    }
    for (const entry of draft.entries) {
      if (!entry.candidate) continue;
      const questionStatus = payload.success
        ? mode === 'save' ? 'saved' : questionStatuses.get(entry.question.id) ?? 'submitted'
        : 'failed';
      await this.store.addAnswerRecord({
        ownerKey: identity.ownerKey, jobId, workId: draft.workId, questionId: entry.question.id,
        questionType: entry.question.type, title: entry.question.title, answer: entry.candidate.answer,
        source: entry.candidate.source, confidence: entry.candidate.confidence, submitMode: mode,
        resultStatus: questionStatus, resultMessage, createdAt: this.now(),
      });
      if (questionStatus === 'correct') await this.store.upsertAnswerCache(cacheRow(entry.question, entry.candidate), this.now());
      if (questionStatus === 'wrong' || questionStatus === 'partial') await this.store.removeAnswerCache(answerKey(entry.question));
    }
    if (!payload.success) throw new ChaoxingProtocolError('work_submit_rejected', payload.message, result.text.slice(0, 500));
    return { status, message: resultMessage };
  }

  private async queryAnswer(question: ChaoxingQuestion): Promise<ChaoxingAnswerCandidate | null> {
    for (const provider of this.providers) {
      const candidate = await provider.query(question);
      if (!candidate) continue;
      return { ...candidate, answer: normalizeAnswer(question, candidate.answer), source: candidate.source || provider.id, confidence: clampConfidence(candidate.confidence) };
    }
    return null;
  }
}

export class LocalAnswerCacheProvider implements ChaoxingAnswerProvider {
  readonly id = 'local-cache';
  constructor(private readonly store: ChaoxingTaskStore) {}

  async query(question: ChaoxingQuestion): Promise<ChaoxingAnswerCandidate | null> {
    const row = await this.store.getAnswerCache(answerKey(question));
    return row ? { answer: row.answer, source: row.source, confidence: row.confidence } : null;
  }
}

export class HttpAnswerProvider implements ChaoxingAnswerProvider {
  readonly id = 'http';
  constructor(private readonly url: string, private readonly apiKey: string | undefined, private readonly timeoutMs: number) {}

  async query(question: ChaoxingQuestion): Promise<ChaoxingAnswerCandidate | null> {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
      body: JSON.stringify({ question: question.title, type: question.type, options: question.options }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new ChaoxingProtocolError('answer_provider_http', `答案源请求失败（${response.status}）。`);
    const payload = await response.json() as Record<string, unknown>;
    const answer = typeof payload.answer === 'string' ? payload.answer.trim() : '';
    if (!answer) return null;
    return {
      answer,
      source: typeof payload.source === 'string' && payload.source.trim() ? payload.source.trim() : this.id,
      confidence: Number.isFinite(Number(payload.confidence)) ? Number(payload.confidence) : 0.5,
    };
  }
}

export function parseWorkPage(html: string, pageUrl: string, workId: string): { form: Record<string, string>; questions: ChaoxingQuestion[]; submitUrl: string } {
  const $ = load(html);
  if ($('#cxSecretStyle').length > 0) throw new ChaoxingProtocolError('encrypted_question_font', '该测验使用了加密字体，第一阶段暂停答题。');
  const formElement = $('form').first();
  if (formElement.length === 0) {
    if (/教师未创建完成该测验|暂无题目/u.test($.root().text())) return { form: {}, questions: [], submitUrl: new URL('/mooc-ans/work/addStudentWorkNew', pageUrl).href };
    throw new ChaoxingProtocolError('work_form_missing', '章节测验页面没有找到答题表单。', normalizeText($.root().text()).slice(0, 500));
  }
  const form: Record<string, string> = {};
  formElement.find('input[name]').each((_index, element) => {
    const name = String($(element).attr('name') ?? '').trim();
    if (!name || /^answer/u.test(name)) return;
    form[name] = String($(element).attr('value') ?? '');
  });
  const questions: ChaoxingQuestion[] = [];
  formElement.find('.singleQuesId').each((position, element) => {
    const root = $(element);
    const id = String(root.attr('data') ?? '').trim();
    const typeCode = String(root.find('.TiMu').first().attr('data') ?? '').trim();
    const type = questionType(typeCode);
    const title = normalizeText(root.find('.Zy_TItle').first().text());
    if (!id || !title) throw new ChaoxingProtocolError('question_fields_missing', `测验 ${workId} 的第 ${position + 1} 题缺少 ID 或题干。`);
    const options: ChaoxingQuestionOption[] = [];
    root.find('ul li').each((optionIndex, optionElement) => {
      const option = $(optionElement);
      const rawText = normalizeText(option.attr('aria-label') || option.text()).replace(/选择$/u, '').trim();
      const inputValue = String(option.find('input').first().attr('value') ?? '').trim();
      const key = /^[A-Z]$/u.test(inputValue) ? inputValue : rawText.match(/^([A-Z])[.、:：\s]/u)?.[1] || String.fromCharCode(65 + optionIndex);
      const text = rawText.replace(/^[A-Z][.、:：\s]+/u, '').trim();
      if (text) options.push({ key, text });
    });
    const answerPrefix = `answer${id}`;
    const answerFields = [...new Set(root.find('[name]').map((_fieldIndex, field) => String($(field).attr('name') ?? '')).get()
      .filter((name) => name === answerPrefix || new RegExp(`^${escapeRegExp(answerPrefix)}\\d+$`, 'u').test(name)))];
    questions.push({
      id, position: position + 1, type, typeCode, title, options,
      answerFields: answerFields.length > 0 ? answerFields : [answerPrefix],
    });
  });
  const action = String(formElement.attr('action') ?? '').trim();
  const submitUrl = action ? new URL(action, pageUrl).href : new URL('/mooc-ans/work/addStudentWorkNew', pageUrl).href;
  return { form, questions, submitUrl };
}

export function answerKey(question: ChaoxingQuestion): string {
  const canonical = JSON.stringify({
    type: question.type,
    title: normalizeText(question.title).toLocaleLowerCase('zh-CN'),
    options: question.options.map((option) => normalizeText(option.text).toLocaleLowerCase('zh-CN')),
    blankCount: question.answerFields.length,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export function normalizeAnswer(question: ChaoxingQuestion, rawAnswer: string): string {
  const raw = rawAnswer.trim();
  if (!raw) throw new ChaoxingUserError('答案不能为空。');
  if (question.type === 'completion') {
    const values = completionValues(question, raw);
    return values.length === 1 ? values[0]! : JSON.stringify(values);
  }
  if (question.type === 'judgement') {
    if (/^(?:true|正确|对|√|1)$/iu.test(raw)) return 'true';
    if (/^(?:false|错误|错|×|0)$/iu.test(raw)) return 'false';
    throw new ChaoxingUserError(`判断题答案无法识别：${raw}`);
  }
  const keys = resolveOptionKeys(question.options, raw);
  if (question.type === 'single') {
    if (keys.length !== 1) throw new ChaoxingUserError(`单选题需要一个选项：${raw}`);
    return keys[0]!;
  }
  if (keys.length === 0) throw new ChaoxingUserError(`多选题没有识别到选项：${raw}`);
  return [...new Set(keys)].sort().join('');
}

export type QuestionResultStatus = 'correct' | 'wrong' | 'partial' | 'submitted';

export function parseQuestionResultStatuses(html: string): Map<string, QuestionResultStatus> {
  const $ = load(html);
  const statuses = new Map<string, QuestionResultStatus>();
  $('.singleQuesId[data]').each((_index, element) => {
    const root = $(element);
    const id = String(root.attr('data') ?? '').trim();
    if (!id) return;
    if (root.find('.falseRed').length > 0) statuses.set(id, 'wrong');
    else if (root.find('.halfTrueGreen').length > 0) statuses.set(id, 'partial');
    else if (root.find('.trueGreen').length > 0) statuses.set(id, 'correct');
    else statuses.set(id, 'submitted');
  });
  return statuses;
}

export function formatWrongAnswers(rows: Array<{ title: string; answer: string; source: string; resultStatus: string; createdAt: number }>): string {
  if (rows.length === 0) return '学习通错题记录为空。';
  return `学习通错题记录（${rows.length}）：\n${rows.slice(0, 30).map((row, index) =>
    `${index + 1}. ${row.title}\n   作答：${row.answer} · 来源：${row.source} · ${row.resultStatus === 'partial' ? '部分正确' : '错误'} · ${formatDate(row.createdAt)}`,
  ).join('\n')}`;
}

export function formatAnswerDraft(jobId: number, draft: ChaoxingAnswerDraft): string {
  const answered = draft.entries.filter((entry) => entry.candidate).length;
  const lines = draft.entries.map((entry) => {
    const answer = entry.candidate ? `${entry.candidate.answer}（${entry.candidate.source}，${Math.round(entry.candidate.confidence * 100)}%）` : '缺少答案';
    return `${entry.question.position}. ${entry.question.title}\n   ${answer}`;
  });
  return `答题任务 #${jobId}：${draft.courseName}\n覆盖 ${answered}/${draft.entries.length}\n${lines.join('\n')}\n\n补充答案：学习通答题补充 ${jobId} <题号> <答案>\n只保存：学习通答题保存 ${jobId}\n确认提交：学习通答题提交 ${jobId}`;
}

function questionType(code: string): ChaoxingQuestionType {
  if (code === '0') return 'single';
  if (code === '1') return 'multiple';
  if (code === '2') return 'completion';
  if (code === '3') return 'judgement';
  throw new ChaoxingProtocolError('unsupported_question_type', `第一阶段不支持题型代码 ${code || '空'}。`);
}

function resolveOptionKeys(options: ChaoxingQuestionOption[], raw: string): string[] {
  const compact = raw.toUpperCase().replace(/[\s,，、;；]+/gu, '');
  if (/^[A-Z]+$/u.test(compact)) {
    const allowed = new Set(options.map((option) => option.key));
    const keys = [...compact].filter((key) => allowed.has(key));
    if (keys.length === compact.length) return keys;
  }
  const parts = raw.split(/[\n,，、;；]+/u).map(normalizeText).filter(Boolean);
  return parts.map((part) => {
    const exact = options.find((option) => normalizeText(option.text) === part);
    if (!exact) throw new ChaoxingUserError(`答案没有匹配到选项：${part}`);
    return exact.key;
  });
}

function parseSubmitResponse(text: string): { success: boolean; message: string } {
  try {
    const payload = JSON.parse(text) as Record<string, unknown>;
    const success = payload.status === true || Number(payload.status) === 1;
    const message = typeof payload.msg === 'string' && payload.msg.trim() ? payload.msg.trim() : success ? '操作成功。' : '学习通拒绝了答题操作。';
    return { success, message };
  } catch {
    throw new ChaoxingProtocolError('work_submit_json', '答题接口返回了无法解析的数据。', text.slice(0, 500));
  }
}

function cacheRow(question: ChaoxingQuestion, candidate: ChaoxingAnswerCandidate) {
  return {
    answerKey: answerKey(question), questionType: question.type, title: question.title, optionsJson: JSON.stringify(question.options),
    answer: candidate.answer, source: candidate.source, confidence: candidate.confidence,
  };
}

function clampConfidence(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function formatDate(value: number): string {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(value);
}

function completionValues(question: ChaoxingQuestion, rawAnswer: string): string[] {
  const count = question.answerFields.length;
  if (count <= 1) return [rawAnswer.trim()];
  let values: string[];
  if (rawAnswer.trim().startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawAnswer) as unknown;
    } catch {
      throw new ChaoxingUserError('多空填空题答案 JSON 无法解析。');
    }
    if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === 'string')) {
      throw new ChaoxingUserError('多空填空题答案必须是字符串数组。');
    }
    values = parsed.map((value) => value.trim());
  } else {
    values = rawAnswer.split(/\|\||\r?\n/u).map((value) => value.trim());
  }
  if (values.length !== count || values.some((value) => !value)) {
    throw new ChaoxingUserError(`该填空题有 ${count} 个空，请使用 JSON 字符串数组或 || 分隔 ${count} 个答案。`);
  }
  return values;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

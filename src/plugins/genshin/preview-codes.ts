import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { load } from 'cheerio';
import { z } from 'zod';

const OFFICIAL_GENSHIN_ACCOUNT_ID = '75276539';
const OFFICIAL_POSTS_URL = `https://bbs-api.mihoyo.com/painter/api/user_instant/list?offset=0&size=100&uid=${OFFICIAL_GENSHIN_ACCOUNT_ID}`;
const MIYOLIVE_INDEX_URL = 'https://api-takumi.mihoyo.com/event/miyolive/index';
const MIYOLIVE_CODES_URL = 'https://api-takumi-static.mihoyo.com/event/miyolive/refreshCode';
const PREVIEW_CACHE_SCHEMA_VERSION = 1;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_MEMORY_CACHE_TTL_MS = 60_000;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1_000;

const providerEnvelopeSchema = z.object({
  retcode: z.number(),
  message: z.string().optional().default(''),
  data: z.unknown().nullable().optional(),
});

const postListSchema = z.object({
  list: z.array(z.unknown()),
});

const postEntrySchema = z.object({
  post: z.object({
    post: z.object({
      subject: z.string(),
      structured_content: z.string(),
      created_at: z.coerce.number(),
    }).nullish(),
  }).nullish(),
});

const postSegmentSchema = z.object({
  attributes: z.object({
    link: z.string(),
  }).optional(),
});

const liveDataSchema = z.object({
  game: z.string(),
  live: z.object({
    title: z.string().min(1),
    start: z.string().min(1),
    end: z.string().min(1),
    is_end: z.boolean(),
    code_ver: z.string().min(1),
  }),
  streamer: z.object({
    aid: z.union([z.string(), z.number()]),
  }),
  template: z.string().min(1),
});

const liveTemplateSchema = z.object({
  appTitle: z.string().min(1),
  codeTipText: z.string().min(1),
});

const codeDataSchema = z.object({
  code_list: z.array(z.object({
    title: z.string(),
    code: z.string().nullish(),
  })),
});

const previewCodeSchema = z.object({
  code: z.string().min(1),
  rewards: z.string(),
});

const previewCodeInfoSchema = z.object({
  actId: z.string().min(1),
  sourceUrl: z.string().url(),
  previewTitle: z.string().min(1),
  versionTitle: z.string().min(1),
  liveTitle: z.string().min(1),
  liveStartAt: z.number(),
  liveEndAt: z.number(),
  liveEnded: z.boolean(),
  expirationText: z.string().min(1),
  expiresAt: z.number().nullable(),
  codes: z.array(previewCodeSchema).length(3),
});

const previewCacheSchema = z.object({
  schemaVersion: z.literal(PREVIEW_CACHE_SCHEMA_VERSION),
  savedAt: z.number(),
  data: previewCodeInfoSchema,
});

export type GenshinPreviewCodeInfo = z.infer<typeof previewCodeInfoSchema>;

type PreviewCodeStage = 'discover' | 'live' | 'codes' | 'cache-read' | 'cache-write';

const STAGE_LABELS: Record<PreviewCodeStage, string> = {
  discover: '获取米游社官方前瞻活动',
  live: '读取米游社前瞻版本信息',
  codes: '读取米游社前瞻兑换码',
  'cache-read': '读取本地前瞻兑换码快照',
  'cache-write': '保存本地前瞻兑换码快照',
};

export class GenshinPreviewCodeError extends Error {
  readonly stage: PreviewCodeStage;
  readonly status: number | null;
  readonly retcode: number | null;
  readonly diagnostic: string;

  constructor(
    message: string,
    options: {
      stage: PreviewCodeStage;
      status?: number | null;
      retcode?: number | null;
      diagnostic: string;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = 'GenshinPreviewCodeError';
    this.stage = options.stage;
    this.status = options.status ?? null;
    this.retcode = options.retcode ?? null;
    this.diagnostic = options.diagnostic;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

export interface GenshinPreviewCodeClientOptions {
  fetchImpl?: typeof fetch;
  cachePath?: string;
  now?: () => number;
  requestTimeoutMs?: number;
  memoryCacheTtlMs?: number;
}

interface PreviewSource {
  actId: string;
  subject: string;
  sourceUrl: string;
}

interface PreviewLiveData {
  versionTitle: string;
  liveTitle: string;
  liveStartAt: number;
  liveEndAt: number;
  liveEnded: boolean;
  expirationText: string;
  expiresAt: number | null;
  codeVersion: string;
}

export class GenshinPreviewCodeClient {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly requestTimeoutMs: number;
  private readonly memoryCacheTtlMs: number;
  private memoryCache: { data: GenshinPreviewCodeInfo; validUntil: number } | null = null;
  private diskCache: z.infer<typeof previewCacheSchema> | null | undefined;
  private pending: Promise<GenshinPreviewCodeInfo> | null = null;

  constructor(private readonly options: GenshinPreviewCodeClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.memoryCacheTtlMs = options.memoryCacheTtlMs ?? DEFAULT_MEMORY_CACHE_TTL_MS;
  }

  async queryLatest(): Promise<GenshinPreviewCodeInfo> {
    const now = this.now();
    if (this.memoryCache && now < this.memoryCache.validUntil) return this.memoryCache.data;
    if (this.pending) return this.pending;

    const pending = this.fetchLatest();
    this.pending = pending;
    try {
      const data = await pending;
      this.memoryCache = {
        data,
        validUntil: this.now() + this.memoryCacheTtlMs,
      };
      return data;
    } finally {
      this.pending = null;
    }
  }

  private async fetchLatest(): Promise<GenshinPreviewCodeInfo> {
    const source = await this.discoverSource();
    const cached = await this.loadDiskCache();
    if (cached?.data.actId === source.actId) return cached.data;

    const live = await this.fetchLiveData(source.actId);
    const codes = await this.fetchCodes(source.actId, live.codeVersion, live.liveTitle);
    const data: GenshinPreviewCodeInfo = {
      actId: source.actId,
      sourceUrl: source.sourceUrl,
      previewTitle: source.subject.replace(/预告\s*$/, '').trim(),
      versionTitle: live.versionTitle,
      liveTitle: live.liveTitle,
      liveStartAt: live.liveStartAt,
      liveEndAt: live.liveEndAt,
      liveEnded: live.liveEnded,
      expirationText: live.expirationText,
      expiresAt: live.expiresAt,
      codes,
    };
    await this.saveDiskCache(data);
    return data;
  }

  private async discoverSource(): Promise<PreviewSource> {
    const data = await this.requestProviderData('discover', OFFICIAL_POSTS_URL, {}, postListSchema);
    const candidates = data.list.flatMap((entry) => {
      const parsed = postEntrySchema.safeParse(entry);
      const post = parsed.success ? parsed.data.post?.post : null;
      if (!post || !post.subject.includes('前瞻特别节目') || !post.subject.includes('预告')) return [];
      return [post];
    }).sort((left, right) => right.created_at - left.created_at);
    const latest = candidates[0];
    if (!latest) {
      throw new GenshinPreviewCodeError('米游社官方账号最近没有发布原神前瞻直播资讯。', {
        stage: 'discover',
        retcode: 0,
        diagnostic: 'official preview announcement not found in the latest 100 posts',
      });
    }

    let segments: unknown;
    try {
      segments = JSON.parse(latest.structured_content);
    } catch (error) {
      throw malformedProviderDataError('discover', 'official preview structured_content is not JSON', error);
    }
    if (!Array.isArray(segments)) {
      throw malformedProviderDataError('discover', 'official preview structured_content is not an array');
    }
    for (const segment of segments) {
      const parsed = postSegmentSchema.safeParse(segment);
      const link = parsed.success ? parsed.data.attributes?.link : undefined;
      if (!link) continue;
      let url: URL;
      try {
        url = new URL(link);
      } catch {
        continue;
      }
      if (url.protocol !== 'https:' || url.hostname !== 'webstatic.mihoyo.com' || url.pathname !== '/bbs/event/live/index.html') continue;
      const actId = String(url.searchParams.get('act_id') ?? '').trim();
      if (!/^[A-Za-z0-9]{8,64}$/.test(actId)) continue;
      return {
        actId,
        subject: latest.subject.trim(),
        sourceUrl: `https://webstatic.mihoyo.com/bbs/event/live/index.html?act_id=${encodeURIComponent(actId)}`,
      };
    }
    throw malformedProviderDataError('discover', 'latest official preview announcement has no valid miyolive act_id');
  }

  private async fetchLiveData(actId: string): Promise<PreviewLiveData> {
    const data = await this.requestProviderData('live', MIYOLIVE_INDEX_URL, {
      headers: miyoliveHeaders(actId),
    }, liveDataSchema);
    if (data.game !== 'hk4e' || String(data.streamer.aid) !== OFFICIAL_GENSHIN_ACCOUNT_ID) {
      throw malformedProviderDataError('live', `unexpected game=${data.game} streamer=${String(data.streamer.aid)}`);
    }

    let templatePayload: unknown;
    try {
      templatePayload = JSON.parse(data.template);
    } catch (error) {
      throw malformedProviderDataError('live', 'miyolive template is not JSON', error);
    }
    const template = liveTemplateSchema.safeParse(templatePayload);
    if (!template.success) {
      throw malformedProviderDataError('live', `miyolive template schema mismatch: ${template.error.issues[0]?.message ?? 'unknown issue'}`);
    }
    const liveStartAt = parseShanghaiDateTime(data.live.start);
    const liveEndAt = parseShanghaiDateTime(data.live.end);
    if (liveStartAt == null || liveEndAt == null || liveEndAt < liveStartAt) {
      throw malformedProviderDataError('live', `invalid live window start=${data.live.start} end=${data.live.end}`);
    }

    return {
      versionTitle: template.data.appTitle.trim(),
      liveTitle: data.live.title.trim(),
      liveStartAt,
      liveEndAt,
      liveEnded: data.live.is_end,
      expirationText: template.data.codeTipText.trim(),
      expiresAt: parseExpiration(template.data.codeTipText, data.live.start),
      codeVersion: data.live.code_ver.trim(),
    };
  }

  private async fetchCodes(actId: string, codeVersion: string, liveTitle: string): Promise<GenshinPreviewCodeInfo['codes']> {
    const url = new URL(MIYOLIVE_CODES_URL);
    url.searchParams.set('version', codeVersion);
    url.searchParams.set('time', String(Math.floor(this.now() / 1_000)));
    const data = await this.requestProviderData('codes', url.href, {
      headers: miyoliveHeaders(actId),
    }, codeDataSchema);
    const issued = data.code_list.filter((entry) => String(entry.code ?? '').trim());
    if (data.code_list.length !== 3 || issued.length !== 3) {
      throw new GenshinPreviewCodeError(`${liveTitle}的 3 个兑换码尚未全部发放（当前 ${issued.length} 个），请稍后再查。`, {
        stage: 'codes',
        retcode: 0,
        diagnostic: `expected exactly 3 issued codes, slots=${data.code_list.length} issued=${issued.length}`,
      });
    }
    const codes = issued.map((entry) => ({
      code: String(entry.code).trim(),
      rewards: htmlToText(entry.title),
    }));
    if (codes.some((entry) => entry.code.length > 128 || /[\r\n]/.test(entry.code)) || new Set(codes.map((entry) => entry.code)).size !== 3) {
      throw malformedProviderDataError('codes', 'miyolive returned invalid or duplicate codes');
    }
    return codes;
  }

  private async requestProviderData<T extends z.ZodTypeAny>(
    stage: Extract<PreviewCodeStage, 'discover' | 'live' | 'codes'>,
    url: string,
    init: RequestInit,
    schema: T,
  ): Promise<z.infer<T>> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...init,
        headers: {
          accept: 'application/json',
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          ...init.headers,
        },
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (error) {
      throw new GenshinPreviewCodeError(`查询原神前瞻兑换码失败：${STAGE_LABELS[stage]}时网络请求失败，请稍后重试。`, {
        stage,
        diagnostic: `${stage} request failed: ${describeError(error)}`,
        cause: error,
      });
    }

    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      throw new GenshinPreviewCodeError(`查询原神前瞻兑换码失败：${STAGE_LABELS[stage]}时响应读取失败，请稍后重试。`, {
        stage,
        status: response.status,
        diagnostic: `${stage} response body read failed status=${response.status}: ${describeError(error)}`,
        cause: error,
      });
    }
    if (!response.ok) {
      throw new GenshinPreviewCodeError(`查询原神前瞻兑换码失败：${STAGE_LABELS[stage]}返回 HTTP ${response.status}，请稍后重试。`, {
        stage,
        status: response.status,
        diagnostic: `${stage} HTTP ${response.status} body=${clipDiagnostic(text)}`,
      });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch (error) {
      throw malformedProviderDataError(stage, `response is not JSON: ${clipDiagnostic(text)}`, error, response.status);
    }
    const envelope = providerEnvelopeSchema.safeParse(payload);
    if (!envelope.success) {
      throw malformedProviderDataError(stage, `provider envelope mismatch: ${envelope.error.issues[0]?.message ?? 'unknown issue'}`, undefined, response.status);
    }
    if (envelope.data.retcode !== 0) {
      const providerMessage = normalizeProviderMessage(envelope.data.message);
      throw new GenshinPreviewCodeError(`查询原神前瞻兑换码失败：${STAGE_LABELS[stage]}时米游社返回 retcode ${envelope.data.retcode}${providerMessage ? `（${providerMessage}）` : ''}。`, {
        stage,
        status: response.status,
        retcode: envelope.data.retcode,
        diagnostic: `${stage} retcode=${envelope.data.retcode} message=${clipDiagnostic(envelope.data.message)}`,
      });
    }
    const parsed = schema.safeParse(envelope.data.data);
    if (!parsed.success) {
      throw malformedProviderDataError(stage, `provider data mismatch: ${parsed.error.issues[0]?.message ?? 'unknown issue'}`, undefined, response.status, envelope.data.retcode);
    }
    return parsed.data;
  }

  private async loadDiskCache(): Promise<z.infer<typeof previewCacheSchema> | null> {
    if (!this.options.cachePath) return null;
    if (this.diskCache !== undefined) return this.diskCache;
    let raw: string;
    try {
      raw = await readFile(this.options.cachePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.diskCache = null;
        return null;
      }
      throw new GenshinPreviewCodeError('读取原神前瞻兑换码本地快照失败，请联系管理员检查运行目录。', {
        stage: 'cache-read',
        diagnostic: `cache read failed path=${this.options.cachePath}: ${describeError(error)}`,
        cause: error,
      });
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch (error) {
      throw new GenshinPreviewCodeError('原神前瞻兑换码本地快照已损坏，请联系管理员处理。', {
        stage: 'cache-read',
        diagnostic: `cache JSON invalid path=${this.options.cachePath}`,
        cause: error,
      });
    }
    const parsed = previewCacheSchema.safeParse(payload);
    if (!parsed.success) {
      throw new GenshinPreviewCodeError('原神前瞻兑换码本地快照格式无效，请联系管理员处理。', {
        stage: 'cache-read',
        diagnostic: `cache schema mismatch path=${this.options.cachePath}: ${parsed.error.issues[0]?.message ?? 'unknown issue'}`,
      });
    }
    this.diskCache = parsed.data;
    return parsed.data;
  }

  private async saveDiskCache(data: GenshinPreviewCodeInfo): Promise<void> {
    if (!this.options.cachePath) return;
    const snapshot = {
      schemaVersion: PREVIEW_CACHE_SCHEMA_VERSION,
      savedAt: this.now(),
      data,
    } as const;
    const cachePath = this.options.cachePath;
    const tempPath = `${cachePath}.${process.pid}.${this.now()}.tmp`;
    try {
      await mkdir(dirname(cachePath), { recursive: true });
      await writeFile(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
      await rename(tempPath, cachePath);
    } catch (error) {
      throw new GenshinPreviewCodeError('保存原神前瞻兑换码本地快照失败，请联系管理员检查运行目录。', {
        stage: 'cache-write',
        diagnostic: `cache write failed path=${cachePath}: ${describeError(error)}`,
        cause: error,
      });
    }
    this.diskCache = snapshot;
  }
}

export function formatGenshinPreviewCodeReply(data: GenshinPreviewCodeInfo, now = Date.now()): string {
  const version = data.versionTitle.match(/\d+(?:\.\d+)+/)?.[0] ?? '';
  const titleLines = version && !data.previewTitle.includes(version)
    ? [data.versionTitle, data.previewTitle]
    : [data.previewTitle];
  const liveStatus = now < data.liveStartAt
    ? `将于 ${formatShanghaiMinute(data.liveStartAt)} 开始`
    : data.liveEnded || now >= data.liveEndAt
      ? '已结束'
      : '直播中';
  const expiration = data.expiresAt == null
    ? `有效期：${data.expirationText}`
    : `兑换截止：${formatShanghaiMinute(data.expiresAt)}（UTC+8，${now >= data.expiresAt ? '已过期' : '未过期'}）`;
  const codeLines = data.codes.flatMap((entry, index) => [
    `${index + 1}. ${entry.code}`,
    ...(entry.rewards ? [`   ${entry.rewards}`] : []),
  ]);
  return [
    ...titleLines,
    `直播状态：${liveStatus}`,
    expiration,
    '',
    ...codeLines,
    '',
    '来源：米游社官方前瞻直播',
  ].join('\n');
}

function miyoliveHeaders(actId: string): Record<string, string> {
  return {
    origin: 'https://webstatic.mihoyo.com',
    referer: 'https://webstatic.mihoyo.com/',
    'x-rpc-act_id': actId,
  };
}

function parseShanghaiDateTime(value: string): number | null {
  const matched = value.trim().match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!matched) return null;
  const [, year, month, day, hour, minute, second] = matched;
  const timestamp = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}+08:00`);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function parseExpiration(text: string, liveStart: string): number | null {
  const start = liveStart.match(/^(\d{4})-(\d{2})-(\d{2}) /);
  const expiration = text.match(/(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})\s*过期/);
  if (!start || !expiration) return null;
  let year = Number(start[1]);
  const startMonthDay = Number(start[2]) * 100 + Number(start[3]);
  const expirationMonthDay = Number(expiration[1]) * 100 + Number(expiration[2]);
  if (expirationMonthDay < startMonthDay) year += 1;
  const timestamp = Date.parse(`${year}-${expiration[1]?.padStart(2, '0')}-${expiration[2]?.padStart(2, '0')}T${expiration[3]?.padStart(2, '0')}:${expiration[4]}:00+08:00`);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function formatShanghaiMinute(timestamp: number): string {
  return new Date(timestamp + SHANGHAI_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ');
}

function htmlToText(value: string): string {
  return load(value).text().replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function malformedProviderDataError(
  stage: Extract<PreviewCodeStage, 'discover' | 'live' | 'codes'>,
  diagnostic: string,
  cause?: unknown,
  status: number | null = null,
  retcode: number | null = null,
): GenshinPreviewCodeError {
  return new GenshinPreviewCodeError(`查询原神前瞻兑换码失败：${STAGE_LABELS[stage]}返回的数据不完整，请稍后重试。`, {
    stage,
    status,
    retcode,
    diagnostic,
    cause,
  });
}

function normalizeProviderMessage(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim().slice(0, 80);
}

function clipDiagnostic(value: string, limit = 500): string {
  return value.replace(/[\r\n]+/g, ' ').slice(0, limit);
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

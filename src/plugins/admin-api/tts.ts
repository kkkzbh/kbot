import { join, resolve } from 'node:path';
import type {
  AdminTtsHealthSnapshot,
  AdminTtsLocalGatewayState,
  AdminTtsStyleConfig,
} from '../../types/admin.js';

export const DEFAULT_TTS_ENV_RELATIVE = join('config', 'voice-tts.local.env');

export const TTS_LOCAL_ENV_KEYS = [
  'VOICE_TTS_PYTHON_BIN',
  'VOICE_TTS_HOST',
  'VOICE_TTS_PORT',
  'VOICE_TTS_API_KEY',
  'VOICE_TTS_DEVICE',
  'VOICE_TTS_IS_HALF',
  'VOICE_TTS_VERSION',
  'VOICE_TTS_INTERNAL_HOST',
  'VOICE_TTS_INTERNAL_PORT',
  'VOICE_TTS_LAUNCH_TIMEOUT_SECONDS',
  'VOICE_TTS_REQUEST_TIMEOUT_SECONDS',
  'VOICE_TTS_MAX_TEXT_CHARS',
  'VOICE_TTS_UPSTREAM_ROOT',
  'VOICE_TTS_PRETRAINED_ROOT',
  'VOICE_TTS_MODEL_ROOT',
  'VOICE_TTS_REFERENCE_ROOT',
  'VOICE_TTS_GPT_WEIGHTS',
  'VOICE_TTS_SOVITS_WEIGHTS',
  'VOICE_TTS_BERT_BASE',
  'VOICE_TTS_HUBERT_BASE',
  'VOICE_TTS_REF_WHITE',
  'VOICE_TTS_REF_BLACK',
  'VOICE_TTS_PROMPT_TEXT_WHITE',
  'VOICE_TTS_PROMPT_TEXT_BLACK',
  'VOICE_TTS_PROMPT_LANG',
  'VOICE_TTS_PROMPT_LANG_WHITE',
  'VOICE_TTS_PROMPT_LANG_BLACK',
  'VOICE_TTS_TEXT_LANG',
  'VOICE_TTS_MEDIA_TYPE',
  'VOICE_TTS_SPLIT_METHOD',
  'VOICE_TTS_BATCH_SIZE',
  'VOICE_TTS_PARALLEL_INFER',
] as const;

const TTS_LOCAL_ENV_KEY_SET = new Set<string>(TTS_LOCAL_ENV_KEYS);

type EnvLine =
  | { type: 'kv'; key: string; rawValue: string }
  | { type: 'other'; value: string };

function resolvePathLike(rootDir: string, pathLike: string): string {
  if (!pathLike) return '';
  return pathLike.startsWith('/') ? pathLike : resolve(rootDir, pathLike);
}

function parseEnvLines(content: string): EnvLine[] {
  return content.split(/\r?\n/).map((line) => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) return { type: 'other', value: line };
    return { type: 'kv', key: match[1], rawValue: match[2] };
  });
}

function parseEnvValue(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed
      .slice(1, -1)
      .replace(/\\n/g, '\n')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
  return trimmed;
}

function formatEnvValue(value: string): string {
  if (value === '') return '';
  if (/^[A-Za-z0-9_./,:@%+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/u, '');
}

function parseInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

export function resolveTtsEnvFilePath(rootDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.QQBOT_VOICE_TTS_ENV_FILE?.trim();
  return explicit ? resolvePathLike(rootDir, explicit) : join(rootDir, DEFAULT_TTS_ENV_RELATIVE);
}

export function createDefaultTtsLocalEnv(rootDir: string): Record<string, string> {
  const dataRoot = join(rootDir, 'data', 'voice', 'tts-local');
  const modelRoot = join(dataRoot, 'models');
  const pretrainedRoot = join(dataRoot, 'pretrained_models');
  const referenceRoot = join(dataRoot, 'references');
  return {
    VOICE_TTS_PYTHON_BIN: join(rootDir, '.venv-voice-tts', 'bin', 'python'),
    VOICE_TTS_HOST: '127.0.0.1',
    VOICE_TTS_PORT: '5162',
    VOICE_TTS_API_KEY: 'qqbot-voice-tts-token',
    VOICE_TTS_DEVICE: 'cuda',
    VOICE_TTS_IS_HALF: 'true',
    VOICE_TTS_VERSION: 'v2ProPlus',
    VOICE_TTS_INTERNAL_HOST: '127.0.0.1',
    VOICE_TTS_INTERNAL_PORT: '9880',
    VOICE_TTS_LAUNCH_TIMEOUT_SECONDS: '300',
    VOICE_TTS_REQUEST_TIMEOUT_SECONDS: '180',
    VOICE_TTS_MAX_TEXT_CHARS: '200',
    VOICE_TTS_UPSTREAM_ROOT: join(rootDir, '.runtime', 'gpt-sovits-upstream'),
    VOICE_TTS_PRETRAINED_ROOT: pretrainedRoot,
    VOICE_TTS_MODEL_ROOT: modelRoot,
    VOICE_TTS_REFERENCE_ROOT: referenceRoot,
    VOICE_TTS_GPT_WEIGHTS: join(modelRoot, 'sakiko_v2pp-e15.ckpt'),
    VOICE_TTS_SOVITS_WEIGHTS: join(modelRoot, 'sakiko_v2pp_e8_s520.pth'),
    VOICE_TTS_BERT_BASE: join(pretrainedRoot, 'chinese-roberta-wwm-ext-large'),
    VOICE_TTS_HUBERT_BASE: join(pretrainedRoot, 'chinese-hubert-base'),
    VOICE_TTS_REF_WHITE: join(referenceRoot, 'white_sakiko.wav'),
    VOICE_TTS_REF_BLACK: join(referenceRoot, 'black_sakiko.wav'),
    VOICE_TTS_PROMPT_TEXT_WHITE: 'そよさんは同級生ではありましたが、もう一人、ドラム担当の方は初対面ですわ',
    VOICE_TTS_PROMPT_TEXT_BLACK: 'では改めて、祐天寺にゃむさん、残りの人生、私にくださいませんか?',
    VOICE_TTS_PROMPT_LANG: 'all_ja',
    VOICE_TTS_TEXT_LANG: 'all_zh',
    VOICE_TTS_MEDIA_TYPE: 'wav',
    VOICE_TTS_SPLIT_METHOD: 'cut5',
    VOICE_TTS_BATCH_SIZE: '1',
    VOICE_TTS_PARALLEL_INFER: 'false',
  };
}

export function readTtsLocalEnvPatchFromContent(content: string): Partial<Record<string, string>> {
  const result: Partial<Record<string, string>> = {};
  for (const line of parseEnvLines(content)) {
    if (line.type !== 'kv' || !TTS_LOCAL_ENV_KEY_SET.has(line.key)) continue;
    result[line.key] = parseEnvValue(line.rawValue);
  }
  return result;
}

export function mergeTtsLocalEnvRecords(
  rootDir: string,
  ...records: Array<Partial<Record<string, string>>>
): Record<string, string> {
  const result = createDefaultTtsLocalEnv(rootDir);
  for (const record of records) {
    for (const [key, value] of Object.entries(record)) {
      if (!TTS_LOCAL_ENV_KEY_SET.has(key)) continue;
      result[key] = value ?? '';
    }
  }
  return result;
}

export function applyTtsLocalEnvPatchToContent(
  content: string,
  patch: Record<string, string | null | undefined>,
): string {
  for (const key of Object.keys(patch)) {
    if (!TTS_LOCAL_ENV_KEY_SET.has(key)) {
      throw new Error(`Unsupported TTS config key: ${key}`);
    }
  }

  const pending = new Map<string, string | null>();
  for (const [key, value] of Object.entries(patch)) {
    pending.set(key, value == null ? null : String(value));
  }

  const output: string[] = [];
  for (const line of parseEnvLines(content)) {
    if (line.type !== 'kv' || !pending.has(line.key)) {
      output.push(line.type === 'kv' ? `${line.key}=${line.rawValue}` : line.value);
      continue;
    }

    const nextValue = pending.get(line.key);
    pending.delete(line.key);
    if (nextValue == null) continue;
    output.push(`${line.key}=${formatEnvValue(nextValue)}`);
  }

  if (output.length && output[output.length - 1] !== '') {
    output.push('');
  }

  for (const [key, value] of pending.entries()) {
    if (value == null) continue;
    output.push(`${key}=${formatEnvValue(value)}`);
  }

  return `${output.join('\n').replace(/\n+$/g, '')}\n`;
}

export function buildTtsLocalGatewayState(input: {
  rootDir: string;
  envFile: string;
  envFileExists: boolean;
  manageable: boolean;
  env: Record<string, string>;
}): AdminTtsLocalGatewayState {
  const host = input.env.VOICE_TTS_HOST || '127.0.0.1';
  const port = parseInteger(input.env.VOICE_TTS_PORT, 5162);
  const internalHost = input.env.VOICE_TTS_INTERNAL_HOST || '127.0.0.1';
  const internalPort = parseInteger(input.env.VOICE_TTS_INTERNAL_PORT, 9880);
  const promptLang = input.env.VOICE_TTS_PROMPT_LANG || 'all_ja';
  const styles: AdminTtsStyleConfig[] = [
    {
      id: 'white',
      refAudioPath: input.env.VOICE_TTS_REF_WHITE || '',
      promptText: input.env.VOICE_TTS_PROMPT_TEXT_WHITE || '',
      promptLang: input.env.VOICE_TTS_PROMPT_LANG_WHITE || promptLang,
    },
    {
      id: 'black',
      refAudioPath: input.env.VOICE_TTS_REF_BLACK || '',
      promptText: input.env.VOICE_TTS_PROMPT_TEXT_BLACK || '',
      promptLang: input.env.VOICE_TTS_PROMPT_LANG_BLACK || promptLang,
    },
  ];

  return {
    provider: 'gpt-sovits',
    manageable: input.manageable,
    envFile: input.envFile,
    envFileExists: input.envFileExists,
    env: input.env,
    resolved: {
      baseUrl: normalizeBaseUrl(`http://${host}:${port}`),
      upstreamBaseUrl: normalizeBaseUrl(`http://${internalHost}:${internalPort}`),
      host,
      port,
      internalHost,
      internalPort,
      device: input.env.VOICE_TTS_DEVICE || 'cpu',
      isHalf: parseBoolean(input.env.VOICE_TTS_IS_HALF, false),
      version: input.env.VOICE_TTS_VERSION || 'v2ProPlus',
      textLang: input.env.VOICE_TTS_TEXT_LANG || 'all_zh',
      promptLang,
      mediaType: input.env.VOICE_TTS_MEDIA_TYPE || 'wav',
      splitMethod: input.env.VOICE_TTS_SPLIT_METHOD || 'cut5',
      batchSize: parseInteger(input.env.VOICE_TTS_BATCH_SIZE, 1),
      parallelInfer: parseBoolean(input.env.VOICE_TTS_PARALLEL_INFER, false),
      maxTextChars: parseInteger(input.env.VOICE_TTS_MAX_TEXT_CHARS, 200),
      requestTimeoutSeconds: parseInteger(input.env.VOICE_TTS_REQUEST_TIMEOUT_SECONDS, 180),
      launchTimeoutSeconds: parseInteger(input.env.VOICE_TTS_LAUNCH_TIMEOUT_SECONDS, 180),
      gptWeightsPath: input.env.VOICE_TTS_GPT_WEIGHTS || '',
      sovitsWeightsPath: input.env.VOICE_TTS_SOVITS_WEIGHTS || '',
      bertBasePath: input.env.VOICE_TTS_BERT_BASE || '',
      hubertBasePath: input.env.VOICE_TTS_HUBERT_BASE || '',
      styles,
    },
  };
}

export function resolveConfiguredTtsBaseUrl(
  botEnv: Record<string, string>,
  localGateway: AdminTtsLocalGatewayState,
): string {
  return normalizeBaseUrl(botEnv.QQ_VOICE_TTS_BASE_URL || localGateway.resolved.baseUrl);
}

export function createUnknownTtsHealth(targetBaseUrl = ''): AdminTtsHealthSnapshot {
  return {
    status: 'unknown',
    checkedAt: null,
    latencyMs: null,
    error: null,
    targetBaseUrl,
    running: null,
    upstreamHost: null,
    upstreamPort: null,
    device: null,
    isHalf: null,
    rawStatus: null,
  };
}

export function createUnreachableTtsHealth(
  targetBaseUrl: string,
  checkedAt: number,
  latencyMs: number,
  error: string,
): AdminTtsHealthSnapshot {
  return {
    ...createUnknownTtsHealth(targetBaseUrl),
    status: 'unreachable',
    checkedAt,
    latencyMs,
    error,
  };
}

export function parseTtsHealthPayload(
  targetBaseUrl: string,
  checkedAt: number,
  latencyMs: number,
  payload: unknown,
): AdminTtsHealthSnapshot {
  const record = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};
  const rawStatus = typeof record.status === 'string' ? record.status : null;
  return {
    status: rawStatus === 'ok' ? 'ok' : 'degraded',
    checkedAt,
    latencyMs,
    error: typeof record.lastError === 'string' && record.lastError ? record.lastError : null,
    targetBaseUrl,
    running: typeof record.running === 'boolean' ? record.running : null,
    upstreamHost: typeof record.upstreamHost === 'string' ? record.upstreamHost : null,
    upstreamPort: typeof record.upstreamPort === 'number' ? record.upstreamPort : null,
    device: typeof record.device === 'string' ? record.device : null,
    isHalf: typeof record.isHalf === 'boolean' ? record.isHalf : null,
    rawStatus,
  };
}

export function parseWavInfo(bytes: Uint8Array): {
  durationSeconds: number | null;
  sampleRate: number | null;
  channels: number | null;
} {
  if (bytes.byteLength < 44) {
    return { durationSeconds: null, sampleRate: null, channels: null };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const riff = String.fromCharCode(...bytes.slice(0, 4));
  const wave = String.fromCharCode(...bytes.slice(8, 12));
  if (riff !== 'RIFF' || wave !== 'WAVE') {
    return { durationSeconds: null, sampleRate: null, channels: null };
  }

  let offset = 12;
  let channels: number | null = null;
  let sampleRate: number | null = null;
  let byteRate: number | null = null;
  let dataBytes: number | null = null;

  while (offset + 8 <= bytes.byteLength) {
    const chunkId = String.fromCharCode(...bytes.slice(offset, offset + 4));
    const chunkSize = view.getUint32(offset + 4, true);
    const dataOffset = offset + 8;
    if (chunkId === 'fmt ' && dataOffset + 16 <= bytes.byteLength) {
      channels = view.getUint16(dataOffset + 2, true);
      sampleRate = view.getUint32(dataOffset + 4, true);
      byteRate = view.getUint32(dataOffset + 8, true);
    } else if (chunkId === 'data') {
      dataBytes = chunkSize;
    }
    offset = dataOffset + chunkSize + (chunkSize % 2);
  }

  return {
    durationSeconds: byteRate && dataBytes != null ? dataBytes / byteRate : null,
    sampleRate,
    channels,
  };
}

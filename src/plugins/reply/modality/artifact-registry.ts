import { isIP } from 'node:net';

export const TRUSTED_REPLY_ARTIFACT_PRODUCERS = [
  'cf_user_profile',
  'cf_user_rating',
  'hbu_jw_course_guidance_context',
] as const;

export type TrustedReplyArtifactProducer = typeof TRUSTED_REPLY_ARTIFACT_PRODUCERS[number];

export interface ReplyArtifactRegistryOptions {
  maxRuns?: number;
}

interface ImageArtifact {
  assetRef: string;
  alt: string;
}

interface CodeforcesArtifactObservation {
  tool: 'cf_user_profile' | 'cf_user_rating';
  image: ImageArtifact;
}

interface HbuGuidanceArtifactObservation {
  card: ImageArtifact & { expiresInHours: 1 };
  recommendedReplyOrder: ['card-image', 'validated-course-recommendations'];
}

const DEFAULT_MAX_RUNS = 256;
const MAX_ASSET_REF_LENGTH = 2_048;
const MAX_OBSERVATION_JSON_LENGTH = 1_000_000;
const LOCAL_STORAGE_ORIGIN = 'http://127.0.0.1:5140';
const LOCAL_STORAGE_PATH_PREFIX = '/chatluna-storage/temp/';
const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'] as const;

const TRUSTED_PRODUCERS = new Set<string>(TRUSTED_REPLY_ARTIFACT_PRODUCERS);

function requireRunId(value: string): string {
  const runId = value.trim();
  if (!runId) throw new Error('reply artifact registry requires runId.');
  return runId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function parseTopLevelObservation(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) return value;
  if (typeof value !== 'string') return null;

  const source = value.trim();
  if (source.length > MAX_OBSERVATION_JSON_LENGTH
    || !source.startsWith('{')
    || !source.endsWith('}')) return null;
  try {
    const parsed: unknown = JSON.parse(source);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isImageArtifact(value: unknown): value is ImageArtifact {
  return isRecord(value)
    && typeof value.assetRef === 'string'
    && typeof value.alt === 'string'
    && value.alt.trim().length > 0;
}

function parseCodeforcesArtifact(
  producer: Extract<TrustedReplyArtifactProducer, 'cf_user_profile' | 'cf_user_rating'>,
  observation: Record<string, unknown>,
): CodeforcesArtifactObservation | null {
  if (observation.tool !== producer || !isImageArtifact(observation.image)) return null;
  return observation as unknown as CodeforcesArtifactObservation;
}

function parseHbuGuidanceArtifact(
  observation: Record<string, unknown>,
): HbuGuidanceArtifactObservation | null {
  const card = observation.card;
  const order = observation.recommendedReplyOrder;
  if (!isRecord(card) || !isImageArtifact(card) || card.expiresInHours !== 1) return null;
  if (!Array.isArray(order)
    || order.length !== 2
    || order[0] !== 'card-image'
    || order[1] !== 'validated-course-recommendations') {
    return null;
  }
  return observation as unknown as HbuGuidanceArtifactObservation;
}

function isPrivateIpv4(hostname: string): boolean {
  const octets = hostname.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a, b] = octets as [number, number, number, number];
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || a >= 224;
}

function isPrivateIpv6(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  if (normalized === '::' || normalized === '::1') return true;
  if (normalized.startsWith('::ffff:')) return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  return /^fe[89a-f]/u.test(normalized) || normalized.startsWith('ff');
}

function isPublicHttpsHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/u, '');
  if (!normalized || normalized === 'localhost') return false;
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) return false;

  const ipVersion = isIP(normalized.replace(/^\[|\]$/gu, ''));
  if (ipVersion === 4) return !isPrivateIpv4(normalized);
  if (ipVersion === 6) return !isPrivateIpv6(normalized);
  return normalized.includes('.');
}

function isLocalStorageRef(url: URL): boolean {
  if (url.origin !== LOCAL_STORAGE_ORIGIN
    || url.username
    || url.password
    || url.search
    || url.hash
    || !url.pathname.startsWith(LOCAL_STORAGE_PATH_PREFIX)) {
    return false;
  }

  const encodedFilename = url.pathname.slice(LOCAL_STORAGE_PATH_PREFIX.length);
  if (!encodedFilename || encodedFilename.includes('/')) return false;
  try {
    const filename = decodeURIComponent(encodedFilename);
    return filename.length > 0
      && filename !== '.'
      && filename !== '..'
      && !filename.includes('/')
      && !filename.includes('\\')
      && /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(filename);
  } catch {
    return false;
  }
}

function isOpaqueAssetRef(url: URL): boolean {
  return url.protocol === 'asset:'
    && url.username.length === 0
    && url.password.length === 0
    && url.hostname.length > 0
    && url.search.length === 0
    && url.hash.length === 0
    && /^[A-Za-z0-9._~/-]+$/u.test(`${url.hostname}${url.pathname}`);
}

export function normalizeTrustedReplyAssetRef(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const assetRef = value.trim();
  if (!assetRef || assetRef.length > MAX_ASSET_REF_LENGTH) return null;

  let url: URL;
  try {
    url = new URL(assetRef);
  } catch {
    return null;
  }

  if (isOpaqueAssetRef(url)) return assetRef;
  if (url.protocol === 'http:') return isLocalStorageRef(url) ? assetRef : null;
  if (url.protocol !== 'https:' || url.username || url.password || !isPublicHttpsHost(url.hostname)) {
    return null;
  }
  return assetRef;
}

export function isTrustedReplyArtifactProducer(value: string): value is TrustedReplyArtifactProducer {
  return TRUSTED_PRODUCERS.has(value);
}

export function extractTrustedReplyArtifactRefs(
  producerName: string,
  rawObservation: unknown,
): readonly string[] {
  if (!isTrustedReplyArtifactProducer(producerName)) return [];
  const observation = parseTopLevelObservation(rawObservation);
  if (!observation) return [];

  const artifact = producerName === 'hbu_jw_course_guidance_context'
    ? parseHbuGuidanceArtifact(observation)?.card
    : parseCodeforcesArtifact(producerName, observation)?.image;
  const assetRef = normalizeTrustedReplyAssetRef(artifact?.assetRef);
  return assetRef ? [assetRef] : [];
}

export class ReplyArtifactRegistry {
  private readonly runs = new Map<string, Set<string>>();
  private readonly maxRuns: number;

  constructor(options: ReplyArtifactRegistryOptions = {}) {
    const maxRuns = options.maxRuns ?? DEFAULT_MAX_RUNS;
    if (!Number.isSafeInteger(maxRuns) || maxRuns < 1) {
      throw new Error('reply artifact registry maxRuns must be a positive safe integer.');
    }
    this.maxRuns = maxRuns;
  }

  registerObservation(
    rawRunId: string,
    producerName: string,
    observation: unknown,
  ): readonly string[] {
    const runId = requireRunId(rawRunId);
    const discovered = extractTrustedReplyArtifactRefs(producerName, observation);
    if (discovered.length === 0) return discovered;

    let refs = this.runs.get(runId);
    if (!refs) {
      refs = new Set();
      this.runs.set(runId, refs);
      this.pruneRuns();
    }
    for (const assetRef of discovered) refs.add(assetRef);
    return discovered;
  }

  has(rawRunId: string, rawAssetRef: string): boolean {
    const runId = requireRunId(rawRunId);
    const assetRef = normalizeTrustedReplyAssetRef(rawAssetRef);
    return assetRef != null && this.runs.get(runId)?.has(assetRef) === true;
  }

  list(rawRunId: string): readonly string[] {
    const runId = requireRunId(rawRunId);
    return [...(this.runs.get(runId) ?? [])];
  }

  finishRun(rawRunId: string): void {
    this.runs.delete(requireRunId(rawRunId));
  }

  private pruneRuns(): void {
    while (this.runs.size > this.maxRuns) {
      const oldestRunId = this.runs.keys().next().value as string | undefined;
      if (!oldestRunId) return;
      this.runs.delete(oldestRunId);
    }
  }
}

import { join } from 'node:path';
import type { CodexCatalogState } from '../../types/admin.js';
import {
  createProxyFetchRequest,
  formatProxyFetchFailure,
} from '../shared/proxy-fetch.js';
import { readJsonIfExists, writeJsonFile } from './state-files.js';

export const CODEX_RELEASE_METADATA_URL = 'https://api.github.com/repos/openai/codex/releases/latest';
export const CODEX_RELEASE_METADATA_TTL_MS = 60 * 60 * 1000;

export interface CodexReleaseMetadataRecord {
  schemaVersion: 1;
  version: string;
  releaseTag: string;
  etag: string;
  fetchedAt: string;
}

export class CodexReleaseMetadataError extends Error {
  readonly code = 'codex_release_metadata_unavailable';

  constructor(message: string) {
    super(message);
    this.name = 'CodexReleaseMetadataError';
  }
}

type GitHubReleasePayload = {
  tag_name?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  message?: unknown;
};

type ProviderOptions = {
  stateDir: string;
  fetchFn?: typeof fetch;
  now?: () => number;
};

function trimOptionalText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

function validateRecord(value: unknown): CodexReleaseMetadataRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Codex release metadata 状态文件必须是 JSON object。');
  }
  const record = value as Partial<CodexReleaseMetadataRecord>;
  if (record.schemaVersion !== 1) {
    throw new Error(`Codex release metadata schemaVersion 无效：${String(record.schemaVersion)}`);
  }
  const version = trimOptionalText(record.version);
  const releaseTag = trimOptionalText(record.releaseTag);
  const etag = trimOptionalText(record.etag);
  const fetchedAt = trimOptionalText(record.fetchedAt);
  if (!version || releaseTag !== `rust-v${version}` || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Codex release metadata 版本无效：${releaseTag ?? version ?? 'missing'}`);
  }
  if (!etag) {
    throw new Error('Codex release metadata 缺少 ETag。');
  }
  if (!fetchedAt || !Number.isFinite(Date.parse(fetchedAt))) {
    throw new Error('Codex release metadata fetchedAt 无效。');
  }
  return {
    schemaVersion: 1,
    version,
    releaseTag,
    etag,
    fetchedAt,
  };
}

function parseReleasePayload(payload: GitHubReleasePayload): { version: string; releaseTag: string } {
  if (payload.draft !== false) {
    throw new Error('Codex GitHub latest release 被标记为 draft。');
  }
  if (payload.prerelease !== false) {
    throw new Error('Codex GitHub latest release 被标记为 prerelease。');
  }
  const releaseTag = trimOptionalText(payload.tag_name);
  const match = releaseTag?.match(/^rust-v(\d+\.\d+\.\d+)$/);
  if (!releaseTag || !match) {
    throw new Error(`Codex GitHub release tag 无效：${releaseTag ?? 'missing'}`);
  }
  return { version: match[1], releaseTag };
}

function formatGitHubFailure(status: number, payload: GitHubReleasePayload | null): string {
  const detail = trimOptionalText(payload?.message);
  return `Codex GitHub release metadata 请求失败：HTTP ${status}${detail ? ` / ${detail}` : ''}`;
}

export class CodexReleaseMetadataProvider {
  readonly filePath: string;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private loaded = false;
  private metadata: CodexReleaseMetadataRecord | null = null;
  private error: string | null = null;
  private refreshPromise: Promise<CodexCatalogState> | null = null;

  constructor(options: ProviderOptions) {
    this.filePath = join(options.stateDir, 'codex-release-metadata.json');
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async getState(): Promise<CodexCatalogState> {
    await this.load();
    if (!this.metadata) {
      return {
        source: 'dynamic',
        status: 'unavailable',
        clientVersion: null,
        fetchedAt: null,
        error: this.error ?? 'Codex release metadata 尚未同步。',
      };
    }
    const stale = this.now() - Date.parse(this.metadata.fetchedAt) >= CODEX_RELEASE_METADATA_TTL_MS;
    return {
      source: 'dynamic',
      status: this.error || stale ? 'degraded' : 'ready',
      clientVersion: this.metadata.version,
      fetchedAt: this.metadata.fetchedAt,
      error: this.error ?? (stale ? 'Codex release metadata 已超过一小时未同步。' : null),
    };
  }

  async refresh(options: { force?: boolean } = {}): Promise<CodexCatalogState> {
    await this.load();
    if (!options.force && !this.error && this.metadata && this.isFresh(this.metadata)) {
      return this.getState();
    }
    if (!this.refreshPromise) {
      this.refreshPromise = this.fetchLatest().finally(() => {
        this.refreshPromise = null;
      });
    }
    return this.refreshPromise;
  }

  async requireFresh(options: { force?: boolean } = {}): Promise<CodexReleaseMetadataRecord> {
    const state = await this.refresh(options);
    if (state.status !== 'ready' || !this.metadata) {
      throw new CodexReleaseMetadataError(state.error ?? 'Codex release metadata 不可用。');
    }
    return this.metadata;
  }

  async requireLastKnown(): Promise<CodexReleaseMetadataRecord> {
    await this.load();
    if (this.metadata) return this.metadata;
    return this.requireFresh();
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const persisted = await readJsonIfExists<unknown>(this.filePath);
      this.metadata = persisted == null ? null : validateRecord(persisted);
    } catch (error) {
      this.error = `Codex release metadata 状态读取失败：${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private isFresh(metadata: CodexReleaseMetadataRecord): boolean {
    return this.now() - Date.parse(metadata.fetchedAt) < CODEX_RELEASE_METADATA_TTL_MS;
  }

  private async fetchLatest(): Promise<CodexCatalogState> {
    try {
      const headers: Record<string, string> = {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'qqbot-codex-release-metadata',
        'X-GitHub-Api-Version': '2022-11-28',
      };
      if (this.metadata?.etag) headers['If-None-Match'] = this.metadata.etag;
      const request = createProxyFetchRequest(CODEX_RELEASE_METADATA_URL, {
        method: 'GET',
        headers,
      });
      let response: Response;
      try {
        response = await this.fetchFn(CODEX_RELEASE_METADATA_URL, request.init);
      } catch (error) {
        throw new Error(formatProxyFetchFailure(
          'Codex GitHub release metadata 请求',
          CODEX_RELEASE_METADATA_URL,
          request.proxyUrl,
          error,
        ));
      }

      const fetchedAt = new Date(this.now()).toISOString();
      if (response.status === 304) {
        if (!this.metadata) {
          throw new Error('Codex GitHub release metadata 返回 HTTP 304，但本地没有可复用状态。');
        }
        this.metadata = { ...this.metadata, fetchedAt };
        await writeJsonFile(this.filePath, this.metadata);
        this.error = null;
        return this.getState();
      }

      let payload: GitHubReleasePayload | null = null;
      try {
        payload = await response.json() as GitHubReleasePayload;
      } catch (error) {
        if (response.ok) {
          throw new Error(`Codex GitHub release metadata 响应不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (!response.ok) {
        throw new Error(formatGitHubFailure(response.status, payload));
      }

      const parsed = parseReleasePayload(payload ?? {});
      const etag = trimOptionalText(response.headers.get('etag'));
      if (!etag) {
        throw new Error('Codex GitHub release metadata 响应缺少 ETag。');
      }
      this.metadata = {
        schemaVersion: 1,
        version: parsed.version,
        releaseTag: parsed.releaseTag,
        etag,
        fetchedAt,
      };
      await writeJsonFile(this.filePath, this.metadata);
      this.error = null;
      return this.getState();
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      return this.getState();
    }
  }
}

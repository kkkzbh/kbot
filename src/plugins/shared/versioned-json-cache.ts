import { createHash } from 'node:crypto';

export interface VersionedCacheDatabase {
  get<T = Record<string, unknown>>(table: string, query: Record<string, unknown>): Promise<T[]>;
  set(table: string, query: Record<string, unknown>, data: Record<string, unknown>): Promise<unknown>;
  create<T = Record<string, unknown>>(table: string, row: Record<string, unknown>): Promise<T>;
  remove(table: string, query: Record<string, unknown>): Promise<unknown>;
}

export interface VersionedSyncState {
  id: number;
  syncKey: string;
  ownerKey: string;
  credentialVersion: number;
  dataKind: string;
  scopeKey: string;
  lastAttemptedAt: number;
  lastSucceededAt?: number | null;
  lastFailureReason?: string | null;
  rowCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface VersionedDataItem {
  id: number;
  recordKey: string;
  ownerKey: string;
  credentialVersion: number;
  dataKind: string;
  scopeKey: string;
  position: number;
  rawJson: string;
  fetchedAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface VersionedQueryResult<T> {
  data: T;
  source: 'remote' | 'database';
  fetchedAt: number;
  failureReason?: string;
}

export class VersionedJsonCache {
  constructor(
    private readonly database: VersionedCacheDatabase,
    private readonly syncTable: string,
    private readonly itemTable: string,
    private readonly fallbackMaxAgeMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async query<T>(
    ownerKey: string,
    credentialVersion: number,
    dataKind: string,
    scopeKey: string,
    loader: () => Promise<T>,
    canFallback: (error: unknown) => boolean,
  ): Promise<VersionedQueryResult<T>> {
    const now = this.now();
    await this.writeSync(ownerKey, credentialVersion, dataKind, scopeKey, {
      lastAttemptedAt: now,
      lastFailureReason: null,
      updatedAt: now,
    }, now);
    try {
      const data = await loader();
      const rawJson = JSON.stringify(data);
      await this.database.remove(this.itemTable, { ownerKey, credentialVersion, dataKind, scopeKey });
      await this.database.create<VersionedDataItem>(this.itemTable, {
        recordKey: hashKey([ownerKey, credentialVersion, dataKind, scopeKey]),
        ownerKey,
        credentialVersion,
        dataKind,
        scopeKey,
        position: 0,
        rawJson,
        fetchedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      await this.writeSync(ownerKey, credentialVersion, dataKind, scopeKey, {
        lastAttemptedAt: now,
        lastSucceededAt: now,
        lastFailureReason: null,
        rowCount: Array.isArray(data) ? data.length : 1,
        updatedAt: now,
      }, now);
      return { data, source: 'remote', fetchedAt: now };
    } catch (error) {
      const failureReason = describeError(error);
      await this.writeSync(ownerKey, credentialVersion, dataKind, scopeKey, {
        lastAttemptedAt: now,
        lastFailureReason: failureReason,
        updatedAt: now,
      }, now);
      if (!canFallback(error)) throw error;
      const [row] = await this.database.get<VersionedDataItem>(this.itemTable, {
        ownerKey,
        credentialVersion,
        dataKind,
        scopeKey,
      });
      if (!row || now - row.fetchedAt > this.fallbackMaxAgeMs) throw error;
      return {
        data: JSON.parse(row.rawJson) as T,
        source: 'database',
        fetchedAt: row.fetchedAt,
        failureReason,
      };
    }
  }

  async clearOwner(ownerKey: string): Promise<void> {
    await Promise.all([
      this.database.remove(this.syncTable, { ownerKey }),
      this.database.remove(this.itemTable, { ownerKey }),
    ]);
  }

  private async writeSync(
    ownerKey: string,
    credentialVersion: number,
    dataKind: string,
    scopeKey: string,
    patch: Record<string, unknown>,
    now: number,
  ): Promise<void> {
    const syncKey = hashKey([ownerKey, credentialVersion, dataKind, scopeKey]);
    const [existing] = await this.database.get<VersionedSyncState>(this.syncTable, { syncKey });
    if (existing) {
      await this.database.set(this.syncTable, { id: existing.id }, patch);
      return;
    }
    await this.database.create<VersionedSyncState>(this.syncTable, {
      syncKey,
      ownerKey,
      credentialVersion,
      dataKind,
      scopeKey,
      lastAttemptedAt: Number(patch.lastAttemptedAt ?? now),
      lastSucceededAt: patch.lastSucceededAt ?? null,
      lastFailureReason: patch.lastFailureReason ?? null,
      rowCount: Number(patch.rowCount ?? 0),
      createdAt: now,
      updatedAt: now,
    });
  }
}

function hashKey(parts: Array<string | number>): string {
  return createHash('sha256').update(parts.join('\u001f')).digest('hex');
}

function describeError(error: unknown): string {
  return (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).replace(/\s+/g, ' ').slice(0, 500);
}

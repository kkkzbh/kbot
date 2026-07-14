import type { Context } from 'koishi';
import type { CampusAuthDatabase } from '../campus-auth-core/index.js';
import { VersionedJsonCache, type VersionedQueryResult } from '../shared/versioned-json-cache.js';
import { SecondClassApiError } from './types.js';

export const SECOND_CLASS_CACHE_FALLBACK_MAX_AGE_MS = 183 * 86_400_000;

export function ensureSecondClassCacheTables(ctx: Context): void {
  ctx.model.extend('hbu_second_class_sync_state', {
    id: 'unsigned', syncKey: 'string', ownerKey: 'string', credentialVersion: 'unsigned', dataKind: 'string', scopeKey: 'string',
    lastAttemptedAt: 'double', lastSucceededAt: { type: 'double', nullable: true }, lastFailureReason: { type: 'text', nullable: true },
    rowCount: 'integer', createdAt: 'double', updatedAt: 'double',
  }, { autoInc: true, unique: ['syncKey'], indexes: [['ownerKey', 'credentialVersion', 'dataKind'], ['updatedAt']] });
  ctx.model.extend('hbu_second_class_data_item', {
    id: 'unsigned', recordKey: 'string', ownerKey: 'string', credentialVersion: 'unsigned', dataKind: 'string', scopeKey: 'string',
    position: 'integer', rawJson: 'text', fetchedAt: 'double', createdAt: 'double', updatedAt: 'double',
  }, { autoInc: true, unique: ['recordKey'], indexes: [['ownerKey', 'credentialVersion', 'dataKind'], ['fetchedAt']] });
}

export class SecondClassCache {
  private readonly cache: VersionedJsonCache;

  constructor(database: CampusAuthDatabase, fallbackMaxAgeMs = SECOND_CLASS_CACHE_FALLBACK_MAX_AGE_MS) {
    this.cache = new VersionedJsonCache(database, 'hbu_second_class_sync_state', 'hbu_second_class_data_item', fallbackMaxAgeMs);
  }

  query<T>(ownerKey: string, version: number, dataKind: string, scopeKey: string, loader: () => Promise<T>): Promise<VersionedQueryResult<T>> {
    return this.cache.query(ownerKey, version, dataKind, scopeKey, loader, isTransientSecondClassFailure);
  }

  clearOwner(ownerKey: string): Promise<void> {
    return this.cache.clearOwner(ownerKey);
  }
}

function isTransientSecondClassFailure(error: unknown): boolean {
  if (error instanceof TypeError || (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name))) return true;
  return error instanceof SecondClassApiError && (error.status === 429 || error.status >= 500);
}

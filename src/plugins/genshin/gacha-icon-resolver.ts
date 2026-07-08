import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { GENSHIN_GACHA_ICON_NAMES, GENSHIN_GACHA_ICON_NAMES_BY_ITEM_NAME } from './gacha-icon-data.js';
import type { GenshinGachaRecord } from './types.js';

const CACHE_SCHEMA_VERSION = 1;
const DEFAULT_UIGF_DICT_URL = 'https://api.uigf.org/dict/genshin/chs.json';

export interface GenshinGachaResolvedIcon {
  itemId: string;
  iconName: string;
  source: 'static-name' | 'uigf-dict';
  updatedAt: number;
}

export interface GenshinGachaIconCache {
  schemaVersion: typeof CACHE_SCHEMA_VERSION;
  updatedAt: number;
  entries: Record<string, GenshinGachaResolvedIcon>;
}

export interface GenshinGachaIconResolverOptions {
  cachePath: string;
  fetchImpl?: typeof fetch;
  dictUrl?: string;
  now?: () => number;
}

export class GenshinGachaIconResolver {
  private cache: GenshinGachaIconCache | null = null;
  private dict: Record<string, unknown> | null = null;

  constructor(private readonly options: GenshinGachaIconResolverOptions) {}

  async resolveIconNames(records: GenshinGachaRecord[]): Promise<Record<string, string>> {
    const cache = await this.loadCache();
    const iconNamesByRecordKey: Record<string, string> = {};
    const missingNames = new Set<string>();
    for (const record of records) {
      const staticIconName = resolveStaticIconName(record.itemId, record.name);
      if (staticIconName) {
        iconNamesByRecordKey[record.recordKey] = staticIconName;
        continue;
      }
      const cachedIconName = cache.entries[record.name]?.iconName;
      if (cachedIconName) {
        iconNamesByRecordKey[record.recordKey] = cachedIconName;
        continue;
      }
      if (record.name.trim()) missingNames.add(record.name.trim());
    }
    if (missingNames.size === 0) return iconNamesByRecordKey;

    const resolvedByName = await this.resolveMissingNames([...missingNames], cache);
    for (const record of records) {
      const iconName = resolvedByName[record.name];
      if (iconName) iconNamesByRecordKey[record.recordKey] = iconName;
    }
    return iconNamesByRecordKey;
  }

  private async resolveMissingNames(names: string[], cache: GenshinGachaIconCache): Promise<Record<string, string>> {
    const dict = await this.fetchDict();
    if (!dict) return {};
    const resolved: Record<string, string> = {};
    let changed = false;
    for (const name of names) {
      const itemId = normalizeItemId(dict[name]);
      const iconName = itemId ? GENSHIN_GACHA_ICON_NAMES[itemId as keyof typeof GENSHIN_GACHA_ICON_NAMES] : '';
      if (!itemId || !iconName) continue;
      resolved[name] = iconName;
      cache.entries[name] = {
        itemId,
        iconName,
        source: 'uigf-dict',
        updatedAt: this.options.now?.() ?? Date.now(),
      };
      changed = true;
    }
    if (changed) {
      cache.updatedAt = this.options.now?.() ?? Date.now();
      await this.saveCache(cache);
    }
    return resolved;
  }

  private async fetchDict(): Promise<Record<string, unknown> | null> {
    if (this.dict) return this.dict;
    const fetchImpl = this.options.fetchImpl ?? fetch;
    let response: Response;
    try {
      response = await fetchImpl(this.options.dictUrl ?? DEFAULT_UIGF_DICT_URL);
    } catch {
      return null;
    }
    if (!response.ok) return null;
    try {
      const payload = await response.json();
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
      this.dict = payload as Record<string, unknown>;
      return this.dict;
    } catch {
      return null;
    }
  }

  private async loadCache(): Promise<GenshinGachaIconCache> {
    if (this.cache) return this.cache;
    try {
      const payload = JSON.parse(await readFile(this.options.cachePath, 'utf8')) as Partial<GenshinGachaIconCache>;
      if (payload.schemaVersion === CACHE_SCHEMA_VERSION && payload.entries && typeof payload.entries === 'object' && !Array.isArray(payload.entries)) {
        this.cache = {
          schemaVersion: CACHE_SCHEMA_VERSION,
          updatedAt: typeof payload.updatedAt === 'number' ? payload.updatedAt : 0,
          entries: normalizeCacheEntries(payload.entries),
        };
        return this.cache;
      }
    } catch {
      // Derived cache data can be recreated from static data and the UIGF dictionary.
    }
    this.cache = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      updatedAt: 0,
      entries: {},
    };
    return this.cache;
  }

  private async saveCache(cache: GenshinGachaIconCache): Promise<void> {
    await mkdir(dirname(this.options.cachePath), { recursive: true });
    const tempPath = `${this.options.cachePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
    await rename(tempPath, this.options.cachePath);
  }
}

function resolveStaticIconName(itemId: string, itemName: string): string {
  return GENSHIN_GACHA_ICON_NAMES[itemId as keyof typeof GENSHIN_GACHA_ICON_NAMES]
    ?? GENSHIN_GACHA_ICON_NAMES_BY_ITEM_NAME[itemName as keyof typeof GENSHIN_GACHA_ICON_NAMES_BY_ITEM_NAME]
    ?? '';
}

function normalizeItemId(value: unknown): string {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return String(value);
  const normalized = String(value ?? '').trim();
  return /^[1-9]\d*$/.test(normalized) ? normalized : '';
}

function normalizeCacheEntries(entries: Record<string, GenshinGachaResolvedIcon>): Record<string, GenshinGachaResolvedIcon> {
  return Object.fromEntries(Object.entries(entries).flatMap(([name, entry]) => {
    if (!name.trim() || !entry || typeof entry !== 'object') return [];
    const itemId = normalizeItemId(entry.itemId);
    const iconName = String(entry.iconName ?? '').trim();
    const source = entry.source === 'static-name' || entry.source === 'uigf-dict' ? entry.source : null;
    if (!itemId || !iconName || !source) return [];
    return [[name, {
      itemId,
      iconName,
      source,
      updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : 0,
    }]];
  }));
}

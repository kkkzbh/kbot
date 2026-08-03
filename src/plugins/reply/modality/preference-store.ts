import type {} from 'koishi';
import {
  DEFAULT_MODALITY_PREFERENCE,
  type ModalityPreferenceSnapshot,
} from './director.js';

export const MODALITY_PREFERENCE_TABLE = 'reply_modality_preference' as const;

const MODALITY_PREFERENCE_PRIMARY = [
  'platform',
  'botSelfId',
  'userId',
  'conversationId',
] as const;

export interface ModalityPreferenceScope {
  platform: string;
  botSelfId: string;
  userId: string;
  conversationId: string;
}

export interface ModalityPreferenceRecord extends ModalityPreferenceScope {
  voiceAutomatic: boolean;
  stickerAutomatic: boolean;
  updatedAt: number;
}

export type ModalityPreferenceDirective = Partial<ModalityPreferenceSnapshot>;

export interface ModalityPreferenceDatabase {
  get(
    table: typeof MODALITY_PREFERENCE_TABLE,
    query: ModalityPreferenceScope,
  ): Promise<ModalityPreferenceRecord[]>;
  upsert(
    table: typeof MODALITY_PREFERENCE_TABLE,
    rows: ModalityPreferenceRecord[],
    keys: Array<(typeof MODALITY_PREFERENCE_PRIMARY)[number]>,
  ): Promise<unknown>;
}

export interface ModalityPreferenceModel {
  extend(
    table: typeof MODALITY_PREFERENCE_TABLE,
    fields: Record<string, unknown>,
    config: Record<string, unknown>,
  ): unknown;
}

declare module 'koishi' {
  interface Tables {
    reply_modality_preference: ModalityPreferenceRecord;
  }
}

const FUTURE_MARKER = '(?:以后|今后|往后|从现在(?:开始|起)|接下来)';
const POLITE_MARKER = '(?:请|麻烦|拜托)';
const FUTURE_DIRECTIVE_PATTERN = new RegExp(
  `^(?:${POLITE_MARKER})?${FUTURE_MARKER}(?:${POLITE_MARKER})?(?<body>.+)$`,
  'iu',
);
const DIRECTIVE_ENDING_PATTERN = /(?:[吧啊呀啦哦呗哈了])?[。！!～~]*$/u;
const DIRECTIVE_SEPARATOR_PATTERN = /[，,；;]/u;

const VOICE_TERM = '(?:语音(?:消息)?|录音)';
const STICKER_TERM = '(?:表情包|贴图|meme|梗图)';
const MODALITY_TERM = `(?:${VOICE_TERM}|${STICKER_TERM})`;
const MODALITY_CONNECTOR = '(?:和|跟|与|、|以及|还有)';
const MODALITY_LIST = `(?<targets>${MODALITY_TERM}(?:${MODALITY_CONNECTOR}${MODALITY_TERM})*)`;
const SEND_ACTION = '(?:发|回|回复|发送|用|使用)';
const DISABLE_BEFORE_TARGETS = `(?:`
  + `(?:别|不要|不用)(?:再|总是|老是|每次都)?(?:给我)?${SEND_ACTION}`
  + `|少(?:给我)?${SEND_ACTION}(?:点|些)?`
  + `)`;
const DISABLE_AFTER_TARGETS = `(?:`
  + `(?:别|不要|不用)(?:再|总是|老是|每次都)?${SEND_ACTION}`
  + `|少${SEND_ACTION}(?:点|些)?`
  + `)`;
const ENABLE_BEFORE_TARGETS = `(?:`
  + `(?:可以|能|允许)(?:继续|再|正常|偶尔|随便)?(?:给我)?${SEND_ACTION}`
  + `|(?:恢复|重新开始|重新)(?:给我)?${SEND_ACTION}`
  + `)`;
const ENABLE_AFTER_TARGETS = `(?:`
  + `(?:可以|能|允许)(?:继续|再|正常|偶尔|随便)?${SEND_ACTION}`
  + `|(?:恢复|重新开始|重新)${SEND_ACTION}`
  + `)`;

interface PreferenceClauseGrammar {
  automatic: boolean;
  pattern: RegExp;
}

function createClausePattern(source: string): RegExp {
  return new RegExp(`^(?:也)?(?:${POLITE_MARKER})?${source}$`, 'iu');
}

// Persistent directives are an anchored future marker followed only by one or
// more explicit action/target clauses. Every clause must match this grammar.
const PREFERENCE_CLAUSE_GRAMMARS: readonly PreferenceClauseGrammar[] = [
  {
    automatic: false,
    pattern: createClausePattern(`${DISABLE_BEFORE_TARGETS}${MODALITY_LIST}`),
  },
  {
    automatic: false,
    pattern: createClausePattern(`${MODALITY_LIST}(?:都)?${DISABLE_AFTER_TARGETS}`),
  },
  {
    automatic: true,
    pattern: createClausePattern(`${ENABLE_BEFORE_TARGETS}${MODALITY_LIST}`),
  },
  {
    automatic: true,
    pattern: createClausePattern(`${MODALITY_LIST}(?:都)?${ENABLE_AFTER_TARGETS}`),
  },
];

const VOICE_TARGET_PATTERN = new RegExp(VOICE_TERM, 'iu');
const STICKER_TARGET_PATTERN = new RegExp(STICKER_TERM, 'iu');

function requireIdentity(value: string, label: keyof ModalityPreferenceScope): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`modality preference requires ${label}.`);
  return normalized;
}

function normalizeScope(scope: ModalityPreferenceScope): ModalityPreferenceScope {
  return {
    platform: requireIdentity(scope.platform, 'platform'),
    botSelfId: requireIdentity(scope.botSelfId, 'botSelfId'),
    userId: requireIdentity(scope.userId, 'userId'),
    conversationId: requireIdentity(scope.conversationId, 'conversationId'),
  };
}

export function parsePersistentModalityPreference(text: string): ModalityPreferenceDirective {
  const normalized = text.replace(/\s+/gu, '');
  const directiveMatch = FUTURE_DIRECTIVE_PATTERN.exec(normalized);
  const rawBody = directiveMatch?.groups?.body;
  if (!rawBody) return {};

  const body = rawBody.replace(DIRECTIVE_ENDING_PATTERN, '');
  const clauses = body.split(DIRECTIVE_SEPARATOR_PATTERN);
  if (clauses.length === 0 || clauses.some((clause) => !clause)) return {};

  const values = new Map<keyof ModalityPreferenceSnapshot, boolean>();
  for (const clause of clauses) {
    let parsed = false;
    for (const grammar of PREFERENCE_CLAUSE_GRAMMARS) {
      const match = grammar.pattern.exec(clause);
      const targets = match?.groups?.targets;
      if (!targets) continue;
      parsed = true;

      const fields: Array<keyof ModalityPreferenceSnapshot> = [];
      if (VOICE_TARGET_PATTERN.test(targets)) fields.push('voiceAutomatic');
      if (STICKER_TARGET_PATTERN.test(targets)) fields.push('stickerAutomatic');
      for (const field of fields) {
        const existing = values.get(field);
        if (existing != null && existing !== grammar.automatic) return {};
        values.set(field, grammar.automatic);
      }
      break;
    }
    if (!parsed) return {};
  }

  return Object.fromEntries(values) as ModalityPreferenceDirective;
}

export function registerModalityPreferenceTable(model: ModalityPreferenceModel): void {
  model.extend(
    MODALITY_PREFERENCE_TABLE,
    {
      platform: 'string',
      botSelfId: 'string',
      userId: 'string',
      conversationId: 'string',
      voiceAutomatic: 'boolean',
      stickerAutomatic: 'boolean',
      updatedAt: 'double',
    },
    {
      autoInc: false,
      primary: [...MODALITY_PREFERENCE_PRIMARY],
    },
  );
}

export class ModalityPreferenceStore {
  constructor(
    private readonly database: ModalityPreferenceDatabase,
    private readonly now: () => number = Date.now,
  ) {}

  async load(rawScope: ModalityPreferenceScope): Promise<ModalityPreferenceSnapshot> {
    const scope = normalizeScope(rawScope);
    const rows = await this.database.get(MODALITY_PREFERENCE_TABLE, scope);
    if (rows.length > 1) {
      throw new Error('modality preference primary key returned multiple records.');
    }
    const row = rows[0];
    if (!row) return { ...DEFAULT_MODALITY_PREFERENCE };
    if (typeof row.voiceAutomatic !== 'boolean' || typeof row.stickerAutomatic !== 'boolean') {
      throw new Error('modality preference record contains invalid boolean fields.');
    }
    return {
      voiceAutomatic: row.voiceAutomatic,
      stickerAutomatic: row.stickerAutomatic,
    };
  }

  async resolveForTurn(
    rawScope: ModalityPreferenceScope,
    inputText: string,
  ): Promise<ModalityPreferenceSnapshot> {
    const scope = normalizeScope(rawScope);
    const current = await this.load(scope);
    const directive = parsePersistentModalityPreference(inputText);
    if (Object.keys(directive).length === 0) return current;

    const resolved: ModalityPreferenceSnapshot = {
      ...current,
      ...directive,
    };
    if (
      resolved.voiceAutomatic === current.voiceAutomatic
      && resolved.stickerAutomatic === current.stickerAutomatic
    ) {
      return resolved;
    }

    await this.database.upsert(MODALITY_PREFERENCE_TABLE, [{
      ...scope,
      ...resolved,
      updatedAt: this.now(),
    }], [...MODALITY_PREFERENCE_PRIMARY]);
    return resolved;
  }
}

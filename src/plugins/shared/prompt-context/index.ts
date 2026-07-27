export type PromptFragmentAuthority = 'persona_core' | 'runtime_contract' | 'reference' | 'assistant_state';
export type PromptFragmentTrust = 'trusted' | 'untrusted';
export type PromptFragmentTtl = 'sticky' | 'turn';
export type PromptFragmentPayloadKind = 'text' | 'json';
export type PromptEnvelopeMessageRole = 'system' | 'human' | 'ai';

export interface PromptEnvelopeMessage {
  role: PromptEnvelopeMessageRole;
  content: string;
  additional_kwargs?: Record<string, unknown>;
}

export interface PromptFragmentPayload {
  kind: PromptFragmentPayloadKind;
  value: unknown;
}

export interface PromptFragment {
  source: string;
  title: string;
  authority: PromptFragmentAuthority;
  trust: PromptFragmentTrust;
  ttl: PromptFragmentTtl;
  payload: PromptFragmentPayload;
}

export interface CompiledPromptFragment extends PromptFragment {
  compiledOrder: number;
  content: string;
  message: PromptEnvelopeMessage;
}

export interface PromptEnvelope {
  messages: PromptEnvelopeMessage[];
  fragments: CompiledPromptFragment[];
}

export interface PromptEnvelopeInjectionTarget {
  inject: (options: {
    name: string;
    value: PromptEnvelopeMessage[];
    once?: boolean;
    conversationId?: string;
    stage?: string;
  }) => void;
}

interface RegisteredPromptFragment extends PromptFragment {
  registeredOrder: number;
}

interface PromptTurnDraft {
  fragments: RegisteredPromptFragment[];
  nextOrder: number;
  started: boolean;
  turnId: string | null;
}

const turnDrafts = new Map<string, PromptTurnDraft>();
const SOURCE_PATTERN = /^[a-z][a-z0-9_:-]*$/u;
const HEADER_CONTROL_PATTERN = /[\u0000-\u001f\u007f]/u;
const AUTHORITIES = new Set<PromptFragmentAuthority>([
  'persona_core',
  'runtime_contract',
  'reference',
  'assistant_state',
]);
const TRUST_LEVELS = new Set<PromptFragmentTrust>(['trusted', 'untrusted']);
const TTL_VALUES = new Set<PromptFragmentTtl>(['sticky', 'turn']);
const PAYLOAD_KINDS = new Set<PromptFragmentPayloadKind>(['text', 'json']);

function normalizeConversationId(conversationId: string): string {
  return conversationId.trim();
}

function ensureDraft(conversationId: string): PromptTurnDraft {
  const normalized = normalizeConversationId(conversationId);
  let draft = turnDrafts.get(normalized);
  if (!draft) {
    draft = {
      fragments: [],
      nextOrder: 0,
      started: false,
      turnId: null,
    };
    turnDrafts.set(normalized, draft);
  }
  return draft;
}

function normalizeTurnId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function createStartedDraft(turnId: string | null): PromptTurnDraft {
  return {
    fragments: [],
    nextOrder: 0,
    started: true,
    turnId,
  };
}

function normalizeSource(source: unknown): string {
  if (typeof source !== 'string') {
    throw new Error('prompt fragment source must be a string.');
  }
  const normalized = source.trim();
  if (!SOURCE_PATTERN.test(normalized)) {
    throw new Error('prompt fragment source must be a non-empty lowercase token.');
  }
  return normalized;
}

function normalizeTitle(title: unknown, source: string): string {
  if (typeof title !== 'string') {
    throw new Error(`prompt fragment ${source} title must be a string.`);
  }
  const normalized = title.trim();
  if (!normalized) {
    throw new Error(`prompt fragment ${source} title is required.`);
  }
  if (HEADER_CONTROL_PATTERN.test(normalized)) {
    throw new Error(`prompt fragment ${source} title must be a single-line label.`);
  }
  return normalized;
}

function normalizeAuthority(authority: unknown, source: string): PromptFragmentAuthority {
  if (!AUTHORITIES.has(authority as PromptFragmentAuthority)) {
    throw new Error(`prompt fragment ${source} authority is invalid.`);
  }
  return authority as PromptFragmentAuthority;
}

function normalizeTrust(trust: unknown, source: string): PromptFragmentTrust {
  if (!TRUST_LEVELS.has(trust as PromptFragmentTrust)) {
    throw new Error(`prompt fragment ${source} trust is invalid.`);
  }
  return trust as PromptFragmentTrust;
}

function normalizeTtl(ttl: unknown, source: string): PromptFragmentTtl {
  if (!TTL_VALUES.has(ttl as PromptFragmentTtl)) {
    throw new Error(`prompt fragment ${source} ttl is invalid.`);
  }
  return ttl as PromptFragmentTtl;
}

function normalizePayload(payload: unknown, source: string): PromptFragmentPayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`prompt fragment ${source} payload must be an object.`);
  }
  const record = payload as { kind?: unknown; value?: unknown };
  if (!PAYLOAD_KINDS.has(record.kind as PromptFragmentPayloadKind)) {
    throw new Error(`prompt fragment ${source} payload kind is invalid.`);
  }
  if (record.kind === 'text') {
    if (typeof record.value !== 'string') {
      throw new Error(`prompt fragment ${source} text payload must be a string.`);
    }
    const value = record.value.trim();
    if (!value) {
      throw new Error(`prompt fragment ${source} text payload is empty.`);
    }
    return {
      kind: 'text',
      value,
    };
  }
  if (!record.value || typeof record.value !== 'object' || Array.isArray(record.value)) {
    throw new Error(`prompt fragment ${source} JSON payload must be a non-array object.`);
  }
  return {
    kind: 'json',
    value: record.value,
  };
}

function normalizeFragment(fragment: PromptFragment, registeredOrder: number): RegisteredPromptFragment {
  const source = normalizeSource(fragment.source);
  return {
    source,
    title: normalizeTitle(fragment.title, source),
    authority: normalizeAuthority(fragment.authority, source),
    trust: normalizeTrust(fragment.trust, source),
    ttl: normalizeTtl(fragment.ttl, source),
    payload: normalizePayload(fragment.payload, source),
    registeredOrder,
  };
}

function authorityRank(authority: PromptFragmentAuthority): number {
  switch (authority) {
    case 'persona_core':
      return 0;
    case 'runtime_contract':
      return 1;
    case 'reference':
      return 2;
    case 'assistant_state':
      return 3;
    default:
      return 9;
  }
}

function ttlRank(ttl: PromptFragmentTtl): number {
  return ttl === 'sticky' ? 0 : 1;
}

function payloadToContent(payload: PromptFragmentPayload, source: string): string {
  if (payload.kind === 'text') {
    return payload.value as string;
  }

  try {
    const serialized = JSON.stringify(payload.value, null, 2);
    if (typeof serialized !== 'string') {
      throw new Error('JSON.stringify returned no content');
    }
    return serialized.trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`prompt fragment ${source} JSON payload must be serializable: ${message}`);
  }
}

function sectionKindForFragment(fragment: PromptFragment): PromptFragmentAuthority {
  return fragment.authority;
}

function indentBlock(content: string, prefix = '  '): string {
  return content
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

function renderFragment(fragment: PromptFragment, content: string): string {
  const payload = fragment.trust === 'untrusted'
    ? JSON.stringify(content)
    : `\n${indentBlock(content)}`;
  return [
    '[qqbot-context]',
    `kind: ${sectionKindForFragment(fragment)}`,
    `title: ${fragment.title}`,
    `trust: ${fragment.trust}`,
    `payload:${payload}`,
    '[/qqbot-context]',
  ].join('\n');
}

function messageRoleForFragment(fragment: PromptFragment): PromptEnvelopeMessageRole {
  if (fragment.authority === 'persona_core' || fragment.authority === 'runtime_contract') {
    if (fragment.trust !== 'trusted') {
      throw new Error(`prompt fragment ${fragment.source} cannot use ${fragment.authority} with untrusted content.`);
    }
    return 'system';
  }
  return 'human';
}

function fragmentIdentityKey(fragment: PromptFragment, payloadContent: string): string {
  return JSON.stringify([
    fragment.source,
    fragment.title,
    fragment.authority,
    fragment.trust,
    fragment.ttl,
    fragment.payload.kind,
    payloadContent,
  ]);
}

function compileRegisteredFragments(fragments: RegisteredPromptFragment[]): PromptEnvelope | null {
  const seenFragmentKeys = new Set<string>();
  const allFragments = fragments
    .map((fragment) => ({
      fragment,
      payloadContent: payloadToContent(fragment.payload, fragment.source),
    }))
    .filter((item) => {
      const key = fragmentIdentityKey(item.fragment, item.payloadContent);
      if (seenFragmentKeys.has(key)) return false;
      seenFragmentKeys.add(key);
      return true;
    })
    .sort((left, right) => {
      const authorityDelta = authorityRank(left.fragment.authority) - authorityRank(right.fragment.authority);
      if (authorityDelta !== 0) return authorityDelta;
      const ttlDelta = ttlRank(left.fragment.ttl) - ttlRank(right.fragment.ttl);
      if (ttlDelta !== 0) return ttlDelta;
      return left.fragment.registeredOrder - right.fragment.registeredOrder;
    });

  if (!allFragments.length) return null;

  const compiledFragments: CompiledPromptFragment[] = [];
  for (const [index, item] of allFragments.entries()) {
    const { registeredOrder: _registeredOrder, ...fragment } = item.fragment;
    const content = renderFragment(fragment, item.payloadContent);
    compiledFragments.push({
      ...fragment,
      compiledOrder: index,
      content,
      message: {
        role: messageRoleForFragment(fragment),
        content,
        additional_kwargs: {
          qqbot_context: {
            source: fragment.source,
            title: fragment.title,
            authority: fragment.authority,
            trust: fragment.trust,
            ttl: fragment.ttl,
            payload_kind: fragment.payload.kind,
          },
        },
      },
    });
  }

  if (!compiledFragments.length) return null;

  return {
    messages: compiledFragments.map((fragment) => fragment.message),
    fragments: compiledFragments,
  };
}

export function compilePromptEnvelopeFromFragments(fragments: PromptFragment[]): PromptEnvelope | null {
  const normalized = fragments.map((fragment, index) => normalizeFragment(fragment, index));
  return compileRegisteredFragments(normalized);
}

export function beginPromptAssemblyTurn(conversationId: string, options: { turnId?: string } = {}): void {
  const normalized = normalizeConversationId(conversationId);
  if (!normalized) return;
  const turnId = normalizeTurnId(options.turnId);
  const existing = turnDrafts.get(normalized);
  if (!existing) {
    turnDrafts.set(normalized, createStartedDraft(turnId));
    return;
  }

  if (existing.started && turnId && existing.turnId === turnId) {
    return;
  }

  turnDrafts.set(normalized, createStartedDraft(turnId));
}

export function clearPromptAssemblyTurn(conversationId: string): void {
  const normalized = normalizeConversationId(conversationId);
  if (!normalized) return;
  turnDrafts.delete(normalized);
}

export function registerPromptFragment(
  conversationId: string,
  fragment: PromptFragment,
): PromptFragment {
  const normalized = normalizeConversationId(conversationId);
  if (!normalized) {
    throw new Error('conversationId is required for prompt fragment registration.');
  }

  const draft = ensureDraft(normalized);
  const normalizedFragment = normalizeFragment(fragment, draft.nextOrder);
  draft.nextOrder += 1;
  draft.fragments.push(normalizedFragment);
  return normalizedFragment;
}

export function peekPromptFragments(conversationId: string): PromptFragment[] {
  const normalized = normalizeConversationId(conversationId);
  if (!normalized) return [];
  const draft = turnDrafts.get(normalized);
  if (!draft) return [];
  return draft.fragments.map(({ registeredOrder: _registeredOrder, ...fragment }) => ({ ...fragment }));
}

export function compilePromptEnvelope(conversationId: string): PromptEnvelope | null {
  const normalized = normalizeConversationId(conversationId);
  if (!normalized) return null;

  const draft = turnDrafts.get(normalized);
  if (!draft) return null;
  return compileRegisteredFragments(draft.fragments);
}

export function consumePromptEnvelope(conversationId: string): PromptEnvelope | null {
  const envelope = compilePromptEnvelope(conversationId);
  clearPromptAssemblyTurn(conversationId);
  return envelope;
}

export function injectPromptEnvelope(
  target: PromptEnvelopeInjectionTarget,
  options: {
    name: string;
    envelope: PromptEnvelope;
    conversationId: string;
    once?: boolean;
  },
): void {
  const systemMessages = options.envelope.messages.filter((message) => message.role === 'system');
  const referenceMessages = options.envelope.messages.filter((message) => message.role !== 'system');

  if (systemMessages.length > 0) {
    target.inject({
      name: `${options.name}_system`,
      value: systemMessages,
      once: options.once,
      conversationId: options.conversationId,
      stage: 'after_system_prompts',
    });
  }
  if (referenceMessages.length > 0) {
    target.inject({
      name: `${options.name}_reference`,
      value: referenceMessages,
      once: options.once,
      conversationId: options.conversationId,
      stage: 'injections',
    });
  }
}

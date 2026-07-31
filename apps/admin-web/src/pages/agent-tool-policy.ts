export interface AgentPolicyScopeSelection {
  scopeKind: 'global_default' | 'private_default' | 'private_conversation' | 'group';
  scopeId: string;
}

export interface AgentPolicyScopeSource extends AgentPolicyScopeSelection {
  title?: string | null;
  roomName?: string | null;
}

export interface AgentPolicyScopeOption extends AgentPolicyScopeSelection {
  key: string;
  label: string;
}

export interface AgentToolOverrideDraft {
  toolName: string;
  routeProfile: 'agent' | 'automation';
  enabled: boolean;
}

export interface AgentToolOverrideInput extends AgentToolOverrideDraft, AgentPolicyScopeSelection {}

export function agentPolicyScopeKey(scope: AgentPolicyScopeSelection): string {
  return `${scope.scopeKind}\u0000${scope.scopeId}`;
}

export function createAgentPolicyScopeOptions(
  ...sources: AgentPolicyScopeSource[][]
): AgentPolicyScopeOption[] {
  const options = new Map<string, AgentPolicyScopeOption>();
  for (const source of sources.flat()) {
    const key = agentPolicyScopeKey(source);
    if (options.has(key)) continue;
    options.set(key, {
      key,
      scopeKind: source.scopeKind,
      scopeId: source.scopeId,
      label: source.title || source.roomName || source.scopeId,
    });
  }
  return [...options.values()];
}

export function createAgentToolOverrideDraft(): AgentToolOverrideDraft {
  return {
    toolName: '',
    routeProfile: 'agent',
    enabled: true,
  };
}

export function canAddAgentToolOverride(
  draft: AgentToolOverrideDraft,
  scope: AgentPolicyScopeSelection | null,
): boolean {
  return draft.toolName.length > 0 && scope !== null;
}

export function hasAgentToolOverride(
  overrides: AgentToolOverrideInput[],
  draft: AgentToolOverrideDraft,
  scope: AgentPolicyScopeSelection | null,
): boolean {
  if (!scope || !draft.toolName) return false;
  return overrides.some((override) =>
    override.toolName === draft.toolName
    && override.routeProfile === draft.routeProfile
    && agentPolicyScopeKey(override) === agentPolicyScopeKey(scope));
}

export function buildAgentToolOverride(
  draft: AgentToolOverrideDraft,
  scope: AgentPolicyScopeSelection | null,
): AgentToolOverrideInput {
  if (!draft.toolName) throw new Error('添加工具覆盖前必须选择工具');
  if (!scope) throw new Error('添加工具覆盖前必须选择范围');
  return { ...draft, ...scope };
}

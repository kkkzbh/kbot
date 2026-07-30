export interface PolicyScopeSelection {
  scopeKind: string;
  scopeId: string;
}

export interface PolicyScopeSource extends PolicyScopeSelection {
  title?: string | null;
  roomName?: string | null;
}

export interface PolicyScopeOption extends PolicyScopeSelection {
  key: string;
  label: string;
}

export interface ToolOverrideDraft {
  toolName: string;
  routeProfile: string;
  enabled: boolean;
}

export interface ToolOverrideInput extends ToolOverrideDraft, PolicyScopeSelection {}

export function policyScopeKey(scope: PolicyScopeSelection): string {
  return `${scope.scopeKind}\u0000${scope.scopeId}`;
}

export function createPolicyScopeOptions(
  ...sources: PolicyScopeSource[][]
): PolicyScopeOption[] {
  const options = new Map<string, PolicyScopeOption>();
  for (const source of sources.flat()) {
    const key = policyScopeKey(source);
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

export function createToolOverrideDraft(): ToolOverrideDraft {
  return {
    toolName: '',
    routeProfile: 'agent',
    enabled: true,
  };
}

export function canAddToolOverride(
  draft: ToolOverrideDraft,
  scope: PolicyScopeSelection | null,
): boolean {
  return draft.toolName.length > 0 && scope !== null;
}

export function hasToolOverride(
  overrides: ToolOverrideInput[],
  draft: ToolOverrideDraft,
  scope: PolicyScopeSelection | null,
): boolean {
  if (!scope || !draft.toolName) return false;
  return overrides.some((override) =>
    override.toolName === draft.toolName
    && override.routeProfile === draft.routeProfile
    && policyScopeKey(override) === policyScopeKey(scope));
}

export function buildToolOverride(
  draft: ToolOverrideDraft,
  scope: PolicyScopeSelection | null,
): ToolOverrideInput {
  if (!draft.toolName) {
    throw new Error('添加工具覆盖前必须选择工具');
  }
  if (!scope) {
    throw new Error('添加工具覆盖前必须选择范围');
  }
  return { ...draft, ...scope };
}

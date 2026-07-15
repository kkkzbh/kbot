import 'koishi';
import type { Session } from 'koishi';
import type { ConversationTarget } from './feature-policy.js';

export type ToolRouteProfile = 'agent' | 'automation';

export type ToolScopeKind =
  | 'global_default'
  | 'private_default'
  | 'private_conversation'
  | 'group';

export type ToolCompatibility = 'compatible' | 'conditional' | 'incompatible';
export type ToolRiskLevel = 'low' | 'medium' | 'high';
export type ToolCatalogSource = 'project' | 'chatluna_runtime';
export type ToolCategoryKey = 'builtin' | 'file' | 'web' | 'geo';

export interface ToolCatalogEntry {
  toolName: string;
  title: string;
  category: ToolCategoryKey;
  description: string;
  compatibility: ToolCompatibility;
  compatibilityNote: string;
  hardDependencies: string[];
  relatedTools: string[];
  riskLevel: ToolRiskLevel;
  source: ToolCatalogSource;
  registered?: boolean;
  availableRoutes: ToolRouteProfile[];
  defaultEnabledByRoute: Record<ToolRouteProfile, boolean>;
}

export interface ToolRouteProfileInfo {
  id: ToolRouteProfile;
  title: string;
  description: string;
  note?: string;
}

export interface ToolScopeTarget {
  scopeKind: Extract<ToolScopeKind, 'global_default' | 'private_default'>;
  scopeId: string;
  title: string;
  description: string;
}

export interface ToolPolicyScope {
  scopeKind: ToolScopeKind;
  scopeId: string;
  roomId: number | null;
  roomName: string;
  groupId: string | null;
  conversationId: string | null;
  visibility: string | null;
  updatedAt: number | null;
}

export interface ToolOverrideRecord {
  id: number;
  toolName: string;
  routeProfile: ToolRouteProfile;
  scopeKind: ToolScopeKind;
  scopeId: string;
  enabled: number;
  updatedAt: number;
}

export interface ToolOverrideInput {
  toolName: string;
  routeProfile: ToolRouteProfile;
  scopeKind: ToolScopeKind;
  scopeId: string;
  enabled: boolean;
}

export interface ResolveAllowedToolsOptions {
  session: Session;
  routeProfile: ToolRouteProfile;
  toolNames: string[];
  room?: {
    roomId?: number | string | null;
    conversationId?: string | null;
    [key: string]: unknown;
  } | null;
}

export interface ResolveAllowedToolsResult {
  allowed: string[];
  unknown: string[];
}

export interface ToolMask {
  mode: 'all' | 'allow' | 'deny';
  allow: string[];
  deny: string[];
  toolCallMask?: ToolMask;
}

export interface AdminToolPolicyState {
  routeProfiles: ToolRouteProfile[];
  catalog: ToolCatalogEntry[];
  routeProfileInfo: ToolRouteProfileInfo[];
  defaultScopes: ToolScopeTarget[];
  scopes: ToolPolicyScope[];
  overrides: ToolOverrideRecord[];
  conversationTargets: ConversationTarget[];
}

export interface ToolPolicyServiceLike {
  getToolPolicyState(): Promise<AdminToolPolicyState>;
  getToolOverrides(): Promise<ToolOverrideRecord[]>;
  saveToolOverrides(overrides: ToolOverrideInput[]): Promise<ToolOverrideRecord[]>;
  resolveAllowedTools(options: ResolveAllowedToolsOptions): Promise<ResolveAllowedToolsResult>;
  resolveToolMask(session: Session, routeProfile: ToolRouteProfile, room?: ResolveAllowedToolsOptions['room']): Promise<ToolMask>;
}

declare module 'koishi' {
  interface Tables {
    tool_scope_override: ToolOverrideRecord;
  }

  interface Context {
    toolPolicy?: ToolPolicyServiceLike;
  }
}

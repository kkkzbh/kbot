import type {
  ModelListResponse,
  ModelOption,
  ModelTab,
  ModelTabId,
  ModelTabPatch,
  ModelTabsResponse,
} from '../../../../src/admin/contracts/index.js';

export type ModelDraft = Omit<ModelTab, 'apiKey'> & {
  apiKey: string;
  clearApiKey: boolean;
};

export type ModelDrafts = Partial<Record<ModelTabId, ModelDraft>>;
export type ModelOptionsByProvider = Partial<Record<ModelTabId, ModelOption[]>>;

export interface ModelTabsPatchRequest {
  activeTab: ModelTabId;
  tabs: ModelTabPatch[];
  dirtyTabIds: ModelTabId[];
}

export interface ModelPageConfigurationLoadResult {
  modelState: ModelTabsResponse | null;
  requiredError: string | null;
}

export function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return fallback;
}

export async function loadModelPageConfiguration(
  request: Promise<ModelTabsResponse>,
): Promise<ModelPageConfigurationLoadResult> {
  try {
    return { modelState: await request, requiredError: null };
  } catch (error) {
    return {
      modelState: null,
      requiredError: errorMessage(error, '模型配置加载失败'),
    };
  }
}

export function toModelDraft(tab: ModelTab): ModelDraft {
  return { ...tab, apiKey: '', clearApiKey: false };
}

function getDraft(drafts: ModelDrafts, id: ModelTabId): ModelDraft {
  const draft = drafts[id];
  if (!draft) throw new Error(`模型页状态缺少 ${id} 草稿。`);
  return draft;
}

function isDraftDirty(saved: ModelTab, draft: ModelDraft): boolean {
  return draft.baseUrl !== saved.baseUrl
    || draft.defaultModel !== saved.defaultModel
    || draft.reasoningEffort !== saved.reasoningEffort
    || draft.apiKey.length > 0
    || draft.clearApiKey;
}

export function dirtyModelTabIds(
  saved: ModelTabsResponse,
  drafts: ModelDrafts,
  activeTab: ModelTabId,
): ModelTabId[] {
  return saved.tabs
    .filter((tab) => {
      const draft = getDraft(drafts, tab.id);
      return isDraftDirty(tab, draft)
        || saved.activeTab !== activeTab && tab.id === activeTab;
    })
    .map((tab) => tab.id);
}

function toModelTabPatch(draft: ModelDraft): ModelTabPatch {
  const patch: ModelTabPatch = {
    id: draft.id,
    baseUrl: draft.baseUrl,
    defaultModel: draft.defaultModel,
  };
  if (draft.reasoningEffort !== undefined) patch.reasoningEffort = draft.reasoningEffort;
  if (draft.clearApiKey) patch.clearApiKey = true;
  else if (draft.apiKey) patch.apiKey = draft.apiKey;
  return patch;
}

export function buildModelTabsPatchRequest(
  saved: ModelTabsResponse,
  drafts: ModelDrafts,
  activeTab: ModelTabId,
): ModelTabsPatchRequest | null {
  const dirtyTabIds = dirtyModelTabIds(saved, drafts, activeTab);
  if (dirtyTabIds.length === 0) return null;
  return {
    activeTab,
    dirtyTabIds,
    tabs: dirtyTabIds.map((id) => toModelTabPatch(getDraft(drafts, id))),
  };
}

export function modelOptionValue(option: ModelOption): string {
  return option.canonicalModel;
}

export function requireCacheableModelOptions(result: ModelListResponse): void {
  if (result.models.length === 0 && result.error) {
    throw new Error(result.error);
  }
}

export function omitProviderModelOptions(
  options: ModelOptionsByProvider,
  provider: ModelTabId,
): ModelOptionsByProvider {
  const next = { ...options };
  delete next[provider];
  return next;
}

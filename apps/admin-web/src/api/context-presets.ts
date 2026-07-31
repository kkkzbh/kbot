import {
  contextPresetCatalogResponseSchema,
  contextPresetCreateRequestSchema,
  contextPresetDefaultRequestSchema,
  contextPresetDefaultResponseSchema,
  contextPresetDetailResponseSchema,
  contextPresetPreviewRequestSchema,
  contextPresetPreviewResponseSchema,
  contextPresetUpdateRequestSchema,
  contextSnapshotResponseSchema,
  contextTargetsResponseSchema,
  emptyResponseSchema,
  promptFragmentPolicyPutRequestSchema,
  promptFragmentPolicyResetRequestSchema,
  promptFragmentPolicyStateSchema,
  presetRevisionRequestSchema,
  rolePresetCatalogResponseSchema,
  rolePresetCreateRequestSchema,
  rolePresetDetailResponseSchema,
  rolePresetUpdateRequestSchema,
  type ContextPresetBlock,
  type ContextPresetCatalogResponse,
  type ContextPresetDefinitionV1,
  type ContextPresetDetailResponse,
  type ContextPresetPreviewResponse,
  type ContextSnapshot,
  type ContextSnapshotResponse,
  type ContextTarget,
  type ResolvedContextBlock,
  type PromptFragmentPolicyConfig,
  type PromptFragmentPolicyState,
  type RolePresetCatalogResponse,
  type RolePresetDefinitionV1,
  type RolePresetDetailResponse,
} from '@contracts';
import { api, jsonBody } from '@/api/client';

export type {
  ContextPresetBlock,
  ContextPresetCatalogResponse,
  ContextPresetDefinitionV1,
  ContextPresetDetailResponse,
  ContextPresetPreviewResponse,
  ContextSnapshot,
  ContextSnapshotResponse,
  ContextTarget,
  ResolvedContextBlock,
  PromptFragmentPolicyConfig,
  PromptFragmentPolicyState,
  RolePresetCatalogResponse,
  RolePresetDefinitionV1,
  RolePresetDetailResponse,
};

export type ContextBlockType = ResolvedContextBlock['type'];
export type StoredContextBlockType = ContextPresetBlock['type'];
export type RepeatableContextBlockType = Extract<
  StoredContextBlockType,
  'knowledge' | 'lore' | 'authorsNote'
>;
export type BudgetedContextBlock = Extract<
  ContextPresetBlock,
  { budgetPriority: number; maxTokens: number | null }
>;
export type RoleContextBlock = Extract<ContextPresetBlock, { type: 'role' }>;
export type LoreContextBlock = Extract<ContextPresetBlock, { type: 'lore' }>;
export type AuthorsNoteContextBlock = Extract<ContextPresetBlock, { type: 'authorsNote' }>;
export type KnowledgeContextBlock = Extract<ContextPresetBlock, { type: 'knowledge' }>;

function expectedRevisionQuery(expectedRevision: string): string {
  const input = presetRevisionRequestSchema.parse({ expectedRevision });
  return `?expectedRevision=${encodeURIComponent(input.expectedRevision)}`;
}

function promptFragmentRevisionQuery(expectedRevision: number): string {
  const input = promptFragmentPolicyResetRequestSchema.parse({ expectedRevision });
  return `?expectedRevision=${encodeURIComponent(String(input.expectedRevision))}`;
}
export type ModelOutputContextBlock = Extract<ContextPresetBlock, { type: 'modelOutput' }>;
export type RolePresetMessage = RolePresetDefinitionV1['messages'][number];

export async function listContextPresets(): Promise<ContextPresetCatalogResponse> {
  return api('/context-presets', contextPresetCatalogResponseSchema);
}

export async function listContextTargets(): Promise<ContextTarget[]> {
  const response = await api('/model-context/targets', contextTargetsResponseSchema);
  return response.targets;
}

export async function getContextSnapshot(
  conversationId: string,
): Promise<ContextSnapshotResponse> {
  return api(
    `/model-context/snapshots/${encodeURIComponent(conversationId)}`,
    contextSnapshotResponseSchema,
  );
}

export async function getContextPreset(id: string): Promise<ContextPresetDetailResponse> {
  return api(`/context-presets/${encodeURIComponent(id)}`, contextPresetDetailResponseSchema);
}

export async function createContextPreset(
  contextPreset: ContextPresetDefinitionV1,
): Promise<ContextPresetDetailResponse> {
  return api('/context-presets', contextPresetDetailResponseSchema, {
    method: 'POST',
    body: jsonBody(contextPresetCreateRequestSchema, { contextPreset }),
  });
}

export async function updateContextPreset(
  id: string,
  contextPreset: ContextPresetDefinitionV1,
  expectedRevision: string,
): Promise<ContextPresetDetailResponse> {
  return api(`/context-presets/${encodeURIComponent(id)}`, contextPresetDetailResponseSchema, {
    method: 'PUT',
    body: jsonBody(contextPresetUpdateRequestSchema, { contextPreset, expectedRevision }),
  });
}

export async function deleteContextPreset(id: string, expectedRevision: string): Promise<void> {
  await api(
    `/context-presets/${encodeURIComponent(id)}${expectedRevisionQuery(expectedRevision)}`,
    emptyResponseSchema,
    { method: 'DELETE' },
  );
}

export async function deleteContextPresetOverride(
  id: string,
  expectedRevision: string,
): Promise<ContextPresetDetailResponse> {
  return api(
    `/context-presets/${encodeURIComponent(id)}/override${expectedRevisionQuery(expectedRevision)}`,
    contextPresetDetailResponseSchema,
    { method: 'DELETE' },
  );
}

export async function setDefaultContextPreset(
  id: string,
): Promise<{ globalDefaultContextPresetId: string }> {
  return api('/context-presets/default', contextPresetDefaultResponseSchema, {
    method: 'PUT',
    body: jsonBody(contextPresetDefaultRequestSchema, { id }),
  });
}

export async function previewContextPreset(
  contextPreset: ContextPresetDefinitionV1,
): Promise<ContextPresetPreviewResponse> {
  return api('/context-presets/preview', contextPresetPreviewResponseSchema, {
    method: 'POST',
    body: jsonBody(contextPresetPreviewRequestSchema, { contextPreset }),
  });
}

export async function getPromptFragmentPolicy(
  contextPresetId: string,
): Promise<PromptFragmentPolicyState> {
  return api(
    `/context-presets/${encodeURIComponent(contextPresetId)}/qqbot-fragments`,
    promptFragmentPolicyStateSchema,
  );
}

export async function updatePromptFragmentPolicy(
  contextPresetId: string,
  expectedRevision: number,
  config: PromptFragmentPolicyConfig,
): Promise<PromptFragmentPolicyState> {
  return api(
    `/context-presets/${encodeURIComponent(contextPresetId)}/qqbot-fragments`,
    promptFragmentPolicyStateSchema,
    {
      method: 'PUT',
      body: jsonBody(promptFragmentPolicyPutRequestSchema, {
        expectedRevision,
        config,
      }),
    },
  );
}

export async function resetPromptFragmentPolicy(
  contextPresetId: string,
  expectedRevision: number,
): Promise<PromptFragmentPolicyState> {
  return api(
    `/context-presets/${encodeURIComponent(contextPresetId)}/qqbot-fragments${promptFragmentRevisionQuery(expectedRevision)}`,
    promptFragmentPolicyStateSchema,
    { method: 'DELETE' },
  );
}

export async function listRolePresets(): Promise<RolePresetCatalogResponse> {
  return api('/role-presets', rolePresetCatalogResponseSchema);
}

export async function getRolePreset(id: string): Promise<RolePresetDetailResponse> {
  return api(`/role-presets/${encodeURIComponent(id)}`, rolePresetDetailResponseSchema);
}

export async function createRolePreset(
  rolePreset: RolePresetDefinitionV1,
): Promise<RolePresetDetailResponse> {
  return api('/role-presets', rolePresetDetailResponseSchema, {
    method: 'POST',
    body: jsonBody(rolePresetCreateRequestSchema, { rolePreset }),
  });
}

export async function updateRolePreset(
  id: string,
  rolePreset: RolePresetDefinitionV1,
  expectedRevision: string,
): Promise<RolePresetDetailResponse> {
  return api(`/role-presets/${encodeURIComponent(id)}`, rolePresetDetailResponseSchema, {
    method: 'PUT',
    body: jsonBody(rolePresetUpdateRequestSchema, { rolePreset, expectedRevision }),
  });
}

export async function deleteRolePreset(id: string, expectedRevision: string): Promise<void> {
  await api(
    `/role-presets/${encodeURIComponent(id)}${expectedRevisionQuery(expectedRevision)}`,
    emptyResponseSchema,
    { method: 'DELETE' },
  );
}

export async function deleteRolePresetOverride(
  id: string,
  expectedRevision: string,
): Promise<RolePresetDetailResponse> {
  return api(
    `/role-presets/${encodeURIComponent(id)}/override${expectedRevisionQuery(expectedRevision)}`,
    rolePresetDetailResponseSchema,
    { method: 'DELETE' },
  );
}

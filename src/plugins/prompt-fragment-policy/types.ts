import { z } from 'zod';

export const promptFragmentPolicyConfigSchema = z.object({
  relationshipState: z.boolean(),
  attachmentReferences: z.boolean(),
  nativeCapabilities: z.boolean(),
}).strict();

export type PromptFragmentPolicyConfig = z.infer<typeof promptFragmentPolicyConfigSchema>;

export const DEFAULT_PROMPT_FRAGMENT_POLICY = Object.freeze({
  relationshipState: true,
  attachmentReferences: true,
  nativeCapabilities: true,
} satisfies PromptFragmentPolicyConfig);

export interface PromptFragmentPolicyState {
  contextPresetId: string;
  revision: number;
  source: 'default' | 'override';
  updatedAt: string | null;
  config: PromptFragmentPolicyConfig;
}

export interface PromptFragmentPolicyPutInput {
  expectedRevision: number;
  config: PromptFragmentPolicyConfig;
}

export interface PromptFragmentPolicyServiceLike {
  get(contextPresetId: string): Promise<PromptFragmentPolicyState>;
  put(
    contextPresetId: string,
    input: PromptFragmentPolicyPutInput,
  ): Promise<PromptFragmentPolicyState>;
  reset(contextPresetId: string, expectedRevision: number): Promise<PromptFragmentPolicyState>;
}

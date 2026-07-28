import { Context, Logger } from 'koishi';
import {
  PromptFragmentPolicyService,
  type PromptFragmentPolicyDatabase,
} from './service.js';
import type { PromptFragmentPolicyServiceLike } from './types.js';

export * from './service.js';
export * from './types.js';

export const name = 'prompt-fragment-policy';
export const inject = ['database'];

const logger = new Logger(name);

declare module 'koishi' {
  interface Context {
    promptFragmentPolicy?: PromptFragmentPolicyServiceLike;
  }
}

export function apply(ctx: Context): void {
  const serviceCtx = ctx as unknown as {
    database?: PromptFragmentPolicyDatabase;
    model?: { extend?: (...args: any[]) => unknown };
    provide?: (name: string) => void;
    set?: (name: string, value: unknown) => void;
  };
  if (!serviceCtx.database) {
    throw new Error('prompt-fragment-policy requires database service.');
  }
  if (typeof serviceCtx.model?.extend !== 'function') {
    throw new Error('prompt-fragment-policy requires Koishi model service.');
  }
  serviceCtx.model.extend(
    'prompt_fragment_policy',
    {
      contextPresetId: 'string',
      revision: 'unsigned',
      relationshipState: 'unsigned',
      attachmentReferences: 'unsigned',
      nativeCapabilities: 'unsigned',
      updatedAt: 'double',
    },
    {
      primary: 'contextPresetId',
      autoInc: false,
    },
  );

  const service = new PromptFragmentPolicyService(serviceCtx.database);
  if (typeof serviceCtx.provide !== 'function' || typeof serviceCtx.set !== 'function') {
    throw new Error('Koishi context cannot provide promptFragmentPolicy.');
  }
  serviceCtx.provide('promptFragmentPolicy');
  serviceCtx.set('promptFragmentPolicy', service);
  logger.info('prompt fragment policy service registered.');
}

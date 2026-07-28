import type {
  ModelBindingResolver as ChatLunaModelBindingResolver,
} from 'koishi-plugin-chatluna/llm-core/platform/binding';
import {
  CanonicalModelBindingResolver,
  type ModelBinding,
  type ModelRuntimeSnapshot,
  type ModelWorkload,
} from '../model-config/index.js';

export function createChatLunaResolver(
  snapshot: ModelRuntimeSnapshot,
): ChatLunaModelBindingResolver {
  const resolver = new CanonicalModelBindingResolver(snapshot);
  const bindings = new Map(
    snapshot.bindings.map((binding) => [binding.workload, binding]),
  );
  return (request) => {
    if (request.workload === 'chatluna.defaultEmbedding') {
      return { mode: 'disabled', revision: snapshot.revision };
    }
    if (request.workload === 'agent.subagent.default' && request.agentId) {
      const overrideWorkload = `agent.subagent.${request.agentId}` as ModelWorkload;
      const binding = bindings.get(overrideWorkload)
        ?? requireBinding(bindings, 'agent.subagent.default');
      return toChatLunaBinding(snapshot.revision, resolver, binding);
    }
    return toChatLunaBinding(
      snapshot.revision,
      resolver,
      requireBinding(bindings, request.workload),
    );
  };
}

function toChatLunaBinding(
  revision: number,
  resolver: CanonicalModelBindingResolver,
  binding: ModelBinding,
):
  | { mode: 'dedicated'; model: string; revision: number }
  | { mode: 'disabled' | 'inheritMain' | 'inheritInvocation'; revision: number } {
  if (binding.mode !== 'dedicated') {
    return { mode: binding.mode, revision };
  }
  const resolved = resolver.resolve(binding.workload);
  if (!resolved.model) {
    throw new Error(`dedicated binding ${binding.workload} has no model.`);
  }
  return {
    mode: 'dedicated',
    model: resolved.model,
    revision,
  };
}

function requireBinding(
  bindings: ReadonlyMap<ModelWorkload, ModelBinding>,
  workload: ModelWorkload,
): ModelBinding {
  const binding = bindings.get(workload);
  if (!binding) throw new Error(`missing model binding: ${workload}`);
  return binding;
}

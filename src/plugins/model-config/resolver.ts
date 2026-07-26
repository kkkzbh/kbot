import { ModelConfigError } from './errors.js';
import type {
  ConnectionDefinition,
  ModelBinding,
  ModelDefinition,
  ModelRuntimeSnapshot,
  ModelWorkload,
  RedactedResolvedBinding,
  RuntimeConnection,
} from './types.js';
import {
  requiredCapabilitiesForWorkload,
  supportsWorkloadProtocol,
} from './types.js';

export interface InvocationModelTarget {
  readonly connectionId: string;
  readonly modelId: string;
}

export interface ResolvedModelTarget {
  readonly canonicalModel: string;
  readonly connection: RuntimeConnection;
  readonly model: ModelDefinition;
}

export interface ResolvedModelBinding {
  readonly workload: ModelWorkload;
  readonly sourceWorkload: ModelWorkload;
  readonly mode: ModelBinding['mode'];
  readonly model: string | null;
  readonly revision: number;
  readonly target: ResolvedModelTarget | null;
}

export interface ResolveModelBindingContext {
  readonly invocationTarget?: InvocationModelTarget;
}

export class CanonicalModelBindingResolver {
  private readonly connections: ReadonlyMap<string, RuntimeConnection>;
  private readonly models: ReadonlyMap<string, ModelDefinition>;
  private readonly bindings: ReadonlyMap<ModelWorkload, ModelBinding>;

  constructor(private readonly snapshot: ModelRuntimeSnapshot) {
    this.connections = new Map(
      snapshot.connections.map((connection) => [connection.id, connection]),
    );
    this.models = new Map(
      snapshot.models.map((model) => [
        modelIdentity(model.connectionId, model.id),
        model,
      ]),
    );
    this.bindings = new Map(
      snapshot.bindings.map((binding) => [binding.workload, binding]),
    );
  }

  resolve(
    workload: ModelWorkload,
    context: ResolveModelBindingContext = {},
  ): ResolvedModelBinding {
    const binding = this.bindings.get(workload);
    if (!binding) {
      throw new ModelConfigError({
        code: 'binding_invalid',
        operation: 'resolve',
        stage: 'lookup',
        workload,
        message: `model binding does not exist for workload: ${workload}`,
      });
    }
    return this.resolveBinding(workload, binding, context);
  }

  resolveAgent(
    agentId: string,
    context: ResolveModelBindingContext,
  ): ResolvedModelBinding {
    const workload = `agent.subagent.${agentId}` as ModelWorkload;
    const override = this.bindings.get(workload);
    if (override) return this.resolveBinding(workload, override, context);

    const defaultBinding = this.bindings.get('agent.subagent.default');
    if (!defaultBinding) {
      throw new ModelConfigError({
        code: 'binding_invalid',
        operation: 'resolve',
        stage: 'lookup',
        workload: 'agent.subagent.default',
        message: 'default sub-agent model binding does not exist',
      });
    }
    const resolved = this.resolveBinding(
      'agent.subagent.default',
      defaultBinding,
      context,
    );
    return {
      ...resolved,
      workload,
      sourceWorkload: resolved.sourceWorkload,
    };
  }

  resolveTarget(target: InvocationModelTarget): ResolvedModelTarget {
    const connection = this.connections.get(target.connectionId);
    if (!connection) {
      throw new ModelConfigError({
        code: 'connection_not_found',
        operation: 'resolve',
        stage: 'lookup',
        connectionId: target.connectionId,
        message: `model connection does not exist: ${target.connectionId}`,
      });
    }
    const model = this.models.get(
      modelIdentity(target.connectionId, target.modelId),
    );
    if (!model) {
      throw new ModelConfigError({
        code: 'model_not_found',
        operation: 'resolve',
        stage: 'lookup',
        modelId: target.modelId,
        message: `model profile does not exist: ${target.modelId}`,
      });
    }
    return {
      canonicalModel: canonicalModelName(connection, model),
      connection,
      model,
    };
  }

  private resolveBinding(
    workload: ModelWorkload,
    binding: ModelBinding,
    context: ResolveModelBindingContext,
  ): ResolvedModelBinding {
    if (binding.mode === 'disabled') {
      return {
        workload,
        sourceWorkload: workload,
        mode: binding.mode,
        model: null,
        revision: this.snapshot.revision,
        target: null,
      };
    }
    if (binding.mode === 'dedicated') {
      const target = this.resolveTargetForWorkload(workload, binding);
      return {
        workload,
        sourceWorkload: workload,
        mode: binding.mode,
        model: target.canonicalModel,
        revision: this.snapshot.revision,
        target,
      };
    }
    if (binding.mode === 'inheritMain') {
      const mainBinding = this.bindings.get('main.chat');
      if (!mainBinding || mainBinding.mode !== 'dedicated') {
        throw new ModelConfigError({
          code: 'binding_invalid',
          operation: 'resolve',
          stage: 'validate',
          workload,
          message: `${workload} cannot inherit an invalid main.chat binding`,
        });
      }
      const target = this.resolveTargetForWorkload(workload, mainBinding);
      return {
        workload,
        sourceWorkload: 'main.chat',
        mode: binding.mode,
        model: target.canonicalModel,
        revision: this.snapshot.revision,
        target,
      };
    }

    if (!context.invocationTarget) {
      throw new ModelConfigError({
        code: 'binding_invalid',
        operation: 'resolve',
        stage: 'validate',
        workload,
        message: `${workload} requires an invocation model target`,
      });
    }
    const target = this.resolveTargetForWorkload(workload, context.invocationTarget);
    return {
      workload,
      sourceWorkload: workload,
      mode: binding.mode,
      model: target.canonicalModel,
      revision: this.snapshot.revision,
      target,
    };
  }

  private resolveTargetForWorkload(
    workload: ModelWorkload,
    reference: InvocationModelTarget,
  ): ResolvedModelTarget {
    const target = this.resolveTarget(reference);
    for (const capability of requiredCapabilitiesForWorkload(workload)) {
      if (!target.model.capabilities[capability]) {
        throw new ModelConfigError({
          code: 'binding_invalid',
          operation: 'resolve',
          stage: 'validate',
          workload,
          connectionId: target.connection.id,
          modelId: target.model.id,
          message: `${workload} requires ${capability} capability`,
        });
      }
    }
    if (!supportsWorkloadProtocol(workload, target.model)) {
      throw new ModelConfigError({
        code: 'binding_invalid',
        operation: 'resolve',
        stage: 'validate',
        workload,
        connectionId: target.connection.id,
        modelId: target.model.id,
        message: `${workload} requires a compatible typed schema protocol`,
      });
    }
    return target;
  }
}

function modelIdentity(connectionId: string, modelId: string): string {
  return `${connectionId}/${modelId}`;
}

export function canonicalModelName(
  connection: Pick<ConnectionDefinition, 'id'>,
  model: Pick<ModelDefinition, 'id'>,
): string {
  return `qqbot-${connection.id}/${model.id}`;
}

export function parseCanonicalModelName(value: string): InvocationModelTarget {
  const match = /^qqbot-([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\/([a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)$/.exec(
    value,
  );
  if (!match) {
    throw new ModelConfigError({
      code: 'model_not_found',
      operation: 'resolve',
      stage: 'parse',
      message: `invalid canonical model name: ${value.slice(0, 240)}`,
    });
  }
  return {
    connectionId: match[1],
    modelId: match[2],
  };
}

export function redactStaticBindings(
  snapshot: ModelRuntimeSnapshot,
): RedactedResolvedBinding[] {
  const resolver = new CanonicalModelBindingResolver(snapshot);
  return snapshot.bindings.map((binding) => {
    if (binding.mode === 'inheritInvocation') {
      return {
        workload: binding.workload,
        sourceWorkload: binding.workload,
        mode: binding.mode,
        revision: snapshot.revision,
        canonicalModel: null,
        connectionId: null,
        modelId: null,
      };
    }
    const resolved = resolver.resolve(binding.workload);
    return {
      workload: binding.workload,
      sourceWorkload: resolved.sourceWorkload,
      mode: resolved.mode,
      revision: resolved.revision,
      canonicalModel: resolved.model,
      connectionId: resolved.target?.connection.id ?? null,
      modelId: resolved.target?.model.id ?? null,
    };
  });
}

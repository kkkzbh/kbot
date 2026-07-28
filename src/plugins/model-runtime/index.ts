import { isAbsolute, resolve } from 'node:path';
import { Context, Logger, Schema } from 'koishi';
import type {
  ModelBindingResolver as ChatLunaModelBindingResolver,
} from 'koishi-plugin-chatluna/llm-core/platform/binding';
import {
  registerManagedOpenAIConnection,
  type ManagedOpenAIRegistration,
} from 'koishi-plugin-chatluna-openai-like-adapter';
import {
  CodexOAuthBridgeService,
} from '../codex-oauth/index.js';
import {
  CopilotOAuthBridgeService,
} from '../copilot-oauth/index.js';
import {
  CanonicalModelBindingResolver,
  ModelConfigService,
  ModelRuntimeClient,
  OpenAiConnectionExecutor,
  type ModelBinding,
  type ModelConnectionExecutor,
  type ModelRuntimeSnapshot,
  type ModelWorkload,
} from '../model-config/index.js';
import { toManagedOpenAIModel } from './managed-model.js';

export const name = 'model-runtime';
export const inject = { required: ['chatluna'] } as const;

export interface Config {
  configPath: string;
  kekPath: string;
}

export const Config: Schema<Config> = Schema.object({
  configPath: Schema.string().required().description('Canonical model config JSON path.'),
  kekPath: Schema.string().required().description('Model credential KEK path.'),
});

type ChatLunaService = {
  registerModelBindingResolver: (
    resolver: ChatLunaModelBindingResolver,
  ) => () => void;
};

type RuntimeContext = Context & {
  chatluna: ChatLunaService;
};

interface PublishedRuntime {
  modelRuntime: ModelRuntimeClient;
  codexBridge: CodexOAuthBridgeService;
  copilotBridge: CopilotOAuthBridgeService;
  disposeResolver: () => void;
  registrations: ManagedOpenAIRegistration[];
}

const logger = new Logger(name);

export async function apply(ctx: Context, config: Config): Promise<void> {
  const runtimeCtx = ctx as RuntimeContext;
  const configPath = resolveRuntimePath(ctx.baseDir, config.configPath);
  const kekPath = resolveRuntimePath(ctx.baseDir, config.kekPath);
  const envFiles = resolveBridgeEnvFiles(ctx.baseDir);
  const codexBridge = new CodexOAuthBridgeService({
    rootDir: ctx.baseDir,
    envFiles,
  });
  const copilotBridge = new CopilotOAuthBridgeService({
    rootDir: ctx.baseDir,
    envFiles,
  });
  const modelConfig = new ModelConfigService({ configPath, kekPath });
  let published: PublishedRuntime | null = null;

  let snapshot: ModelRuntimeSnapshot;
  try {
    snapshot = await modelConfig.loadAndApply(async (candidate) => {
      published = await publishRuntime(
        runtimeCtx,
        candidate,
        codexBridge,
        copilotBridge,
      );
    });
  } catch (error) {
    if (published) {
      await disposePublishedRuntime(published);
      published = null;
    }
    throw error;
  }
  if (!published) {
    throw new Error('model runtime publish completed without a runtime snapshot.');
  }
  const activeRuntime = requirePublishedRuntime(published);

  provideService(ctx, 'modelConfig', modelConfig);
  provideService(ctx, 'modelRuntime', activeRuntime.modelRuntime);
  provideService(ctx, 'codexBridge', codexBridge);
  provideService(ctx, 'copilotBridge', copilotBridge);

  ctx.on('dispose', async () => {
    await disposePublishedRuntime(activeRuntime);
    published = null;
  });

  logger.info(
    'model runtime revision %d loaded: connections=%d models=%d bindings=%d',
    snapshot.revision,
    snapshot.connections.length,
    snapshot.models.length,
    snapshot.bindings.length,
  );
}

async function publishRuntime(
  ctx: RuntimeContext,
  snapshot: ModelRuntimeSnapshot,
  codexBridge: CodexOAuthBridgeService,
  copilotBridge: CopilotOAuthBridgeService,
): Promise<PublishedRuntime> {
  const registrations: ManagedOpenAIRegistration[] = [];
  const executors = new Map<string, ModelConnectionExecutor>();
  let disposeResolver: (() => void) | null = null;

  try {
    for (const connection of snapshot.connections) {
      const models = snapshot.models.filter(
        (model) => model.connectionId === connection.id,
      );
      if (models.length === 0) continue;
      const transport = await resolveConnectionTransport(
        connection,
        codexBridge,
        copilotBridge,
      );
      executors.set(
        connection.id,
        new OpenAiConnectionExecutor({
          connectionId: connection.id,
          baseUrl: transport.baseUrl,
          apiKey: transport.apiKey,
        }),
      );
      registrations.push(await registerManagedOpenAIConnection(ctx, {
        id: connection.id,
        baseUrl: transport.baseUrl,
        apiKey: transport.apiKey ?? '',
        models: models.map(toManagedOpenAIModel),
      }));
    }

    disposeResolver = ctx.chatluna.registerModelBindingResolver(
      createChatLunaResolver(snapshot),
    );
    return {
      modelRuntime: new ModelRuntimeClient(snapshot, executors),
      codexBridge,
      copilotBridge,
      disposeResolver,
      registrations,
    };
  } catch (error) {
    disposeResolver?.();
    for (const registration of [...registrations].reverse()) {
      await registration.dispose().catch(() => undefined);
    }
    throw error;
  }
}

function createChatLunaResolver(
  snapshot: ModelRuntimeSnapshot,
): ChatLunaModelBindingResolver {
  const resolver = new CanonicalModelBindingResolver(snapshot);
  const bindings = new Map(
    snapshot.bindings.map((binding) => [binding.workload, binding]),
  );
  return (request) => {
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

async function resolveConnectionTransport(
  connection: ModelRuntimeSnapshot['connections'][number],
  codexBridge: CodexOAuthBridgeService,
  copilotBridge: CopilotOAuthBridgeService,
): Promise<{ baseUrl: string; apiKey: string | null }> {
  if (connection.adapter === 'codexBridge') {
    return codexBridge.getRuntimeConfig();
  }
  if (connection.adapter === 'copilotBridge') {
    return copilotBridge.getRuntimeConfig();
  }
  if (!connection.baseUrl) {
    throw new Error(`openaiCompatible connection ${connection.id} has no baseUrl.`);
  }
  return {
    baseUrl: connection.baseUrl,
    apiKey: connection.apiKey,
  };
}

function resolveRuntimePath(rootDir: string, path: string): string {
  return isAbsolute(path) ? path : resolve(rootDir, path);
}

function resolveBridgeEnvFiles(rootDir: string): {
  mode: 'single' | 'layered';
  baseFilePath: string | null;
  overrideFilePath: string | null;
  editTarget: string;
} {
  const base = process.env.QQBOT_ENV_BASE_FILE?.trim();
  const override = process.env.QQBOT_ENV_OVERRIDE_FILE?.trim();
  if (base || override) {
    if (!base || !override) {
      throw new Error(
        'QQBOT_ENV_BASE_FILE and QQBOT_ENV_OVERRIDE_FILE must both be set for layered runtime.',
      );
    }
    return {
      mode: 'layered',
      baseFilePath: resolveRuntimePath(rootDir, base),
      overrideFilePath: resolveRuntimePath(rootDir, override),
      editTarget: resolveRuntimePath(rootDir, override),
    };
  }
  const single = resolveRuntimePath(
    rootDir,
    process.env.QQBOT_ENV_FILE?.trim() || '.env.local',
  );
  return {
    mode: 'single',
    baseFilePath: single,
    overrideFilePath: null,
    editTarget: single,
  };
}

function provideService(ctx: Context, name: string, value: unknown): void {
  const provider = ctx as Context & {
    provide?: (name: string) => void;
    set?: (name: string, value: unknown) => void;
  };
  if (typeof provider.provide !== 'function' || typeof provider.set !== 'function') {
    throw new Error(`Koishi context cannot provide ${name}.`);
  }
  provider.provide(name);
  provider.set(name, value);
}

function requirePublishedRuntime(
  value: PublishedRuntime | null,
): PublishedRuntime {
  if (!value) {
    throw new Error('model runtime publish result is unavailable.');
  }
  return value;
}

async function disposePublishedRuntime(runtime: PublishedRuntime): Promise<void> {
  runtime.disposeResolver();
  for (const registration of [...runtime.registrations].reverse()) {
    await registration.dispose();
  }
}

#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  open,
  readFile,
  rename,
  writeFile,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { z } from 'zod';
import {
  modelConfigDocumentSchema,
  type ModelConfigDocument,
} from '../plugins/model-config/types.js';

const v2CapabilitiesSchema = z.object({
  chat: z.boolean(),
  embedding: z.boolean(),
  vision: z.boolean(),
  tools: z.boolean(),
  structuredOutput: z.boolean(),
}).strict();

const v2ModelSchema = z.object({
  id: z.string().min(1),
  connectionId: z.string().min(1),
  displayName: z.string().min(1),
  transportModel: z.string().min(1),
  modelType: z.enum(['chat', 'embedding']),
  contextSize: z.number().int().positive(),
  requestMode: z.enum(['chat_completions', 'responses']).nullable(),
  structuredOutputProtocol: z.enum([
    'native_chat_json_schema',
    'native_responses_json_schema',
    'chat_reply_v1',
    'json_mode',
  ]).nullable(),
  capabilities: v2CapabilitiesSchema,
  timeoutMs: z.number().int().positive(),
  requestDefaults: z.record(z.string(), z.unknown()),
}).strict();

const v2DocumentSchema = z.object({
  schemaVersion: z.literal(2),
  savedRevision: z.number().int().positive(),
  appliedRevision: z.number().int().nonnegative(),
  updatedAt: z.string().datetime(),
  migration: z.object({
    completedAt: z.string().datetime(),
    sourceVersion: z.string().min(1),
    reportHash: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict().nullable(),
  connections: z.array(z.unknown()),
  models: z.array(v2ModelSchema),
  bindings: z.array(z.object({
    workload: z.string().min(1),
    mode: z.enum(['dedicated', 'disabled', 'inheritMain', 'inheritInvocation']),
    connectionId: z.string().min(1).optional(),
    modelId: z.string().min(1).optional(),
  }).strict()),
  secrets: z.array(z.unknown()),
}).strict();

const reportSchema = z.object({
  schemaVersion: z.literal(1),
  operation: z.literal('model-config-v2-to-v3'),
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  sourceRevision: z.number().int().positive(),
  targetRevision: z.number().int().positive(),
  retainedConnections: z.number().int().nonnegative(),
  retainedChatModels: z.array(z.string()),
  removedEmbeddingModels: z.array(z.string()),
  removedWorkloads: z.array(z.literal('memory.embedding')),
  generatedAt: z.string().datetime(),
}).strict();

export type ModelConfigV3CutoverReport = z.infer<typeof reportSchema>;

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableReportHash(report: ModelConfigV3CutoverReport): string {
  return sha256(JSON.stringify({
    operation: report.operation,
    sourceDigest: report.sourceDigest,
    sourceRevision: report.sourceRevision,
    targetRevision: report.targetRevision,
    retainedConnections: report.retainedConnections,
    retainedChatModels: report.retainedChatModels,
    removedEmbeddingModels: report.removedEmbeddingModels,
    removedWorkloads: report.removedWorkloads,
  }));
}

function assertTargetStopped(): void {
  const result = spawnSync('systemctl', ['is-active', '--quiet', 'qqbot.target'], {
    stdio: 'ignore',
  });
  if (result.status === 0) {
    throw new Error('qqbot.target must be stopped before applying Model Config V3.');
  }
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const handle = await open(
    temporaryPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, path);
  const directory = await open(dirname(path), constants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function readV2(path: string): Promise<{
  raw: string;
  document: z.infer<typeof v2DocumentSchema>;
}> {
  const raw = await readFile(path, 'utf8');
  return {
    raw,
    document: v2DocumentSchema.parse(JSON.parse(raw)),
  };
}

export function buildModelConfigV3(
  input: z.infer<typeof v2DocumentSchema>,
  report: ModelConfigV3CutoverReport,
): ModelConfigDocument {
  const target = {
    schemaVersion: 3 as const,
    savedRevision: report.targetRevision,
    appliedRevision: input.appliedRevision,
    updatedAt: new Date().toISOString(),
    migration: {
      completedAt: new Date().toISOString(),
      sourceVersion: 'model-config-v2',
      reportHash: stableReportHash(report),
    },
    connections: input.connections,
    models: input.models
      .filter((model) => model.modelType === 'chat')
      .map((model) => {
        if (!model.capabilities.chat || model.capabilities.embedding) {
          throw new Error(`chat model has contradictory V2 capabilities: ${model.connectionId}/${model.id}`);
        }
        if (model.requestMode === null) {
          throw new Error(`chat model is missing requestMode: ${model.connectionId}/${model.id}`);
        }
        return {
          id: model.id,
          connectionId: model.connectionId,
          displayName: model.displayName,
          transportModel: model.transportModel,
          contextSize: model.contextSize,
          requestMode: model.requestMode,
          structuredOutputProtocol: model.structuredOutputProtocol,
          capabilities: {
            vision: model.capabilities.vision,
            tools: model.capabilities.tools,
            structuredOutput: model.capabilities.structuredOutput,
          },
          timeoutMs: model.timeoutMs,
          requestDefaults: model.requestDefaults,
        };
      }),
    bindings: input.bindings.filter((binding) => binding.workload !== 'memory.embedding'),
    secrets: input.secrets,
  };
  return modelConfigDocumentSchema.parse(target);
}

export async function preflightModelConfigV3(
  configPath: string,
): Promise<ModelConfigV3CutoverReport> {
  const { raw, document } = await readV2(configPath);
  const embeddingModels = document.models.filter((model) => model.modelType === 'embedding');
  const embeddingIdentities = new Set(
    embeddingModels.map((model) => `${model.connectionId}/${model.id}`),
  );
  const embeddingBindings = document.bindings.filter(
    (binding) => binding.workload === 'memory.embedding',
  );
  if (embeddingBindings.length !== 1) {
    throw new Error('Model Config V2 must contain exactly one memory.embedding binding.');
  }
  for (const binding of document.bindings) {
    if (binding.workload === 'memory.embedding') continue;
    if (
      binding.mode === 'dedicated'
      && embeddingIdentities.has(`${binding.connectionId}/${binding.modelId}`)
    ) {
      throw new Error(`non-memory workload references an embedding profile: ${binding.workload}`);
    }
  }
  const report: ModelConfigV3CutoverReport = {
    schemaVersion: 1,
    operation: 'model-config-v2-to-v3',
    sourceDigest: sha256(raw),
    sourceRevision: document.savedRevision,
    targetRevision: document.savedRevision + 1,
    retainedConnections: document.connections.length,
    retainedChatModels: document.models
      .filter((model) => model.modelType === 'chat')
      .map((model) => `${model.connectionId}/${model.id}`)
      .sort(),
    removedEmbeddingModels: [...embeddingIdentities].sort(),
    removedWorkloads: ['memory.embedding'],
    generatedAt: new Date().toISOString(),
  };
  buildModelConfigV3(document, report);
  return report;
}

export async function applyModelConfigV3(
  configPath: string,
  expected: ModelConfigV3CutoverReport,
): Promise<ModelConfigDocument> {
  assertTargetStopped();
  const report = await preflightModelConfigV3(configPath);
  if (
    report.sourceDigest !== expected.sourceDigest
    || report.sourceRevision !== expected.sourceRevision
    || report.targetRevision !== expected.targetRevision
    || JSON.stringify(report.removedEmbeddingModels) !== JSON.stringify(expected.removedEmbeddingModels)
  ) {
    throw new Error('Model Config changed after V3 preflight.');
  }
  const { document } = await readV2(configPath);
  const target = buildModelConfigV3(document, expected);
  await writeAtomic(configPath, `${JSON.stringify(target, null, 2)}\n`);
  await chmod(configPath, 0o600);
  return target;
}

function parseArgs(argv: string[]): {
  command: 'preflight' | 'apply';
  configPath: string;
  reportPath: string;
} {
  const [command, ...rest] = argv;
  if (command !== 'preflight' && command !== 'apply') {
    throw new Error('Usage: model-config-v3-cutover.mjs <preflight|apply> --config <path> --report <path>');
  }
  let configPath = '';
  let reportPath = '';
  for (let index = 0; index < rest.length; index += 2) {
    const option = rest[index];
    const value = rest[index + 1];
    if (!value) throw new Error(`${option} requires a value`);
    if (option === '--config') configPath = resolve(value);
    else if (option === '--report') reportPath = resolve(value);
    else throw new Error(`unknown option: ${option}`);
  }
  if (!configPath || !reportPath) throw new Error('--config and --report are required');
  return { command, configPath, reportPath };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'preflight') {
    const report = await preflightModelConfigV3(args.configPath);
    await writeFile(args.reportPath, `${JSON.stringify(report, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return;
  }
  const report = reportSchema.parse(JSON.parse(await readFile(args.reportPath, 'utf8')));
  const target = await applyModelConfigV3(args.configPath, report);
  process.stdout.write(`${JSON.stringify({
    schemaVersion: target.schemaVersion,
    savedRevision: target.savedRevision,
    appliedRevision: target.appliedRevision,
  })}\n`);
}

if (process.argv[1] && /model-config-v3-cutover\.(?:mjs|js|ts)$/u.test(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

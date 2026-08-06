import { constants } from 'node:fs';
import { open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';
import { z } from 'zod';
import { modelConfigDocumentSchema } from '../plugins/model-config/types.js';
import { modelConfigV3DocumentSchema } from './model-config-v3-cutover.js';

const reportSchema = z.object({
  schemaVersion: z.literal(1),
  configPath: z.string(),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  savedRevision: z.number().int().positive(),
  appliedRevision: z.number().int().positive(),
}).strict();

function buildModelConfigV4(document: z.infer<typeof modelConfigV3DocumentSchema>) {
  const memoryBinding = document.bindings.find((binding) => binding.workload === 'memory.extract');
  if (!memoryBinding) {
    throw new Error('Model Config V4 cutover requires the memory.extract binding.');
  }

  const groupSummaryBinding = memoryBinding.mode === 'inheritMain'
    ? { workload: 'groupSummary.generate' as const, mode: 'inheritMain' as const }
    : memoryBinding.mode === 'dedicated' && memoryBinding.connectionId && memoryBinding.modelId
      ? {
          workload: 'groupSummary.generate' as const,
          mode: 'dedicated' as const,
          connectionId: memoryBinding.connectionId,
          modelId: memoryBinding.modelId,
        }
      : null;
  if (!groupSummaryBinding) {
    throw new Error('Model Config V4 cutover requires memory.extract to use inheritMain or a complete dedicated target.');
  }

  const revision = document.savedRevision + 1;
  return modelConfigDocumentSchema.parse({
    ...document,
    schemaVersion: 4,
    savedRevision: revision,
    appliedRevision: revision,
    updatedAt: new Date().toISOString(),
    bindings: [...document.bindings, groupSummaryBinding],
  });
}

export async function preflightModelConfigV4(configPath: string) {
  const absolute = resolve(configPath);
  const source = await readFile(absolute);
  const document = modelConfigV3DocumentSchema.parse(JSON.parse(source.toString('utf8')));
  if (document.savedRevision !== document.appliedRevision) {
    throw new Error('Model Config V4 cutover requires savedRevision to equal appliedRevision.');
  }
  if (document.bindings.some((binding) => binding.workload === 'groupSummary.generate')) {
    throw new Error('Model Config V3 already contains groupSummary.generate.');
  }
  buildModelConfigV4(document);
  return reportSchema.parse({
    schemaVersion: 1,
    configPath: absolute,
    sourceSha256: createHash('sha256').update(source).digest('hex'),
    savedRevision: document.savedRevision,
    appliedRevision: document.appliedRevision,
  });
}

export async function applyModelConfigV4(configPath: string, expected: unknown): Promise<void> {
  const absolute = resolve(configPath);
  const report = reportSchema.parse(expected);
  if (absolute !== report.configPath) throw new Error('Model Config V4 report path does not match apply target.');
  const source = await readFile(absolute);
  const digest = createHash('sha256').update(source).digest('hex');
  if (digest !== report.sourceSha256) throw new Error('Model Config changed after V4 preflight.');
  const document = modelConfigV3DocumentSchema.parse(JSON.parse(source.toString('utf8')));
  const target = buildModelConfigV4(document);
  const staged = resolve(dirname(absolute), `.${basename(absolute)}.v4.${process.pid}.${randomUUID()}.staged`);
  try {
    await writeFile(staged, `${JSON.stringify(target, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(staged, absolute);
    const directory = await open(dirname(absolute), constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await rm(staged, { force: true });
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const value = (key: string) => { const index = args.indexOf(key); if (index < 0 || !args[index + 1]) throw new Error(`Missing ${key}`); return args[index + 1]!; };
  const config = value('--config');
  const reportPath = value('--report');
  if (command === 'preflight') {
    const report = await preflightModelConfigV4(config);
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    return;
  }
  if (command === 'apply') {
    if (!args.includes('--confirm-service-stopped')) throw new Error('apply requires --confirm-service-stopped');
    await applyModelConfigV4(config, JSON.parse(await readFile(reportPath, 'utf8')));
    return;
  }
  throw new Error('Usage: model-config-v4-cutover.mjs <preflight|apply> --config <path> --report <path> [--confirm-service-stopped]');
}

if (process.argv[1] && /^model-config-v4-cutover\.(?:[cm]?[jt]s)$/u.test(basename(process.argv[1]))) {
  main().catch((error) => { console.error(error instanceof Error ? error.stack ?? error.message : String(error)); process.exitCode = 1; });
}

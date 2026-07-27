#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { pathToFileURL } from 'node:url';

const LEGACY_VERSION = 1;
const CURRENT_VERSION = 2;
const REMOVED_WORKLOAD = 'search.summary';

function usage() {
  return [
    'usage:',
    '  node deploy/model-config-contract.mjs preflight --config <path> --schema-module <path>',
    '  node deploy/model-config-contract.mjs apply --config <path> --schema-module <path> --confirm-service-stopped [--report <path>]',
  ].join('\n');
}

function parseArgs(argv) {
  const command = argv[0];
  if (command !== 'preflight' && command !== 'apply') {
    throw new Error(usage());
  }
  const options = {
    command,
    config: '',
    schemaModule: '',
    report: '',
    confirmServiceStopped: false,
  };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--confirm-service-stopped') {
      options.confirmServiceStopped = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value) throw new Error(`missing value for ${argument}`);
    if (argument === '--config') options.config = value;
    else if (argument === '--schema-module') options.schemaModule = value;
    else if (argument === '--report') options.report = value;
    else throw new Error(`unknown argument: ${argument}`);
    index += 1;
  }
  if (!options.config || !options.schemaModule) throw new Error(usage());
  if (command === 'preflight' && options.report) {
    throw new Error('preflight is zero-write; read its report from stdout');
  }
  if (command === 'apply' && !options.confirmServiceStopped) {
    throw new Error('apply requires --confirm-service-stopped');
  }
  return options;
}

export function buildModelConfigContractPlan(document, now = new Date()) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('model config must be an object');
  }
  if (!Array.isArray(document.bindings)) {
    throw new Error('model config bindings must be an array');
  }
  const removedBindings = document.bindings.filter(
    (binding) => binding?.workload === REMOVED_WORKLOAD,
  ).length;
  if (removedBindings > 1) {
    throw new Error(`model config has ${removedBindings} ${REMOVED_WORKLOAD} bindings`);
  }
  if (document.schemaVersion === CURRENT_VERSION) {
    if (removedBindings !== 0) {
      throw new Error(`${REMOVED_WORKLOAD} is invalid in model config v${CURRENT_VERSION}`);
    }
    return {
      changed: false,
      document,
      report: {
        operation: 'canonical-model-config-v1-to-v2',
        fromVersion: CURRENT_VERSION,
        toVersion: CURRENT_VERSION,
        removedBindings: 0,
        savedRevision: document.savedRevision,
        appliedRevision: document.appliedRevision,
      },
    };
  }
  if (document.schemaVersion !== LEGACY_VERSION) {
    throw new Error(`unsupported model config schema version: ${document.schemaVersion}`);
  }
  if (!Number.isSafeInteger(document.savedRevision) || document.savedRevision < 1) {
    throw new Error('model config savedRevision must be a positive integer');
  }
  if (!Number.isSafeInteger(document.appliedRevision) || document.appliedRevision < 0) {
    throw new Error('model config appliedRevision must be a nonnegative integer');
  }
  const next = {
    ...document,
    schemaVersion: CURRENT_VERSION,
    savedRevision: document.savedRevision + 1,
    updatedAt: now.toISOString(),
    bindings: document.bindings.filter(
      (binding) => binding?.workload !== REMOVED_WORKLOAD,
    ),
  };
  return {
    changed: true,
    document: next,
    report: {
      operation: 'canonical-model-config-v1-to-v2',
      fromVersion: LEGACY_VERSION,
      toVersion: CURRENT_VERSION,
      removedBindings,
      savedRevision: next.savedRevision,
      appliedRevision: next.appliedRevision,
    },
  };
}

function assertServiceStopped() {
  for (const unit of ['qqbot.target', 'qqbot-koishi.service']) {
    const result = spawnSync(
      'systemctl',
      ['show', unit, '--property=ActiveState', '--value'],
      { encoding: 'utf8' },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`unable to inspect ${unit}`);
    }
    const state = result.stdout.trim();
    if (state !== 'inactive' && state !== 'failed') {
      throw new Error(`${unit} must be inactive before model config migration`);
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const source = JSON.parse(readFileSync(options.config, 'utf8'));
  const plan = buildModelConfigContractPlan(source);
  const schemaModule = await import(pathToFileURL(options.schemaModule).href);
  schemaModule.modelConfigDocumentSchema.parse(plan.document);
  if (options.command === 'preflight') {
    process.stdout.write(`${JSON.stringify(plan.report, null, 2)}\n`);
    return;
  }

  assertServiceStopped();
  if (plan.changed) {
    const temporary = `${options.config}.contract-${process.pid}`;
    try {
      writeFileSync(
        temporary,
        `${JSON.stringify(plan.document, null, 2)}\n`,
        { flag: 'wx', mode: 0o600 },
      );
      chmodSync(temporary, 0o600);
      renameSync(temporary, options.config);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  const report = {
    ...plan.report,
    applied: plan.changed,
  };
  if (options.report) {
    writeFileSync(options.report, `${JSON.stringify(report, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}

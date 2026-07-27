#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  describeConnectionIdentity,
  modelConfigDocumentSchema,
  writeModelConfigDocumentAtomic,
  type ConnectionDefinition,
  type ModelConfigDocument,
} from '../plugins/model-config/index.js';
import {
  decryptEnvelopeJson,
  encryptEnvelopeJson,
  loadOrCreateKek,
  type CredentialKek,
} from '../plugins/shared/credential-crypto.js';

process.umask(0o077);

type CutoverCommand = 'preflight' | 'apply';

export type ModelAuthConnectionCutoverOptions = {
  command: CutoverCommand;
  configPath: string;
  kekPath: string;
  backupPath: string | null;
  reportPath: string | null;
  systemctl: string;
  confirmServiceStopped: boolean;
  now?: () => Date;
};

type ConnectionMapping = {
  oldId: string;
  newId: string;
  oldDisplayName: string;
  newDisplayName: string;
  adapter: ConnectionDefinition['adapter'];
  authKind: ConnectionDefinition['auth']['kind'];
  baseUrl: string | null;
  credentialDisposition: 'external' | 'notRequired' | 'retained' | 'discarded';
};

export type ModelAuthConnectionCutoverReport = {
  schemaVersion: 1;
  operation: 'model-auth-connection-boundary-v2';
  command: CutoverCommand;
  dryRun: boolean;
  applied: boolean;
  changed: boolean;
  sourceRevision: number;
  targetRevision: number;
  connections: ConnectionMapping[];
  reportHash: string;
};

export type ModelAuthConnectionCutoverPlan = {
  document: ModelConfigDocument;
  report: ModelAuthConnectionCutoverReport;
};

type PlannedIdentity = {
  old: ConnectionDefinition;
  descriptor: ReturnType<typeof describeConnectionIdentity>;
  newId: string;
  newDisplayName: string;
  primaryOldId: string;
};

function secretAad(connectionId: string, secretRef: string): string {
  return `qqbot:model-config:v1:${connectionId}:${secretRef}`;
}

function priorityForIdentity(
  connection: ConnectionDefinition,
  descriptor: ReturnType<typeof describeConnectionIdentity>,
): number {
  if (connection.id === descriptor.idBase) return 0;
  if (
    descriptor.providerId === 'siliconflow'
    && connection.id === 'siliconflow-api-key'
  ) return 1;
  if (connection.id === descriptor.providerId) return 2;
  if (connection.displayName === descriptor.displayNameBase) return 3;
  if (
    descriptor.providerId === 'siliconflow'
    && connection.displayName === 'SiliconFlow API Key'
  ) return 4;
  if (connection.displayName === descriptor.providerName) return 5;
  return 6;
}

function planIdentities(
  connections: readonly ConnectionDefinition[],
): Map<string, PlannedIdentity> {
  const groups = new Map<string, Array<{
    connection: ConnectionDefinition;
    descriptor: ReturnType<typeof describeConnectionIdentity>;
  }>>();
  for (const connection of connections) {
    const descriptor = describeConnectionIdentity(connection);
    const group = groups.get(descriptor.idBase) ?? [];
    group.push({ connection, descriptor });
    groups.set(descriptor.idBase, group);
  }

  const result = new Map<string, PlannedIdentity>();
  for (const group of groups.values()) {
    group.sort((left, right) => (
      priorityForIdentity(left.connection, left.descriptor)
      - priorityForIdentity(right.connection, right.descriptor)
      || left.connection.id.localeCompare(right.connection.id)
    ));
    const primaryOldId = group[0]?.connection.id;
    if (!primaryOldId) throw new Error('Connection identity group is empty.');
    const singletonProvider = group[0]?.descriptor.providerId === 'siliconflow';
    if (singletonProvider) {
      const baseUrls = new Set(group.map((entry) => entry.connection.baseUrl));
      const authKinds = new Set(group.map((entry) => entry.connection.auth.kind));
      if (baseUrls.size !== 1 || authKinds.size !== 1 || !authKinds.has('apiKey')) {
        throw new Error('SiliconFlow connections must share one API-key endpoint.');
      }
    }
    for (const [index, entry] of group.entries()) {
      const ordinal = singletonProvider ? 1 : index + 1;
      const suffix = ordinal === 1 ? '' : `-${ordinal}`;
      const displaySuffix = ordinal === 1 ? '' : ` ${ordinal}`;
      result.set(entry.connection.id, {
        old: entry.connection,
        descriptor: entry.descriptor,
        newId: `${entry.descriptor.idBase.slice(0, 64 - suffix.length)}${suffix}`,
        newDisplayName: `${entry.descriptor.displayNameBase}${displaySuffix}`,
        primaryOldId: singletonProvider ? primaryOldId : entry.connection.id,
      });
    }
  }
  return result;
}

function reportHash(
  report: Omit<ModelAuthConnectionCutoverReport, 'reportHash'>,
): string {
  return createHash('sha256').update(JSON.stringify(report)).digest('hex');
}

export function buildModelAuthConnectionCutoverPlan(
  input: ModelConfigDocument,
  kek: CredentialKek,
  options: Pick<ModelAuthConnectionCutoverOptions, 'command' | 'now'>,
): ModelAuthConnectionCutoverPlan {
  const current = modelConfigDocumentSchema.parse(input);
  if (current.savedRevision !== current.appliedRevision) {
    throw new Error(
      `Model config revision ${current.savedRevision} is pending; apply it before auth connection cutover.`,
    );
  }

  const identities = planIdentities(current.connections);
  const connections = current.connections.flatMap((connection) => {
    const identity = identities.get(connection.id);
    if (!identity) throw new Error(`Missing connection identity plan for ${connection.id}.`);
    if (identity.primaryOldId !== connection.id) return [];
    const groupedConnections = current.connections.filter((candidate) => (
      identities.get(candidate.id)?.newId === identity.newId
    ));
    return [{
      ...connection,
      id: identity.newId,
      displayName: identity.newDisplayName,
      catalogDriver: groupedConnections.some(
        (candidate) => candidate.catalogDriver === 'openaiModels',
      )
        ? 'openaiModels' as const
        : connection.catalogDriver,
      auth: connection.auth.kind === 'apiKey'
        ? {
            kind: 'apiKey' as const,
            secretRef: `connection:${identity.newId}:api-key`,
          }
        : connection.auth,
    }];
  });

  const connectionIdMap = new Map(
    [...identities.values()].map((identity) => [identity.old.id, identity.newId]),
  );
  const modelKeys = new Set<string>();
  const models = current.models.map((model) => {
    const connectionId = connectionIdMap.get(model.connectionId)
      ?? (() => {
        throw new Error(`Missing connection mapping for model ${model.connectionId}/${model.id}.`);
      })();
    const key = `${connectionId}/${model.id}`;
    if (modelKeys.has(key)) {
      throw new Error(`Merged connection has duplicate canonical model ID: ${key}.`);
    }
    modelKeys.add(key);
    return {
      ...model,
      connectionId,
    };
  });
  const bindings = current.bindings.map((binding) => (
    binding.mode === 'dedicated'
      ? {
          ...binding,
          connectionId: connectionIdMap.get(binding.connectionId)
            ?? (() => {
              throw new Error(`Missing connection mapping for ${binding.workload}.`);
            })(),
        }
      : binding
  ));

  const currentConnections = new Map(
    current.connections.map((connection) => [connection.id, connection]),
  );
  const secrets = current.secrets.map((secret) => {
    const oldConnection = currentConnections.get(secret.connectionId);
    const identity = identities.get(secret.connectionId);
    if (!oldConnection || oldConnection.auth.kind !== 'apiKey' || !identity) {
      throw new Error(`Encrypted secret has no API-key connection owner: ${secret.connectionId}.`);
    }
    if (identity.primaryOldId !== secret.connectionId) return null;
    const newSecretRef = `connection:${identity.newId}:api-key`;
    if (
      identity.newId === secret.connectionId
      && newSecretRef === secret.secretRef
    ) {
      return secret;
    }
    const value = decryptEnvelopeJson<string>(
      secret.cipherText,
      secret.meta,
      secretAad(secret.connectionId, secret.secretRef),
      kek,
    );
    const encrypted = encryptEnvelopeJson(
      value,
      secretAad(identity.newId, newSecretRef),
      kek,
    );
    return {
      connectionId: identity.newId,
      secretRef: newSecretRef,
      cipherText: encrypted.cipherText,
      meta: encrypted.meta,
    };
  }).filter((secret) => secret !== null);

  const mappings: ConnectionMapping[] = current.connections.map((connection) => {
    const identity = identities.get(connection.id);
    if (!identity) throw new Error(`Missing report identity for ${connection.id}.`);
    return {
      oldId: connection.id,
      newId: identity.newId,
      oldDisplayName: connection.displayName,
      newDisplayName: identity.newDisplayName,
      adapter: connection.adapter,
      authKind: connection.auth.kind,
      baseUrl: connection.baseUrl,
      credentialDisposition: connection.auth.kind === 'oauth'
        ? 'external'
        : connection.auth.kind === 'none'
          ? 'notRequired'
          : identity.primaryOldId === connection.id
            ? 'retained'
            : 'discarded',
    };
  });
  const changed = mappings.some((mapping) => (
    mapping.oldId !== mapping.newId
    || mapping.oldDisplayName !== mapping.newDisplayName
  ));
  const targetRevision = changed ? current.savedRevision + 1 : current.savedRevision;
  const document = modelConfigDocumentSchema.parse(changed
    ? {
        ...current,
        savedRevision: targetRevision,
        updatedAt: (options.now ?? (() => new Date()))().toISOString(),
        connections,
        models,
        bindings,
        secrets,
      }
    : current);
  const reportWithoutHash: Omit<ModelAuthConnectionCutoverReport, 'reportHash'> = {
    schemaVersion: 1,
    operation: 'model-auth-connection-boundary-v2',
    command: options.command,
    dryRun: options.command === 'preflight',
    applied: false,
    changed,
    sourceRevision: current.savedRevision,
    targetRevision,
    connections: mappings,
  };
  return {
    document,
    report: {
      ...reportWithoutHash,
      reportHash: reportHash(reportWithoutHash),
    },
  };
}

function parseArgs(argv: string[]): ModelAuthConnectionCutoverOptions {
  const command = argv.shift();
  if (command !== 'preflight' && command !== 'apply') {
    throw new Error('usage: model-auth-connection-cutover.mjs <preflight|apply> [options]');
  }
  const options: ModelAuthConnectionCutoverOptions = {
    command,
    configPath: '/opt/qqbot/data/model-config.json',
    kekPath: '/opt/qqbot/shared/model-config.kek',
    backupPath: null,
    reportPath: null,
    systemctl: 'systemctl',
    confirmServiceStopped: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--confirm-service-stopped') {
      options.confirmServiceStopped = true;
      continue;
    }
    if (![
      '--config',
      '--kek',
      '--backup',
      '--report',
      '--systemctl',
    ].includes(argument)) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = argv[++index];
    if (!value || value.startsWith('--')) {
      throw new Error(`${argument} requires a value`);
    }
    if (argument === '--config') options.configPath = resolve(value);
    else if (argument === '--kek') options.kekPath = resolve(value);
    else if (argument === '--backup') options.backupPath = resolve(value);
    else if (argument === '--report') options.reportPath = resolve(value);
    else if (argument === '--systemctl') options.systemctl = value;
  }
  if (command === 'apply') {
    if (!options.confirmServiceStopped) {
      throw new Error('apply requires --confirm-service-stopped');
    }
    if (!options.backupPath) throw new Error('apply requires --backup');
  }
  return options;
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.tmp`,
  );
  let created = false;
  try {
    const file = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    created = true;
    try {
      await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporaryPath, path);
    created = false;
  } finally {
    if (created) await unlink(temporaryPath).catch(() => undefined);
  }
}

function assertServiceStopped(systemctl: string): void {
  for (const unit of ['qqbot.target', 'qqbot-koishi.service']) {
    const result = spawnSync(
      systemctl,
      ['show', unit, '--property=ActiveState', '--value'],
      { encoding: 'utf8' },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Unable to inspect ${unit}.`);
    if (result.stdout.trim() !== 'inactive') {
      throw new Error(`${unit} must be inactive before model auth connection cutover.`);
    }
  }
}

export async function runModelAuthConnectionCutover(
  options: ModelAuthConnectionCutoverOptions,
): Promise<ModelAuthConnectionCutoverReport> {
  const configPath = resolve(options.configPath);
  const kekPath = resolve(options.kekPath);
  await stat(kekPath);
  const document = modelConfigDocumentSchema.parse(
    JSON.parse(await readFile(configPath, 'utf8')),
  );
  const kek = loadOrCreateKek(kekPath);
  const plan = buildModelAuthConnectionCutoverPlan(document, kek, options);
  if (options.command === 'preflight') {
    if (options.reportPath) await writeJsonAtomic(resolve(options.reportPath), plan.report);
    return plan.report;
  }

  assertServiceStopped(options.systemctl);
  const backupPath = resolve(options.backupPath!);
  await mkdir(dirname(backupPath), { recursive: true, mode: 0o700 });
  await copyFile(configPath, backupPath, constants.COPYFILE_EXCL);
  await chmod(backupPath, 0o600);
  if (plan.report.changed) {
    await writeModelConfigDocumentAtomic(configPath, plan.document, 'save');
  }
  const {
    reportHash: _preflightHash,
    ...preflightReport
  } = plan.report;
  const appliedReport: Omit<ModelAuthConnectionCutoverReport, 'reportHash'> = {
    ...preflightReport,
    dryRun: false,
    applied: plan.report.changed,
    command: 'apply',
  };
  const finalReport = {
    ...appliedReport,
    reportHash: reportHash(appliedReport),
  };
  if (options.reportPath) await writeJsonAtomic(resolve(options.reportPath), finalReport);
  return finalReport;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const report = await runModelAuthConnectionCutover(options);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (
  process.argv[1]
  && /^model-auth-connection-cutover\.(?:[cm]?[jt]s)$/u.test(basename(process.argv[1]))
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}

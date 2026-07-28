import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { MEMORY_LEDGER_SCHEMA_VERSION } from './schema.js';

export interface MemoryReadinessMarker {
  pid: number;
  schemaVersion: typeof MEMORY_LEDGER_SCHEMA_VERSION;
  appliedModelRevision: number;
  extractionModel: string;
  readyAt: number;
}

function readinessPath(): string | null {
  const path = process.env.QQBOT_MEMORY_READY_FILE?.trim() ?? '';
  if (!path) return null;
  if (!isAbsolute(path)) {
    throw new Error('QQBOT_MEMORY_READY_FILE must be an absolute path.');
  }
  return path;
}

function fsyncPath(path: string): void {
  const descriptor = openSync(path, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function clearMemoryReadinessMarker(): void {
  const path = readinessPath();
  if (!path) return;
  rmSync(path, { force: true });
}

export function publishMemoryReadinessMarker(
  input: Omit<MemoryReadinessMarker, 'pid' | 'schemaVersion' | 'readyAt'>,
): void {
  const path = readinessPath();
  if (!path) return;
  if (!Number.isInteger(input.appliedModelRevision) || input.appliedModelRevision < 1) {
    throw new Error('Memory readiness requires a positive applied model revision.');
  }
  const parent = dirname(path);
  const stat = lstatSync(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Memory readiness directory is invalid: ${parent}`);
  }
  const marker: MemoryReadinessMarker = {
    pid: process.pid,
    schemaVersion: MEMORY_LEDGER_SCHEMA_VERSION,
    appliedModelRevision: input.appliedModelRevision,
    extractionModel: input.extractionModel,
    readyAt: Date.now(),
  };
  const temporaryPath = `${path}.tmp.${process.pid}`;
  rmSync(temporaryPath, { force: true });
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(marker)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    fsyncPath(temporaryPath);
    renameSync(temporaryPath, path);
    fsyncPath(parent);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

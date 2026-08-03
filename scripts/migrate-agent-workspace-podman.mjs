#!/usr/bin/env node
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

const configPath = process.argv[2] ? resolve(process.argv[2]) : '';
if (!configPath) throw new Error('usage: migrate-agent-workspace-podman.mjs <agent-config.json>');

let document;
try {
  document = JSON.parse(readFileSync(configPath, 'utf8'));
} catch (error) {
  if (error?.code === 'ENOENT') {
    console.log(`[agent-workspace] no persisted config at ${configPath}`);
    process.exit(0);
  }
  throw error;
}

if (!document || typeof document !== 'object' || Array.isArray(document)) {
  throw new Error('Agent config must be a JSON object.');
}
const computer = document.computer;
if (!computer || typeof computer !== 'object' || Array.isArray(computer)) {
  throw new Error('Agent config is missing computer settings.');
}
if (!Object.hasOwn(computer, 'local')) {
  if (computer.defaultProvider === 'local') {
    throw new Error('Agent config selects Local without Local settings.');
  }
  console.log('[agent-workspace] persisted config already uses Podman-era settings');
  process.exit(0);
}
if (Object.hasOwn(computer, 'podman')) {
  throw new Error('Agent config contains both Local and Podman settings.');
}
if (!computer.local || typeof computer.local !== 'object' || Array.isArray(computer.local)) {
  throw new Error('Agent Local settings must be an object.');
}

computer.podman = {
  enabled: computer.local.enabled === true,
  image: 'localhost/qqbot-agent-workspace:latest',
  memoryMb: 1024,
  pidsLimit: 256,
  commandTimeoutMs: Number.isInteger(computer.local.commandTimeoutMs)
    ? computer.local.commandTimeoutMs
    : 30_000,
};
delete computer.local;
if (computer.defaultProvider === 'local') computer.defaultProvider = 'podman';

const temporary = `${dirname(configPath)}/.${basename(configPath)}.${process.pid}.tmp`;
writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
const file = openSync(temporary, 'r');
fsyncSync(file);
closeSync(file);
renameSync(temporary, configPath);
const directory = openSync(dirname(configPath), 'r');
fsyncSync(directory);
closeSync(directory);
console.log('[agent-workspace] migrated Local settings to Podman');

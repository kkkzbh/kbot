#!/usr/bin/env node
import { lstatSync, readFileSync } from 'node:fs';

function readArgument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) {
    throw new Error(`missing ${name}`);
  }
  return process.argv[index + 1];
}

function requireNonEmptyString(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Memory V3 readiness marker has invalid ${field}.`);
  }
  return value;
}

const markerPath = readArgument('--marker');
const serviceCgroup = readArgument('--cgroup');
const procRootIndex = process.argv.indexOf('--proc-root');
const procRoot = procRootIndex < 0 ? '/proc' : process.argv[procRootIndex + 1];
if (!serviceCgroup.startsWith('/') || serviceCgroup === '/') {
  throw new Error('qqbot-koishi.service ControlGroup is invalid.');
}
if (!procRoot) {
  throw new Error('missing --proc-root value');
}

const stat = lstatSync(markerPath);
if (!stat.isFile() || stat.isSymbolicLink()) {
  throw new Error('Memory V3 readiness marker must be a regular file.');
}
if ((stat.mode & 0o077) !== 0) {
  throw new Error('Memory V3 readiness marker permissions must not allow group or other access.');
}

const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
if (!Number.isSafeInteger(marker.pid) || marker.pid < 1) {
  throw new Error(`Memory V3 readiness marker has invalid pid: ${String(marker.pid)}.`);
}
const processCgroups = readFileSync(`${procRoot}/${marker.pid}/cgroup`, 'utf8')
  .trim()
  .split('\n')
  .map((line) => line.split(':', 3)[2]);
if (!processCgroups.includes(serviceCgroup)) {
  throw new Error(
    `Memory V3 readiness PID ${marker.pid} is outside service cgroup ${serviceCgroup}.`,
  );
}
if (marker.schemaVersion !== 3) {
  throw new Error(`Memory V3 readiness schema mismatch: ${String(marker.schemaVersion)}.`);
}
if (!Number.isSafeInteger(marker.appliedModelRevision) || marker.appliedModelRevision < 1) {
  throw new Error('Memory V3 readiness applied model revision is invalid.');
}
requireNonEmptyString(marker.extractionModel, 'extractionModel');
if (!Number.isSafeInteger(marker.readyAt) || marker.readyAt < 1) {
  throw new Error('Memory V3 readiness timestamp is invalid.');
}

process.stdout.write(
  `Memory V3 ready: pid=${marker.pid} schema=${marker.schemaVersion} modelRevision=${marker.appliedModelRevision}\n`,
);

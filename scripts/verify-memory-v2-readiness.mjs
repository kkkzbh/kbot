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
    throw new Error(`Memory V2 readiness marker has invalid ${field}.`);
  }
  return value;
}

const markerPath = readArgument('--marker');
const expectedPid = Number(readArgument('--pid'));
if (!Number.isSafeInteger(expectedPid) || expectedPid < 1) {
  throw new Error('qqbot-koishi.service MainPID is invalid.');
}

const stat = lstatSync(markerPath);
if (!stat.isFile() || stat.isSymbolicLink()) {
  throw new Error('Memory V2 readiness marker must be a regular file.');
}
if ((stat.mode & 0o077) !== 0) {
  throw new Error('Memory V2 readiness marker permissions must not allow group or other access.');
}

const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
if (marker.pid !== expectedPid) {
  throw new Error(
    `Memory V2 readiness PID mismatch: marker=${String(marker.pid)} service=${expectedPid}.`,
  );
}
if (marker.schemaVersion !== 2) {
  throw new Error(`Memory V2 readiness schema mismatch: ${String(marker.schemaVersion)}.`);
}
if (!Number.isSafeInteger(marker.appliedModelRevision) || marker.appliedModelRevision < 1) {
  throw new Error('Memory V2 readiness applied model revision is invalid.');
}
requireNonEmptyString(marker.extractionModel, 'extractionModel');
requireNonEmptyString(marker.embeddingModel, 'embeddingModel');
if (!Number.isSafeInteger(marker.readyAt) || marker.readyAt < 1) {
  throw new Error('Memory V2 readiness timestamp is invalid.');
}

process.stdout.write(
  `Memory V2 ready: pid=${marker.pid} schema=${marker.schemaVersion} modelRevision=${marker.appliedModelRevision}\n`,
);

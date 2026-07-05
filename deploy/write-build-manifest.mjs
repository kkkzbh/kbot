#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (value == null || value.startsWith('--')) {
      throw new Error(`missing value for --${key}`);
    }
    args.set(key, value);
    index += 1;
  }
  return args;
}

function commandOutput(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }).trim();
}

function readPackageManager(rootDir) {
  const packageJson = JSON.parse(readFileSync(`${rootDir}/package.json`, 'utf8'));
  return typeof packageJson.packageManager === 'string' ? packageJson.packageManager : null;
}

const args = parseArgs(process.argv.slice(2));
const outputPath = args.get('output');
if (!outputPath) throw new Error('missing --output');

const qqbotRoot = resolve(args.get('qqbot-root') || process.cwd());
const chatlunaRoot = resolve(args.get('chatluna-root') || process.env.CHATLUNA_SOURCE_DIR || `${qqbotRoot}/../chatluna`);

const manifest = {
  schemaVersion: 1,
  artifact: {
    layout: 'single-instance',
    createdAt: new Date().toISOString(),
  },
  qqbot: {
    root: qqbotRoot,
    sha: commandOutput('git', ['rev-parse', 'HEAD'], qqbotRoot),
    packageManager: readPackageManager(qqbotRoot),
  },
  chatluna: {
    root: chatlunaRoot,
    sha: commandOutput('git', ['rev-parse', 'HEAD'], chatlunaRoot),
    packageManager: readPackageManager(chatlunaRoot),
  },
  tools: {
    node: process.version,
    pnpm: commandOutput('pnpm', ['--version'], qqbotRoot),
  },
};

mkdirSync(dirname(resolve(outputPath)), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`[deploy] wrote build manifest: ${outputPath}`);

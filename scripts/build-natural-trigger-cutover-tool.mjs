#!/usr/bin/env node

import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  rename,
  rm,
} from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = resolve(ROOT_DIR, 'src/tools/natural-trigger-cutover.ts');
const OUTPUT_NAME = 'natural-trigger-cutover.mjs';

async function main() {
  let outDir = resolve(ROOT_DIR, 'dist/tools');
  const args = process.argv.slice(2);
  if (args.length > 0) {
    if (args.length !== 2 || args[0] !== '--out-dir') {
      throw new Error('usage: build-natural-trigger-cutover-tool.mjs [--out-dir PATH]');
    }
    outDir = resolve(args[1]);
  }
  await mkdir(outDir, { recursive: true, mode: 0o700 });
  const temporaryDir = await mkdtemp(resolve(dirname(outDir), '.natural-trigger-build-'));
  try {
    await build({
      configFile: false,
      root: ROOT_DIR,
      publicDir: false,
      logLevel: 'warn',
      ssr: { noExternal: true },
      build: {
        ssr: ENTRY,
        target: 'node22',
        outDir: temporaryDir,
        emptyOutDir: true,
        minify: false,
        sourcemap: false,
        rollupOptions: {
          external: [/^node:/],
          output: { format: 'es', entryFileNames: OUTPUT_NAME },
        },
      },
    });
    const output = resolve(temporaryDir, OUTPUT_NAME);
    const info = await lstat(output);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`built natural trigger cutover artifact is invalid: ${output}`);
    }
    await chmod(output, 0o700);
    await rename(output, resolve(outDir, OUTPUT_NAME));
  } finally {
    await rm(temporaryDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

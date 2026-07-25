#!/usr/bin/env node

import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import {
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

process.umask(0o077);

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = resolve(ROOT_DIR, 'scripts/preset-v2-cutover.mjs');
const SQLITE_HELPER = resolve(ROOT_DIR, 'scripts/preset-v2-sqlite.py');
const OWNER_MARKER = '.preset-v2-cutover-tools-output.json';
const OWNER_MARKER_CONTENT = `${JSON.stringify({
  owner: 'qqbot-preset-v2-cutover-tools',
  schemaVersion: 1,
})}\n`;

function isSameOrAncestor(candidate, target) {
  const child = relative(candidate, target);
  return child === ''
    || (
      child !== '..'
      && !child.startsWith(`..${sep}`)
      && !isAbsolute(child)
    );
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function prepareOwnedOutputDirectory(outDir) {
  for (const protectedPath of [
    resolve(outDir, sep),
    ROOT_DIR,
    resolve(process.cwd()),
    resolve(homedir()),
  ]) {
    if (isSameOrAncestor(outDir, protectedPath)) {
      throw new Error(
        `Refusing to recursively replace broad or protected output directory: ${outDir}`,
      );
    }
  }

  if (await pathExists(outDir)) {
    const info = await lstat(outDir);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`Output path must be a real directory: ${outDir}`);
    }
    const entries = await readdir(outDir);
    if (entries.length > 0) {
      const markerPath = resolve(outDir, OWNER_MARKER);
      if (!entries.includes(OWNER_MARKER)) {
        throw new Error(
          `Refusing to replace an unowned non-empty output directory: ${outDir}`,
        );
      }
      const markerInfo = await lstat(markerPath);
      const marker = markerInfo.isFile() ? await readFile(markerPath, 'utf8') : '';
      if (marker !== OWNER_MARKER_CONTENT) {
        throw new Error(`Output directory ownership marker is invalid: ${markerPath}`);
      }
    }
    await rm(outDir, { recursive: true, force: true });
  }
  await mkdir(outDir, { recursive: true, mode: 0o700 });
  await writeFile(resolve(outDir, OWNER_MARKER), OWNER_MARKER_CONTENT, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
}

function parseArgs(argv) {
  let outDir = resolve(ROOT_DIR, 'dist/tools');
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== '--out-dir') {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (value == null || value.startsWith('--')) {
      throw new Error('--out-dir requires a path');
    }
    outDir = resolve(value);
    index += 1;
  }
  return { outDir };
}

async function main() {
  const { outDir } = parseArgs(process.argv.slice(2));
  await prepareOwnedOutputDirectory(outDir);

  await build({
    configFile: false,
    root: ROOT_DIR,
    publicDir: false,
    logLevel: 'warn',
    ssr: {
      noExternal: true,
    },
    build: {
      ssr: ENTRY,
      target: 'node22',
      outDir,
      emptyOutDir: false,
      minify: false,
      sourcemap: false,
      rollupOptions: {
        external: [/^node:/],
        output: {
          format: 'es',
          entryFileNames: 'preset-v2-cutover.mjs',
        },
      },
    },
  });

  const nodeTool = resolve(outDir, 'preset-v2-cutover.mjs');
  const pythonTool = resolve(outDir, 'preset-v2-sqlite.py');
  await copyFile(SQLITE_HELPER, pythonTool);
  await chmod(outDir, 0o700);
  await chmod(nodeTool, 0o700);
  await chmod(pythonTool, 0o700);
  process.stdout.write(`[info] Preset V2 cutover tools built: ${outDir}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

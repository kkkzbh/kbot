#!/usr/bin/env node

import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

process.umask(0o077);

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS = [
  {
    entry: resolve(ROOT_DIR, 'src/tools/model-config-v3-cutover.ts'),
    outputName: 'model-config-v3-cutover.mjs',
  },
  {
    entry: resolve(ROOT_DIR, 'src/tools/model-auth-connection-cutover.ts'),
    outputName: 'model-auth-connection-cutover.mjs',
  },
];
const OWNER_MARKER = '.model-config-cutover-tool-output.json';
const OWNER_MARKER_CONTENT = `${JSON.stringify({
  owner: 'qqbot-model-config-cutover-tool',
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

async function assertOwnedOutput(outDir) {
  for (const protectedPath of [
    resolve(outDir, sep),
    ROOT_DIR,
    resolve(process.cwd()),
    resolve(homedir()),
  ]) {
    if (isSameOrAncestor(outDir, protectedPath)) {
      throw new Error(
        `Refusing to publish into a broad or protected output directory: ${outDir}`,
      );
    }
  }

  if (!(await pathExists(outDir))) {
    await mkdir(outDir, { recursive: true, mode: 0o700 });
  } else {
    const info = await lstat(outDir);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`Output path must be a real directory: ${outDir}`);
    }
  }

  const markerPath = join(outDir, OWNER_MARKER);
  const outputPaths = TOOLS.map((tool) => join(outDir, tool.outputName));
  if (await pathExists(markerPath)) {
    const markerInfo = await lstat(markerPath);
    const marker = markerInfo.isFile() && !markerInfo.isSymbolicLink()
      ? await readFile(markerPath, 'utf8')
      : '';
    if (marker !== OWNER_MARKER_CONTENT) {
      throw new Error(`Output ownership marker is invalid: ${markerPath}`);
    }
  } else {
    for (const outputPath of outputPaths) {
      if (await pathExists(outputPath)) {
        throw new Error(`Refusing to replace an unowned output file: ${outputPath}`);
      }
    }
    await writeFile(markerPath, OWNER_MARKER_CONTENT, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  }

  for (const outputPath of outputPaths) {
    if (await pathExists(outputPath)) {
      const outputInfo = await lstat(outputPath);
      if (outputInfo.isSymbolicLink() || !outputInfo.isFile()) {
        throw new Error(`Owned output must be a regular file: ${outputPath}`);
      }
    }
  }
}

async function main() {
  const { outDir } = parseArgs(process.argv.slice(2));
  await assertOwnedOutput(outDir);

  const temporaryDir = await mkdtemp(
    resolve(dirname(outDir), '.model-config-cutover-build-'),
  );
  try {
    for (const [index, tool] of TOOLS.entries()) {
      await build({
        configFile: false,
        root: ROOT_DIR,
        publicDir: false,
        logLevel: 'warn',
        ssr: {
          noExternal: true,
        },
        build: {
          ssr: tool.entry,
          target: 'node22',
          outDir: temporaryDir,
          emptyOutDir: index === 0,
          minify: false,
          sourcemap: false,
          rollupOptions: {
            external: [/^node:/],
            output: {
              format: 'es',
              entryFileNames: tool.outputName,
            },
          },
        },
      });
    }

    for (const tool of TOOLS) {
      const stagedOutput = resolve(temporaryDir, tool.outputName);
      const stagedInfo = await lstat(stagedOutput);
      if (!stagedInfo.isFile() || stagedInfo.isSymbolicLink()) {
        throw new Error(`Built model config cutover artifact is invalid: ${stagedOutput}`);
      }
      await chmod(stagedOutput, 0o700);
      await rename(stagedOutput, resolve(outDir, tool.outputName));
    }
    await chmod(outDir, 0o700);
  } finally {
    await rm(temporaryDir, { recursive: true, force: true });
  }

  process.stdout.write(`[info] Model config cutover tool built: ${outDir}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

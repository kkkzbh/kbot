import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-runtime-contract-'));
  tempDirs.push(dir);
  return dir;
}

function readRepoFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('runtime startup contract', () => {
  it('keeps service startup on preflight-only no-build path', () => {
    const packageJson = JSON.parse(readRepoFile('package.json'));
    const runScript = readRepoFile('scripts/run-koishi-with-env.sh');
    const smokeScript = readRepoFile('scripts/smoke-koishi-start.sh');

    expect(packageJson.scripts.build).toBe('bash ./scripts/build-runtime.sh');
    expect(packageJson.scripts['build:runtime']).toBe('bash ./scripts/build-runtime.sh');
    expect(packageJson.scripts['runtime:check']).toContain('ensure-chatluna-build.sh --check');
    expect(packageJson.scripts['runtime:check']).toContain('verify-runtime-artifacts.mjs --config koishi.yml');
    expect(packageJson.scripts.start).toBe('bash ./scripts/run-koishi-with-env.sh');
    expect(packageJson.scripts['start:local']).toBe('QQBOT_ENV_FILE=.env.local bash ./scripts/run-koishi-with-env.sh');
    expect(packageJson.scripts['start:server']).toBe('QQBOT_ENV_FILE=.env.server bash ./scripts/run-koishi-with-env.sh');

    expect(runScript).toContain('./scripts/ensure-chatluna-build.sh --check');
    expect(runScript).toContain('node ./scripts/verify-runtime-artifacts.mjs --config koishi.yml');
    expect(runScript).toContain('exec pnpm exec koishi start koishi.yml');
    expect(runScript).not.toContain('pnpm build');
    expect(runScript).not.toContain('./scripts/ensure-chatluna-build.sh\npnpm');
    expect(smokeScript).toContain('./scripts/ensure-chatluna-build.sh --check');
    expect(smokeScript).toContain('node ./scripts/verify-runtime-artifacts.mjs --config koishi.yml');
  });

  it('builds runtime artifacts in a staging directory before replacing dist', () => {
    const buildScript = readRepoFile('scripts/build-runtime.sh');
    const viteConfig = readRepoFile('src/plugins/bot-console/client/vite.config.ts');
    const botConsolePlugin = readRepoFile('src/plugins/bot-console/index.ts');

    expect(buildScript).toContain('mktemp -d "${TMP_ROOT}/runtime-build-XXXXXX"');
    expect(buildScript).toContain('pnpm exec tsc -p tsconfig.build.json --outDir "$STAGE_DIST"');
    expect(buildScript).toContain('QQBOT_CONSOLE_OUT_DIR="$STAGE_CONSOLE_DIR" pnpm console:build');
    expect(buildScript).toContain('cp -R "$ROOT_DIR/src/plugins/affinity/assets/." "$STAGE_DIST/plugins/affinity/assets/"');
    expect(buildScript).toContain('node ./scripts/verify-runtime-artifacts.mjs --config koishi.yml --dist "$STAGE_DIST"');
    expect(buildScript).toContain('mv "$STAGE_DIST" "$NEXT_DIST"');
    expect(buildScript).toContain('mv "$NEXT_DIST" "$DIST_DIR"');
    expect(buildScript).not.toMatch(/rm -rf\s+dist\b/);
    expect(buildScript).not.toMatch(/rm -rf\s+"\$DIST_DIR"/);

    expect(viteConfig).toContain('process.env.QQBOT_CONSOLE_OUT_DIR');
    expect(viteConfig).toContain('../../../../dist/node_modules/@qqbot/bot-console-client');
    expect(botConsolePlugin).toContain("CONSOLE_CLIENT_ASSET_DIR = 'dist/node_modules/@qqbot/bot-console-client'");
    expect(botConsolePlugin).not.toContain('node_modules/.cache/qqbot-bot-console');
  });

  it('verifies local dist plugin artifacts and bot-console client assets', () => {
    const dir = createTempDir();
    const configPath = join(dir, 'koishi.yml');
    const distDir = join(dir, 'dist');
    const scriptPath = resolve(process.cwd(), 'scripts/verify-runtime-artifacts.mjs');

    writeFileSync(
      configPath,
      [
        'plugins:',
        '  group:entry:',
        '    ./dist/plugins/bot-console:bot-console: {}',
        '    ./dist/plugins/reply:voice: {}',
      ].join('\n'),
      'utf8',
    );

    mkdirSync(join(distDir, 'plugins/bot-console'), { recursive: true });
    mkdirSync(join(distDir, 'plugins/reply'), { recursive: true });
    writeFileSync(join(distDir, 'plugins/bot-console/index.js'), 'export {}\n', 'utf8');
    writeFileSync(join(distDir, 'plugins/reply/index.js'), 'export {}\n', 'utf8');

    const missingClient = spawnSync(process.execPath, [scriptPath, '--config', configPath, '--dist', distDir], {
      cwd: dir,
      encoding: 'utf8',
    });

    expect(missingClient.status).toBe(1);
    expect(missingClient.stderr).toContain('Runtime artifacts are missing');
    expect(missingClient.stderr).toContain('node_modules/@qqbot/bot-console-client/index.js');
    expect(missingClient.stderr).toContain('Run: pnpm build');

    mkdirSync(join(distDir, 'node_modules/@qqbot/bot-console-client'), { recursive: true });
    writeFileSync(join(distDir, 'node_modules/@qqbot/bot-console-client/index.js'), 'export {}\n', 'utf8');
    writeFileSync(join(distDir, 'node_modules/@qqbot/bot-console-client/style.css'), 'body{}\n', 'utf8');

    const ok = spawnSync(process.execPath, [scriptPath, '--config', configPath, '--dist', distDir], {
      cwd: dir,
      encoding: 'utf8',
    });

    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('Runtime artifacts verified: 2 local plugins');
  });
});

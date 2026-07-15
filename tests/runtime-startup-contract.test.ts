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
    const viteConfig = readRepoFile('apps/admin-web/vite.config.ts');
    const adminPlugin = readRepoFile('src/plugins/admin-api/index.ts');

    expect(buildScript).toContain('mktemp -d "${TMP_ROOT}/runtime-build-XXXXXX"');
    expect(buildScript).toContain('pnpm exec tsc -p tsconfig.build.json --outDir "$STAGE_DIST"');
    expect(buildScript).toContain('QQBOT_ADMIN_OUT_DIR="$STAGE_ADMIN_DIR" pnpm admin:build');
    expect(buildScript).toContain('cp -R "$ROOT_DIR/src/plugins/affinity/assets/." "$STAGE_DIST/plugins/affinity/assets/"');
    expect(buildScript).toContain('node ./scripts/verify-runtime-artifacts.mjs --config koishi.yml --dist "$STAGE_DIST"');
    expect(buildScript).toContain('mv "$STAGE_DIST" "$NEXT_DIST"');
    expect(buildScript).toContain('mv "$NEXT_DIST" "$DIST_DIR"');
    expect(buildScript).not.toMatch(/rm -rf\s+dist\b/);
    expect(buildScript).not.toMatch(/rm -rf\s+"\$DIST_DIR"/);

    expect(viteConfig).toContain('process.env.QQBOT_ADMIN_OUT_DIR');
    expect(viteConfig).toContain("base: '/'");
    expect(adminPlugin).toContain("assetDir: join(ctx.baseDir, 'dist/admin-web')");
    expect(adminPlugin).not.toContain('ctx.console');
  });

  it('verifies local dist plugin artifacts and independent admin SPA assets', () => {
    const dir = createTempDir();
    const configPath = join(dir, 'koishi.yml');
    const distDir = join(dir, 'dist');
    const scriptPath = resolve(process.cwd(), 'scripts/verify-runtime-artifacts.mjs');

    writeFileSync(
      configPath,
      [
        'plugins:',
        '  group:entry:',
        '    ./dist/plugins/admin-api:admin-api: {}',
        '    ./dist/plugins/reply:voice: {}',
      ].join('\n'),
      'utf8',
    );

    mkdirSync(join(distDir, 'plugins/admin-api'), { recursive: true });
    mkdirSync(join(distDir, 'plugins/reply'), { recursive: true });
    writeFileSync(join(distDir, 'plugins/admin-api/index.js'), 'export {}\n', 'utf8');
    writeFileSync(join(distDir, 'plugins/reply/index.js'), 'export {}\n', 'utf8');

    const missingClient = spawnSync(process.execPath, [scriptPath, '--config', configPath, '--dist', distDir], {
      cwd: dir,
      encoding: 'utf8',
    });

    expect(missingClient.status).toBe(1);
    expect(missingClient.stderr).toContain('Runtime artifacts are missing');
    expect(missingClient.stderr).toContain('admin-web/index.html');
    expect(missingClient.stderr).toContain('Run: pnpm build');

    mkdirSync(join(distDir, 'admin-web'), { recursive: true });
    writeFileSync(join(distDir, 'admin-web/index.html'), '<div id="app"></div>\n', 'utf8');
    mkdirSync(join(distDir, 'admin-web/assets'), { recursive: true });
    writeFileSync(join(distDir, 'admin-web/assets/app.js'), 'export {}\n', 'utf8');
    writeFileSync(join(distDir, 'admin-web/assets/app.css'), 'body{}\n', 'utf8');

    const ok = spawnSync(process.execPath, [scriptPath, '--config', configPath, '--dist', distDir], {
      cwd: dir,
      encoding: 'utf8',
    });

    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('Runtime artifacts verified: 2 local plugins');
  });
});

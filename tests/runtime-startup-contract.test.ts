import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
    const hostVerifier = readRepoFile('scripts/verify-qqbot-host-runtime.sh');
    const koishi = readRepoFile('koishi.yml');
    const ci = readRepoFile('.github/workflows/ci.yml');

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
    expect(smokeScript).toContain('export QQBOT_MODEL_CONFIG_PATH=');
    expect(smokeScript).toContain('export QQBOT_MODEL_CONFIG_KEK_PATH=');
    expect(smokeScript).toContain('export QQBOT_NATURAL_TRIGGER_CONFIG_PATH=');
    expect(smokeScript).toContain('export QQ_VOICE_OUTPUT_LANGUAGE=');
    expect(smokeScript).toContain('memory-v3-cutover.mjs initialize --database "$SQLITE_PATH"');
    expect(smokeScript).toContain('ModelConfigService.fromEnvironment()');
    expect(smokeScript).toContain('await modelConfig.createInitial({');
    expect(smokeScript).toContain('writeNaturalTriggerConfigDocumentAtomic');
    expect(smokeScript).toContain("'./dist/plugins/model-runtime:model-runtime'");
    expect(smokeScript).not.toMatch(/export CHATLUNA_(?:ACTIVE_TAB|PLATFORM|BASE_URL|API_KEY|DEFAULT_MODEL|[A-Z]+_DEFAULT_MODEL|SEARCH_SERVICE_SUMMARY_MODEL)=/u);
    expect(ci).not.toContain('OPENAI_API_KEY');
    expect(ci).not.toContain('OPENAI_MODEL');
    expect(existsSync(resolve(process.cwd(), 'scripts/deepseek-json-probe.mjs'))).toBe(false);
    expect(koishi).toContain('./dist/plugins/model-runtime:model-runtime:');
    expect(koishi).toContain('./dist/plugins/natural-trigger-config:natural-trigger-config:');
    expect(koishi).toContain("configPath: ${{ env.QQBOT_MODEL_CONFIG_PATH || './.runtime/model-config.json' }}");
    expect(koishi).toContain("kekPath: ${{ env.QQBOT_MODEL_CONFIG_KEK_PATH || './.runtime/model-config.kek' }}");
    expect(koishi).toContain('bundledContextPresetDir: ${{ env.CHATLUNA_BUNDLED_CONTEXT_PRESET_DIR }}');
    expect(koishi).toContain('runtimeContextPresetDir: ${{ env.CHATLUNA_RUNTIME_CONTEXT_PRESET_DIR }}');
    expect(koishi).toContain('bundledRolePresetDir: ${{ env.CHATLUNA_BUNDLED_ROLE_PRESET_DIR }}');
    expect(koishi).toContain('runtimeRolePresetDir: ${{ env.CHATLUNA_RUNTIME_ROLE_PRESET_DIR }}');
    expect(koishi).toContain('archiveDir: ${{ env.CHATLUNA_ARCHIVE_DIR }}');
    expect(koishi).not.toContain('CHATLUNA_BUNDLED_CONTEXT_PRESET_DIR ||');
    expect(koishi).not.toContain('CHATLUNA_RUNTIME_CONTEXT_PRESET_DIR ||');
    expect(koishi).not.toContain('CHATLUNA_ARCHIVE_DIR ||');
    expect(hostVerifier).toContain('verify-memory-v3-readiness.mjs');
    expect(hostVerifier).toContain('systemctl show "${KOISHI_UNIT}" --property ControlGroup --value');
    expect(hostVerifier).toContain('if [[ "${MEMORY_ENABLED:-true}" != "false" ]]');
  });

  it('builds runtime artifacts in a staging directory before replacing dist', () => {
    const buildScript = readRepoFile('scripts/build-runtime.sh');
    const viteConfig = readRepoFile('apps/admin-web/vite.config.ts');
    const adminPlugin = readRepoFile('src/plugins/admin-api/index.ts');

    expect(buildScript).toContain('mktemp -d "${TMP_ROOT}/runtime-build-XXXXXX"');
    expect(buildScript).toContain('pnpm exec tsc -p tsconfig.build.json --outDir "$STAGE_DIST"');
    expect(buildScript).toContain('QQBOT_ADMIN_OUT_DIR="$STAGE_ADMIN_DIR" pnpm admin:build');
    expect(buildScript).toContain('cp -R "$ROOT_DIR/src/plugins/affinity/assets/." "$STAGE_DIST/plugins/affinity/assets/"');
    expect(buildScript).toContain(
      'node ./scripts/build-context-preset-cutover-tools.mjs --out-dir "$STAGE_DIST/tools"',
    );
    expect(buildScript).toContain(
      'node ./scripts/build-model-config-cutover-tool.mjs --out-dir "$STAGE_DIST/tools"',
    );
    expect(buildScript).toContain(
      'node ./scripts/build-memory-v3-cutover-tool.mjs --out-dir "$STAGE_DIST/tools"',
    );
    expect(buildScript).toContain(
      'node ./scripts/build-memory-evaluation-tool.mjs --out-dir "$STAGE_DIST/tools"',
    );
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
    mkdirSync(join(dir, 'data/chathub/context-presets'), { recursive: true });
    mkdirSync(join(dir, 'data/chathub/role-presets'), { recursive: true });
    copyFileSync(
      resolve(process.cwd(), 'data/chathub/context-presets/sakiko.yml'),
      join(dir, 'data/chathub/context-presets/sakiko.yml'),
    );
    copyFileSync(
      resolve(process.cwd(), 'data/chathub/role-presets/sakiko.yml'),
      join(dir, 'data/chathub/role-presets/sakiko.yml'),
    );

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
    mkdirSync(join(distDir, 'tools'), { recursive: true });
    writeFileSync(join(distDir, 'tools/context-preset-cutover.mjs'), 'export {}\n', 'utf8');
    writeFileSync(join(distDir, 'tools/context-preset-sqlite.py'), 'raise SystemExit(0)\n', 'utf8');
    writeFileSync(join(distDir, 'tools/model-config-v3-cutover.mjs'), 'export {}\n', 'utf8');
    writeFileSync(join(distDir, 'tools/model-auth-connection-cutover.mjs'), 'export {}\n', 'utf8');
    writeFileSync(join(distDir, 'tools/memory-v3-cutover.mjs'), 'export {}\n', 'utf8');
    writeFileSync(join(distDir, 'tools/memory-evaluation.mjs'), 'export {}\n', 'utf8');
    writeFileSync(join(distDir, 'tools/memory-evaluation-adapter.mjs'), 'export {}\n', 'utf8');

    const ok = spawnSync(process.execPath, [scriptPath, '--config', configPath, '--dist', distDir], {
      cwd: dir,
      encoding: 'utf8',
    });

    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('Runtime artifacts verified: 2 local plugins');

    mkdirSync(join(distDir, 'plugins/memory'), { recursive: true });
    writeFileSync(
      join(distDir, 'plugins/memory/migration.js'),
      'export function runLegacyMemoryMigration() {}\n',
      'utf8',
    );
    const legacyMemory = spawnSync(
      process.execPath,
      [scriptPath, '--config', configPath, '--dist', distDir],
      { cwd: dir, encoding: 'utf8' },
    );
    expect(legacyMemory.status).toBe(2);
    expect(legacyMemory.stderr).toContain('Legacy memory runtime artifact remains');
    rmSync(join(distDir, 'plugins/memory'), { recursive: true, force: true });

    rmSync(join(dir, 'data/chathub/context-presets/sakiko.yml'));
    const emptyCatalog = spawnSync(
      process.execPath,
      [scriptPath, '--config', configPath, '--dist', distDir],
      { cwd: dir, encoding: 'utf8' },
    );
    expect(emptyCatalog.status).toBe(2);
    expect(emptyCatalog.stderr).toContain('bundled context preset catalog must not be empty');
  });
});

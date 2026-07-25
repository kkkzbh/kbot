import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-deploy-runtime-'));
  tempDirs.push(dir);
  return dir;
}

describe('server runtime artifact rendering', () => {
  it('renders PMHQ as a health-bound Quadlet service and removes legacy boot ownership', () => {
    const root = createTempDir();
    const systemdDir = join(root, 'systemd');
    const quadletDir = join(root, 'quadlet');
    const appDir = join(root, 'app/qqbot');
    const dataDir = join(root, 'data');
    const sharedDir = join(root, 'shared');
    mkdirSync(join(systemdDir, 'podman-restart.service.d'), { recursive: true });
    writeFileSync(join(systemdDir, 'qqbot-pmhq.service'), 'legacy\n');
    writeFileSync(join(systemdDir, 'podman-restart.service.d/qqbot-no-global-stop.conf'), 'legacy\n');

    execFileSync('node', [join(process.cwd(), 'deploy/render-systemd.mjs')], {
      env: {
        ...process.env,
        QQBOT_APP_DIR: appDir,
        QQBOT_DATA_DIR: dataDir,
        QQBOT_SHARED_DIR: sharedDir,
        QQBOT_SYSTEMD_DIR: systemdDir,
        QQBOT_QUADLET_DIR: quadletDir,
        PMHQ_BIND_HOST: '127.0.0.1',
        PMHQ_PORT: '13000',
      },
      stdio: 'pipe',
    });

    const quadlet = readFileSync(join(quadletDir, 'qqbot-pmhq.container'), 'utf8');
    const llbot = readFileSync(join(systemdDir, 'qqbot-llbot.service'), 'utf8');
    const koishi = readFileSync(join(systemdDir, 'qqbot-koishi.service'), 'utf8');
    expect(quadlet).toContain('ContainerName=pmhq');
    expect(quadlet).toContain(`EnvironmentFile=${sharedDir}/.env.pmhq`);
    expect(quadlet).toContain(`Volume=${dataDir}/pmhq/QQ:/root/.config/QQ:Z`);
    expect(quadlet).toContain('Notify=healthy');
    expect(quadlet).toContain('HealthOnFailure=kill');
    expect(quadlet).toContain('Restart=on-failure');
    expect(llbot).toContain('Wants=network-online.target qqbot-pmhq.service');
    expect(koishi).toContain('Wants=network-online.target qqbot-llbot.service hbu-webvpn-agent.service');
    expect(koishi).toContain('LoadCredentialEncrypted=hbu-webvpn-broker:/etc/credstore.encrypted/hbu-webvpn-broker.cred');
    expect(koishi).toContain('Environment=HBU_JW_WEBVPN_BROKER_TOKEN_FILE=%d/hbu-webvpn-broker');
    expect(koishi).toContain(`Environment=CHATLUNA_BUNDLED_PRESET_DIR=${appDir}/data/chathub/presets`);
    expect(koishi).toContain(`Environment=CHATLUNA_RUNTIME_PRESET_DIR=${dataDir}/chathub/presets`);
    expect(koishi).toContain(`Environment=CHATLUNA_ARCHIVE_DIR=${dataDir}/chatluna/archive`);
    expect(koishi).toContain(`ExecStartPre=/usr/bin/install -d -m 700 ${dataDir}/chatluna/archive`);
    expect(() => readFileSync(join(systemdDir, 'qqbot-pmhq.service'), 'utf8')).toThrow();
    expect(() => readFileSync(join(systemdDir, 'podman-restart.service.d/qqbot-no-global-stop.conf'), 'utf8')).toThrow();
  });

  it('removes legacy preset environment ownership from shipped templates', () => {
    for (const file of ['.env.example', '.env.server.example']) {
      const content = readFileSync(join(process.cwd(), file), 'utf8');
      expect(content).not.toMatch(/^CHATLUNA_DEFAULT_PRESET=/mu);
      expect(content).not.toMatch(/^CHATLUNA_PRESET_DIRS=/mu);
    }
    expect(readFileSync(join(process.cwd(), '.env.server.example'), 'utf8')).toContain(
      'CHATLUNA_BUNDLED_PRESET_DIR=/opt/qqbot/app/qqbot/data/chathub/presets',
    );
    expect(readFileSync(join(process.cwd(), '.env.server.example'), 'utf8')).toContain(
      'CHATLUNA_RUNTIME_PRESET_DIR=/opt/qqbot/data/chathub/presets',
    );
    expect(readFileSync(join(process.cwd(), '.env.server.example'), 'utf8')).toContain(
      'CHATLUNA_ARCHIVE_DIR=/opt/qqbot/data/chatluna/archive',
    );

    const installer = readFileSync(join(process.cwd(), 'deploy/installer.sh'), 'utf8');
    expect(installer).toContain('remove_env_key "${file}" "CHATLUNA_DEFAULT_PRESET"');
    expect(installer).toContain('remove_env_key "${file}" "CHATLUNA_PRESET_DIRS"');
    expect(installer).toContain('trap stop_target_after_failure EXIT');
    expect(installer).toContain('systemctl stop qqbot.target');
    expect(installer).toContain('start|keep-stopped');
    expect(installer).toContain('"${DATA_DIR}/chatluna/archive"');
    expect(installer).toContain(
      'chmod 700 "${DATA_DIR}" "${SHARED_DIR}" "${DATA_DIR}/chatluna/archive"',
    );
    expect(installer).toContain(
      '"CHATLUNA_BUNDLED_PRESET_DIR=${APP_DIR}/data/chathub/presets"',
    );
    expect(installer).toContain(
      '"CHATLUNA_ARCHIVE_DIR=${DATA_DIR}/chatluna/archive"',
    );
  });
});

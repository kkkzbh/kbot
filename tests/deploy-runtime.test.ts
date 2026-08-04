import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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

function runDeploymentFailureScenario(mode: 'offline' | 'runtime'): {
  action: string;
  database: string;
  stopped: boolean;
} {
  const root = createTempDir();
  const database = join(root, 'koishi.db');
  const snapshot = join(root, 'koishi.snapshot.db');
  const stopped = join(root, 'stack.stopped');
  writeFileSync(database, 'snapshot-state\n');
  writeFileSync(snapshot, 'snapshot-state\n');
  const script = [
    'set -euo pipefail',
    'source "$1"',
    'TEST_DATABASE="$2"',
    'TEST_SNAPSHOT="$3"',
    'TEST_STOPPED="$4"',
    'TEST_MODE="$5"',
    'deployment_transaction_set_previous_app_existed 1',
    'deployment_transaction_begin_offline_activation',
    'deployment_transaction_mark_snapshot_complete',
    'deployment_transaction_mark_app_swap_intent',
    'deployment_transaction_mark_previous_app_moved',
    'deployment_transaction_mark_app_swapped 1',
    'stop_stack() { printf stopped > "${TEST_STOPPED}"; }',
    'restore_offline() { cp -- "${TEST_SNAPSHOT}" "${TEST_DATABASE}"; }',
    'if [[ "${TEST_MODE}" == "runtime" ]]; then',
    '  deployment_transaction_transfer_runtime_ownership',
    '  printf "unrelated-plugin-write\\n" >> "${TEST_DATABASE}"',
    'else',
    '  printf "offline-cutover-mutation\\n" >> "${TEST_DATABASE}"',
    'fi',
    'deployment_transaction_execute_activated_failure stop_stack restore_offline',
    'printf "%s" "${DEPLOYMENT_TRANSACTION_FAILURE_ACTION}"',
  ].join('\n');
  const action = execFileSync(
    'bash',
    [
      '-c',
      script,
      'deployment-fault-harness',
      join(process.cwd(), 'deploy/deployment-transaction.sh'),
      database,
      snapshot,
      stopped,
      mode,
    ],
    { encoding: 'utf8' },
  );
  return {
    action,
    database: readFileSync(database, 'utf8'),
    stopped: readFileSync(stopped, 'utf8') === 'stopped',
  };
}

function runDurableRebootScenario(mode: 'offline' | 'runtime'): {
  database: string;
  enabled: boolean;
  stateExists: boolean;
  gates: string;
} {
  const root = createTempDir();
  const transaction = join(process.cwd(), 'deploy/deployment-transaction.sh');
  const state = join(root, 'deployment.state');
  const database = join(root, 'koishi.db');
  const snapshot = join(root, 'koishi.snapshot.db');
  const enabled = join(root, 'qqbot.target.enabled');
  const gates = join(root, 'gates.log');
  writeFileSync(database, 'legacy-pair\n');
  writeFileSync(snapshot, 'legacy-pair\n');
  writeFileSync(enabled, 'enabled\n');

  const first = spawnSync('bash', ['-c', [
    'set -euo pipefail',
    'source "$1"',
    'TEST_ENABLED="$5"',
    'deployment_transaction_configure "$2" tx-reboot "$3" "$4" full memory-v3 start',
    'inhibit() { rm -f -- "$TEST_ENABLED"; }',
    'verify_inhibited() { [[ ! -e "$TEST_ENABLED" ]]; }',
    'deployment_transaction_begin_offline_activation inhibit verify_inhibited',
    'deployment_transaction_mark_snapshot_complete',
    'printf "v3-published\\n" >> "$6"',
    'if [[ "$7" == runtime ]]; then',
    '  deployment_transaction_mark_app_swap_intent',
    '  deployment_transaction_mark_app_swapped 0',
    '  deployment_transaction_transfer_runtime_ownership',
    'fi',
  ].join('\n'), 'first-installer',
  transaction, state, join(root, 'backup'), join(root, 'preflight.json'), enabled, database, mode]);

  execFileSync('bash', ['-c', [
    'set -euo pipefail',
    'source "$1"',
    'deployment_transaction_load_existing "$2"',
    '[[ ! -e "$5" ]]',
    'if [[ "$7" == offline ]]; then',
    '  [[ "$DEPLOYMENT_TRANSACTION_PHASE" == offline-snapshot-ready ]]',
    '  cp -- "$8" "$6"',
    '  deployment_transaction_mark_restore_verification',
    'else',
    '  [[ "$DEPLOYMENT_TRANSACTION_PHASE" == runtime-bootstrap ]]',
    '  printf "runtime-gate\\n" >> "$9"',
    '  deployment_transaction_mark_runtime_phase runtime-final',
    'fi',
    'touch "$5"',
    'deployment_transaction_complete',
  ].join('\n'), 'second-installer',
  transaction, state, join(root, 'backup'), join(root, 'preflight.json'), enabled, database, mode, snapshot, gates]);

  return {
    database: readFileSync(database, 'utf8'),
    enabled: existsSync(enabled),
    stateExists: existsSync(state),
    gates: existsSync(gates) ? readFileSync(gates, 'utf8') : '',
  };
}

function runAppSwapKillScenario(
  killPoint: 'after-previous-rename' | 'after-new-rename',
): {
  activeApp: string;
  failedNewApp: string | null;
  phase: string;
} {
  const root = createTempDir();
  const transaction = join(process.cwd(), 'deploy/deployment-transaction.sh');
  const state = join(root, 'deployment.state');
  const appRoot = join(root, 'app');
  const workRoot = join(root, 'work');
  const previousRoot = join(root, 'backup/previous-app');
  const failedRoot = join(root, 'backup/failed-new-app');
  mkdirSync(appRoot, { recursive: true });
  mkdirSync(workRoot, { recursive: true });
  mkdirSync(join(root, 'backup'), { recursive: true });
  writeFileSync(join(appRoot, 'version'), 'old-app\n');
  writeFileSync(join(workRoot, 'version'), 'new-app\n');

  const first = spawnSync('bash', ['-c', [
    'set -euo pipefail',
    'source "$1"',
    'deployment_transaction_configure "$2" tx-app-swap "$3" "" full ordinary start',
    'deployment_transaction_set_previous_app_existed 1',
    'deployment_transaction_begin_offline_activation',
    'deployment_transaction_mark_snapshot_complete',
    'APP_ROOT="$4"',
    'WORK_ROOT="$5"',
    'PREVIOUS_ROOT="$6"',
    'KILL_POINT="$7"',
    'mv() {',
    '  command mv "$@"',
    '  if [[ "$1" == "$APP_ROOT" && "$2" == "$PREVIOUS_ROOT" && "$KILL_POINT" == after-previous-rename ]]; then',
    '    exit 91',
    '  fi',
    '  if [[ "$1" == "$WORK_ROOT" && "$2" == "$APP_ROOT" && "$KILL_POINT" == after-new-rename ]]; then',
    '    exit 92',
    '  fi',
    '}',
    'deployment_transaction_swap_application "$APP_ROOT" "$WORK_ROOT" "$PREVIOUS_ROOT"',
  ].join('\n'), 'first-installer',
  transaction, state, join(root, 'backup'), appRoot, workRoot, previousRoot, killPoint], {
    encoding: 'utf8',
  });
  const expectedStatus = killPoint === 'after-previous-rename' ? 91 : 92;
  if (first.status !== expectedStatus) {
    throw new Error(`kill-point installer exited ${String(first.status)}: ${first.stderr}`);
  }

  const phase = execFileSync('bash', ['-c', [
    'set -euo pipefail',
    'source "$1"',
    'deployment_transaction_load_existing "$2"',
    'phase="$DEPLOYMENT_TRANSACTION_PHASE"',
    'deployment_transaction_restore_application "$3" "$4" "$5"',
    'printf "%s" "$phase"',
  ].join('\n'), 'second-installer',
  transaction, state, appRoot, previousRoot, failedRoot], { encoding: 'utf8' });

  return {
    activeApp: readFileSync(join(appRoot, 'version'), 'utf8'),
    failedNewApp: existsSync(join(failedRoot, 'version'))
      ? readFileSync(join(failedRoot, 'version'), 'utf8')
      : null,
    phase,
  };
}

function runDurableSnapshotScenario(): {
  config: string;
  databaseValue: string;
  phase: string;
} {
  const root = createTempDir();
  const transaction = join(process.cwd(), 'deploy/deployment-transaction.sh');
  const state = join(root, 'deployment.state');
  const backup = join(root, 'backup');
  const paths = join(backup, 'paths');
  const config = join(root, 'runtime.conf');
  const database = join(root, 'koishi.db');
  mkdirSync(backup, { recursive: true });
  writeFileSync(config, 'before\n');
  execFileSync('python3', ['-c', [
    'import sqlite3, sys',
    'db = sqlite3.connect(sys.argv[1])',
    'db.execute("CREATE TABLE state (value TEXT NOT NULL)")',
    'db.execute("INSERT INTO state VALUES (?)", ("before",))',
    'db.commit()',
    'db.close()',
  ].join('\n'), database]);

  const phase = execFileSync('bash', ['-c', [
    'set -euo pipefail',
    'source "$1"',
    'deployment_transaction_configure "$2" tx-snapshot "$3" "" full ordinary start',
    'deployment_transaction_begin_offline_activation',
    'deployment_transaction_snapshot_path "$4" config "$5"',
    'deployment_transaction_snapshot_database "$4" "$6"',
    '[[ -f "$4/config/present" ]]',
    '[[ -f "$4/database/present" ]]',
    '[[ -z "$(find "$4" -maxdepth 1 -name ".*.tmp.*" -print -quit)" ]]',
    'deployment_transaction_mark_snapshot_complete',
    'printf "after\\n" > "$5"',
    'python3 - "$6" <<\'PY\'',
    'import sqlite3',
    'import sys',
    'db = sqlite3.connect(sys.argv[1])',
    'db.execute("UPDATE state SET value = ?", ("after",))',
    'db.commit()',
    'db.close()',
    'PY',
    'deployment_transaction_restore_snapshot_path "$4" config "$5"',
    'deployment_transaction_restore_database_snapshot "$4" "$6"',
    'deployment_transaction_validate_sqlite_database "$6"',
    'printf "%s" "$DEPLOYMENT_TRANSACTION_PHASE"',
  ].join('\n'), 'snapshot-harness',
  transaction, state, backup, paths, config, database], { encoding: 'utf8' });

  const databaseValue = execFileSync('python3', ['-c', [
    'import sqlite3, sys',
    'db = sqlite3.connect(sys.argv[1])',
    'print(db.execute("SELECT value FROM state").fetchone()[0], end="")',
    'db.close()',
  ].join('\n'), database], { encoding: 'utf8' });

  return {
    config: readFileSync(config, 'utf8'),
    databaseValue,
    phase,
  };
}

function runBootOwnershipResumeScenario(): {
  enabled: boolean;
  stateAfterFailure: boolean;
  stateAfterResume: boolean;
} {
  const root = createTempDir();
  const transaction = join(process.cwd(), 'deploy/deployment-transaction.sh');
  const state = join(root, 'deployment.state');
  const backup = join(root, 'backup');
  const enabled = join(root, 'qqbot.target.enabled');
  mkdirSync(backup, { recursive: true });

  execFileSync('bash', ['-c', [
    'set -euo pipefail',
    'source "$1"',
    'deployment_transaction_configure "$2" tx-boot "$3" "" full ordinary start',
    'deployment_transaction_set_previous_app_existed 1',
    'deployment_transaction_begin_offline_activation',
    'deployment_transaction_mark_snapshot_complete',
    'deployment_transaction_mark_restore_verification',
    'enable_fails() { return 73; }',
    'if deployment_transaction_complete_after_boot_verification enable_fails; then',
    '  exit 90',
    'fi',
    '[[ -f "$2" ]]',
  ].join('\n'), 'first-installer', transaction, state, backup]);
  const stateAfterFailure = existsSync(state);

  execFileSync('bash', ['-c', [
    'set -euo pipefail',
    'source "$1"',
    'deployment_transaction_load_existing "$2"',
    'ENABLED_PATH="$3"',
    'enable_and_verify() {',
    '  touch "$ENABLED_PATH"',
    '  [[ -f "$ENABLED_PATH" ]]',
    '}',
    'deployment_transaction_complete_after_boot_verification enable_and_verify',
  ].join('\n'), 'second-installer', transaction, state, enabled]);

  return {
    enabled: existsSync(enabled),
    stateAfterFailure,
    stateAfterResume: existsSync(state),
  };
}

function runCorruptSnapshotRestoreScenario(): string {
  const root = createTempDir();
  const transaction = join(process.cwd(), 'deploy/deployment-transaction.sh');
  const paths = join(root, 'backup/paths');
  const database = join(root, 'koishi.db');
  mkdirSync(join(root, 'backup'), { recursive: true });
  execFileSync('python3', ['-c', [
    'import sqlite3, sys',
    'db = sqlite3.connect(sys.argv[1])',
    'db.execute("CREATE TABLE state (value TEXT NOT NULL)")',
    'db.execute("INSERT INTO state VALUES (?)", ("before",))',
    'db.commit()',
    'db.close()',
  ].join('\n'), database]);

  execFileSync('bash', ['-c', [
    'set -euo pipefail',
    'source "$1"',
    'deployment_transaction_snapshot_database "$2" "$3"',
    'python3 - "$3" <<\'PY\'',
    'import sqlite3',
    'import sys',
    'db = sqlite3.connect(sys.argv[1])',
    'db.execute("UPDATE state SET value = ?", ("after",))',
    'db.commit()',
    'db.close()',
    'PY',
    'printf "corrupt" > "$2/database/koishi.db"',
    'if deployment_transaction_restore_database_snapshot "$2" "$3"; then',
    '  exit 90',
    'fi',
    'deployment_transaction_validate_sqlite_database "$3"',
  ].join('\n'), 'corrupt-snapshot-harness', transaction, paths, database], {
    stdio: 'pipe',
  });

  return execFileSync('python3', ['-c', [
    'import sqlite3, sys',
    'db = sqlite3.connect(sys.argv[1])',
    'print(db.execute("SELECT value FROM state").fetchone()[0], end="")',
    'db.close()',
  ].join('\n'), database], { encoding: 'utf8' });
}

describe('deployment transaction ownership', () => {
  it('restores the database while the application stack has never started', () => {
    const result = runDeploymentFailureScenario('offline');

    expect(result.action).toBe('restore-offline-snapshot');
    expect(result.database).toBe('snapshot-state\n');
    expect(result.stopped).toBe(true);
  });

  it('keeps post-start database writes and requires roll-forward after a gate failure', () => {
    const result = runDeploymentFailureScenario('runtime');

    expect(result.action).toBe('stop-and-roll-forward');
    expect(result.database).toBe('snapshot-state\nunrelated-plugin-write\n');
    expect(result.stopped).toBe(true);
  });

  it('survives a reboot after V3 publication and restores the offline snapshot before boot', () => {
    const result = runDurableRebootScenario('offline');

    expect(result.database).toBe('legacy-pair\n');
    expect(result.enabled).toBe(true);
    expect(result.stateExists).toBe(false);
  });

  it('resumes the V3 runtime gate on a second installer run before boot enablement', () => {
    const result = runDurableRebootScenario('runtime');

    expect(result.database).toBe('legacy-pair\nv3-published\n');
    expect(result.gates).toBe('runtime-gate\n');
    expect(result.enabled).toBe(true);
    expect(result.stateExists).toBe(false);
  });

  it('restores the old app when killed immediately after moving APP_ROOT aside', () => {
    const result = runAppSwapKillScenario('after-previous-rename');

    expect(result.phase).toBe('app-swap-intent');
    expect(result.activeApp).toBe('old-app\n');
    expect(result.failedNewApp).toBeNull();
  });

  it('restores the old app and isolates the new app when killed after publishing APP_ROOT', () => {
    const result = runAppSwapKillScenario('after-new-rename');

    expect(result.phase).toBe('app-previous-moved');
    expect(result.activeApp).toBe('old-app\n');
    expect(result.failedNewApp).toBe('new-app\n');
  });

  it('publishes complete path and SQLite snapshots before advancing the durable phase', () => {
    const result = runDurableSnapshotScenario();

    expect(result.phase).toBe('offline-snapshot-ready');
    expect(result.config).toBe('before\n');
    expect(result.databaseValue).toBe('before');
  });

  it('keeps restore state resumable until boot ownership is enabled and verified', () => {
    const result = runBootOwnershipResumeScenario();

    expect(result.stateAfterFailure).toBe(true);
    expect(result.enabled).toBe(true);
    expect(result.stateAfterResume).toBe(false);
  });

  it('rejects a corrupt SQLite snapshot before replacing the live database', () => {
    expect(runCorruptSnapshotRestoreScenario()).toBe('after');
  });
});

describe('Memory V3 process readiness contract', () => {
  it('accepts only a private marker bound to the current service cgroup', () => {
    const root = createTempDir();
    const marker = join(root, 'memory-v3-ready.json');
    const procRoot = join(root, 'proc');
    const script = join(process.cwd(), 'scripts/verify-memory-v3-readiness.mjs');
    mkdirSync(join(procRoot, '4242'), { recursive: true });
    writeFileSync(
      join(procRoot, '4242/cgroup'),
      '0::/system.slice/qqbot-koishi.service\n',
    );
    writeFileSync(marker, JSON.stringify({
      pid: 4242,
      schemaVersion: 3,
      appliedModelRevision: 7,
      extractionModel: 'qqbot-codex/gpt-5.6-luna',
      readyAt: Date.now(),
    }));
    chmodSync(marker, 0o600);

    const valid = execFileSync(process.execPath, [
      script,
      '--marker',
      marker,
      '--cgroup',
      '/system.slice/qqbot-koishi.service',
      '--proc-root',
      procRoot,
    ], { encoding: 'utf8' });
    expect(valid).toContain('pid=4242 schema=3 modelRevision=7');

    writeFileSync(
      join(procRoot, '4242/cgroup'),
      '0::/system.slice/another.service\n',
    );
    expect(() => execFileSync(process.execPath, [
      script,
      '--marker',
      marker,
      '--cgroup',
      '/system.slice/qqbot-koishi.service',
      '--proc-root',
      procRoot,
    ], { stdio: 'pipe' })).toThrow();

    writeFileSync(
      join(procRoot, '4242/cgroup'),
      '0::/system.slice/qqbot-koishi.service\n',
    );
    chmodSync(marker, 0o644);
    expect(() => execFileSync(process.execPath, [
      script,
      '--marker',
      marker,
      '--cgroup',
      '/system.slice/qqbot-koishi.service',
      '--proc-root',
      procRoot,
    ], { stdio: 'pipe' })).toThrow();
  });
});

describe('server runtime artifact rendering', () => {
  it('removes labeled Agent containers while preserving their volumes', () => {
    const root = createTempDir();
    const binDir = join(root, 'bin');
    const podman = join(binDir, 'podman');
    const log = join(root, 'podman.log');
    const removed = join(root, 'removed');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(podman, [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'printf "%s\\n" "$*" >> "${PODMAN_LOG}"',
      'if [[ "$*" == *" ps -aq "* ]]; then',
      '  [[ -f "${PODMAN_REMOVED}" ]] || printf "agent-one\\nagent-two\\n"',
      'elif [[ "$*" == *" rm -f -- agent-one agent-two"* ]]; then',
      '  : > "${PODMAN_REMOVED}"',
      'fi',
    ].join('\n'));
    chmodSync(podman, 0o755);

    execFileSync('bash', [join(process.cwd(), 'scripts/stop-agent-workspace-containers.sh')], {
      env: {
        ...process.env,
        HOME: root,
        XDG_RUNTIME_DIR: join(root, 'run'),
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        PODMAN_LOG: log,
        PODMAN_REMOVED: removed,
      },
    });

    const calls = readFileSync(log, 'utf8');
    expect(calls.match(/ps -aq/gu)).toHaveLength(2);
    expect(calls).toContain('rm -f -- agent-one agent-two');
    expect(calls).not.toContain('rm -v');
  });

  it('renders PMHQ as a health-bound Quadlet service and removes legacy boot ownership', () => {
    const root = createTempDir();
    const systemdDir = join(root, 'systemd');
    const quadletDir = join(root, 'quadlet');
    const journaldDir = join(root, 'journald');
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
        QQBOT_JOURNALD_DROP_IN_DIR: journaldDir,
        PMHQ_BIND_HOST: '127.0.0.1',
        PMHQ_PORT: '13000',
      },
      stdio: 'pipe',
    });

    const quadlet = readFileSync(join(quadletDir, 'qqbot-pmhq.container'), 'utf8');
    const llbot = readFileSync(join(systemdDir, 'qqbot-llbot.service'), 'utf8');
    const koishi = readFileSync(join(systemdDir, 'qqbot-koishi.service'), 'utf8');
    const journald = readFileSync(join(journaldDir, 'qqbot-retention.conf'), 'utf8');
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
    expect(koishi).toContain(`Environment=CHATLUNA_BUNDLED_CONTEXT_PRESET_DIR=${appDir}/data/chathub/context-presets`);
    expect(koishi).toContain(`Environment=CHATLUNA_RUNTIME_CONTEXT_PRESET_DIR=${dataDir}/chathub/context-presets`);
    expect(koishi).toContain(`Environment=CHATLUNA_BUNDLED_ROLE_PRESET_DIR=${appDir}/data/chathub/role-presets`);
    expect(koishi).toContain(`Environment=CHATLUNA_RUNTIME_ROLE_PRESET_DIR=${dataDir}/chathub/role-presets`);
    expect(koishi).toContain(`Environment=CHATLUNA_ARCHIVE_DIR=${dataDir}/chatluna/archive`);
    expect(koishi).toContain(
      `Environment=CHATLUNA_SEARCH_SERVICE_ARTIFACT_DIR=${dataDir}/chatluna/web-artifacts`,
    );
    expect(koishi).toContain(`Environment=CHATLUNA_AGENT_DATA_DIR=${dataDir}/chatluna`);
    expect(koishi).toContain(`ExecStartPre=/usr/bin/install -d -m 700 ${dataDir}/chatluna/archive`);
    expect(koishi).toContain(
      `ExecStartPre=/usr/bin/install -d -m 700 ${dataDir}/chatluna/web-artifacts`,
    );
    expect(koishi).toContain(`ExecStartPre=/usr/bin/install -d -m 700 ${dataDir}/chatluna/agents`);
    expect(koishi).toContain('RuntimeDirectory=qqbot');
    expect(koishi).toContain('RuntimeDirectoryMode=0700');
    expect(koishi).toContain('User=qqbot');
    expect(koishi).toContain('Group=qqbot');
    expect(koishi).toContain('SupplementaryGroups=systemd-journal');
    expect(koishi).toContain(`Environment=HOME=${dataDir}/qqbot-home`);
    expect(koishi).toContain('Environment=XDG_RUNTIME_DIR=/run/qqbot');
    expect(koishi).toContain('Environment=QQBOT_MEMORY_READY_FILE=/run/qqbot/memory-v3-ready.json');
    expect(koishi).toContain('ExecStartPre=/usr/bin/rm -f /run/qqbot/memory-v3-ready.json');
    expect(koishi).toContain(`ExecStop=${appDir}/scripts/stop-agent-workspace-containers.sh`);
    expect(koishi).toContain('TimeoutStopSec=60');
    expect(journald).toContain('Storage=persistent');
    expect(journald).toContain('SystemMaxUse=4G');
    expect(journald).toContain('SystemKeepFree=20G');
    expect(() => readFileSync(join(systemdDir, 'qqbot-pmhq.service'), 'utf8')).toThrow();
    expect(() => readFileSync(join(systemdDir, 'podman-restart.service.d/qqbot-no-global-stop.conf'), 'utf8')).toThrow();
  });

  it('owns independent context and role catalog paths in shipped templates', () => {
    for (const file of ['.env.example', '.env.server.example']) {
      const content = readFileSync(join(process.cwd(), file), 'utf8');
      expect(content).not.toMatch(/^CHATLUNA_DEFAULT_PRESET=/mu);
      expect(content).not.toMatch(/^CHATLUNA_PRESET_DIRS=/mu);
    }
    expect(readFileSync(join(process.cwd(), '.env.server.example'), 'utf8')).toContain(
      'CHATLUNA_BUNDLED_CONTEXT_PRESET_DIR=/opt/qqbot/app/qqbot/data/chathub/context-presets',
    );
    expect(readFileSync(join(process.cwd(), '.env.server.example'), 'utf8')).toContain(
      'CHATLUNA_RUNTIME_CONTEXT_PRESET_DIR=/opt/qqbot/data/chathub/context-presets',
    );
    expect(readFileSync(join(process.cwd(), '.env.server.example'), 'utf8')).toContain(
      'CHATLUNA_BUNDLED_ROLE_PRESET_DIR=/opt/qqbot/app/qqbot/data/chathub/role-presets',
    );
    expect(readFileSync(join(process.cwd(), '.env.server.example'), 'utf8')).toContain(
      'CHATLUNA_RUNTIME_ROLE_PRESET_DIR=/opt/qqbot/data/chathub/role-presets',
    );
    expect(readFileSync(join(process.cwd(), '.env.server.example'), 'utf8')).toContain(
      'CHATLUNA_ARCHIVE_DIR=/opt/qqbot/data/chatluna/archive',
    );
    expect(readFileSync(join(process.cwd(), '.env.server.example'), 'utf8')).toContain(
      'CHATLUNA_SEARCH_SERVICE_ARTIFACT_DIR=/opt/qqbot/data/chatluna/web-artifacts',
    );

    const installer = readFileSync(join(process.cwd(), 'deploy/installer.sh'), 'utf8');
    const deploy = readFileSync(join(process.cwd(), 'deploy/deploy.sh'), 'utf8');
    expect(installer).toContain('remove_env_key "${file}" "CHATLUNA_DEFAULT_PRESET"');
    expect(installer).toContain('remove_env_key "${file}" "CHATLUNA_PRESET_DIRS"');
    expect(installer).toContain('remove_env_key "${file}" "CHATLUNA_BUNDLED_PRESET_DIR"');
    expect(installer).toContain('context-preset-cutover.mjs" preflight');
    expect(installer).toContain('context-preset-cutover.mjs" apply');
    expect(installer).toContain('model-config-v3-cutover.mjs" preflight');
    expect(installer).toContain('model-config-v3-cutover.mjs" apply');
    expect(installer).toContain('memory-v3-cutover.mjs" preflight');
    expect(installer).toContain('memory-v3-cutover.mjs" initialize');
    expect(installer).toContain('MEMORY_V3_INITIALIZE_REQUIRED=1');
    expect(installer).toContain('memory-v3-cutover.mjs" apply');
    expect(installer).not.toContain('bootstrap-verify');
    expect(installer).not.toContain('probe-gate');
    expect(installer).not.toContain('runtime-backfill');
    expect(installer).toContain('AGENT_DATA_ROOT="${DATA_DIR}/chatluna"');
    expect(installer).toContain('PERSISTENT_AGENT_DIR="${AGENT_DATA_ROOT}/agents"');
    expect(installer).toContain('"CHATLUNA_AGENT_DATA_DIR=${AGENT_DATA_ROOT}"');
    expect(installer).toContain('--confirm-service-stopped');
    expect(installer).toContain('remove_env_key "${file}" "MEMORY_EXTRACT_API_KEY"');
    expect(installer).toContain('remove_env_key "${file}" "MEMORY_EMBED_API_KEY"');
    expect(installer).toContain(
      'set_env_key "${ENV_SERVER}" "MEMORY_READ_ENABLED" "true"',
    );
    expect(installer).toContain(
      'set_env_key "${ENV_SERVER}" "MEMORY_WRITE_ENABLED" "false"',
    );
    const memoryPreflight = installer.indexOf('memory-v3-cutover.mjs" preflight');
    const stop = installer.indexOf('stop_deployment_stack', memoryPreflight);
    const memoryApply = installer.indexOf('memory-v3-cutover.mjs" apply', stop);
    const appSwap = installer.indexOf('deployment_transaction_swap_application', memoryApply);
    const runtimeGates = installer.indexOf('run_runtime_gates', appSwap);
    expect(memoryPreflight).toBeGreaterThanOrEqual(0);
    expect(stop).toBeGreaterThan(memoryPreflight);
    expect(memoryApply).toBeGreaterThan(stop);
    expect(appSwap).toBeGreaterThan(memoryApply);
    expect(runtimeGates).toBeGreaterThan(appSwap);
    expect(installer).toContain('trap rollback_after_failure EXIT');
    expect(installer).toContain('deployment_transaction_begin_offline_activation');
    expect(installer).toContain('deployment_transaction_transfer_runtime_ownership');
    expect(installer).toContain('resume_or_recover_deployment_transaction');
    expect(installer).toContain('inhibit_deployment_boot');
    expect(installer).toContain('verify_deployment_boot_inhibited');
    expect(installer).toContain(
      'deployment failed after runtime ownership transfer; no snapshot was restored',
    );
    expect(installer).toContain('systemctl stop qqbot.target');
    expect(installer).toContain('deployment_transaction_snapshot_database');
    expect(installer).toContain('deployment_transaction_restore_database_snapshot');
    expect(installer).toContain('deployment_transaction_swap_application');
    expect(installer).toContain(
      'deployment_transaction_complete_after_boot_verification enable_deployment_boot',
    );
    expect(installer).toContain('previous deployment restored and verified');
    expect(installer).toContain('rollback incomplete; qqbot.target remains stopped');
    expect(installer).toContain('recovery material: ${TRANSACTION_BACKUP_DIR}');
    expect(installer).toContain('start|keep-stopped');
    expect(installer).toContain('"${DATA_DIR}/chatluna/archive"');
    expect(installer).toContain('chmod 700 \\\n  "${DATA_DIR}"');
    expect(installer).toContain('chown root:qqbot "${SHARED_DIR}"');
    expect(installer).toContain('install -d -o qqbot -g qqbot -m 700 "${SHARED_DIR}/backup"');
    expect(installer).toContain('chown qqbot:qqbot "${ENV_RUNTIME}"');
    expect(installer).toContain('chmod 600 "${ENV_RUNTIME}"');
    expect(installer).toContain('chmod 1770 "${SHARED_DIR}"');
    expect(installer).toContain('prepare_model_auth_runtime_ownership()');
    expect(installer).toContain('codex-chatgpt.oauth.json');
    expect(installer).toContain('codex-release-metadata.json');
    expect(installer).toContain('github-copilot.oauth.json');
    expect(installer).toContain('github-copilot.session.json');
    expect(installer).toContain('chown qqbot:qqbot "${state_path}"');
    expect(installer).toContain('chmod 600 "${state_path}"');
    expect(installer).toContain('codex-oauth.bridge-secret');
    expect(installer).toContain('github-copilot.bridge-secret');
    expect(installer).toContain('chown root:qqbot "${secret_path}"');
    expect(installer).toContain('chmod 640 "${secret_path}"');
    expect(installer.indexOf('prepare_model_auth_runtime_ownership\nprepare_koishi_kek_ownership'))
      .toBeGreaterThan(installer.indexOf('stop_deployment_stack'));
    expect(installer).toContain('"${DATA_DIR}/chatluna/web-artifacts"');
    expect(installer).toContain(
      '"CHATLUNA_BUNDLED_CONTEXT_PRESET_DIR=${APP_DIR}/data/chathub/context-presets"',
    );
    expect(installer).toContain(
      '"CHATLUNA_ARCHIVE_DIR=${DATA_DIR}/chatluna/archive"',
    );
    expect(installer).toContain(
      '"CHATLUNA_SEARCH_SERVICE_ARTIFACT_DIR=${DATA_DIR}/chatluna/web-artifacts"',
    );
    expect(installer).toContain('node ./scripts/verify-runtime-artifacts.mjs --config koishi.yml');
    expect(installer).toContain('migrate-agent-workspace-podman.mjs');
    expect(installer).toContain('run_qqbot_podman()');
    expect(installer).toContain('cd "${DATA_DIR}/qqbot-home"');
    expect(installer).toContain('podman --cgroup-manager=cgroupfs "$@"');
    expect(installer).toContain('run_qqbot_podman info --format');
    expect(installer).toContain('run_qqbot_podman build \\');
    expect(installer).toContain('remove_agent_workspace_containers');
    expect(installer).toContain('label=io.qqbot.agent-workspace=true');
    expect(installer).toContain('adopt_runtime_data_ownership');
    expect(installer).toContain('! -path "${DATA_DIR}/qqbot-home" -print0');
    expect(installer).not.toContain('chown -R qqbot:qqbot "${DATA_DIR}"');
    expect(installer.indexOf('remove_agent_workspace_containers\n\n'))
      .toBeGreaterThan(installer.indexOf('stop_deployment_stack\nfi'));
    expect(installer).toContain('prepare_koishi_kek_ownership');
    expect(installer).toContain('QQBOT_MODEL_CONFIG_KEK_PATH \\');
    expect(installer).toContain('CAMPUS_AUTH_CREDENTIAL_KEK_PATH \\');
    expect(installer).toContain('chown qqbot:qqbot "${resolved_path}"');
    expect(installer).toContain('chmod 600 "${resolved_path}"');
    expect(installer.indexOf('prepare_koishi_kek_ownership\ndeployment_transaction_fsync_tree'))
      .toBeGreaterThan(installer.indexOf('find "${SHARED_DIR}" -type f -exec chmod g+r {} +'));
    expect(installer).toContain('require_bundle_catalog "qqbot/data/chathub/context-presets"');
    expect(installer).toContain('require_bundle_catalog "qqbot/data/chathub/role-presets"');
    expect(deploy).toContain('require_bundle_catalog "qqbot/data/chathub/context-presets"');
    expect(deploy).toContain('require_bundle_catalog "qqbot/data/chathub/role-presets"');
    expect(installer).toContain(
      'require_bundle_entry "qqbot/scripts/stop-agent-workspace-containers.sh"',
    );
    expect(deploy).toContain(
      'require_bundle_entry "qqbot/scripts/stop-agent-workspace-containers.sh"',
    );
    expect(deploy).toContain(
      'require_bundle_entry "qqbot/dist/tools/model-config-v3-cutover.mjs"',
    );
    expect(deploy).toContain(
      'require_bundle_entry "qqbot/dist/tools/model-auth-connection-cutover.mjs"',
    );
    expect(deploy).toContain(
      'require_bundle_entry "qqbot/dist/tools/memory-v3-cutover.mjs"',
    );
    expect(deploy).toContain(
      'require_bundle_entry "qqbot/dist/tools/memory-evaluation.mjs"',
    );
    expect(deploy).toContain(
      'require_bundle_entry "qqbot/dist/tools/memory-evaluation-adapter.mjs"',
    );
    expect(installer).toContain(
      'require_bundle_entry "qqbot/dist/tools/memory-evaluation.mjs"',
    );
    expect(installer).toContain(
      'require_bundle_entry "qqbot/dist/tools/memory-evaluation-adapter.mjs"',
    );
    expect(deploy).not.toContain('model-config-contract.mjs');
    expect(deploy).toContain(
      'require_bundle_entry "qqbot/deploy/deployment-transaction.sh"',
    );
    expect(deploy).toContain(
      '${REMOTE_SHARED}/deployment-transaction.state',
    );
  });

  it('migrates the persisted Local workspace configuration to Podman once', () => {
    const root = createTempDir();
    const configDir = join(root, 'agents');
    const configPath = join(configDir, 'config.json');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      version: 4,
      computer: {
        defaultProvider: 'local',
        idleTimeoutMs: 600_000,
        local: { enabled: true, commandTimeoutMs: 45_000 },
        e2b: { enabled: false },
      },
    }));

    const script = join(process.cwd(), 'scripts/migrate-agent-workspace-podman.mjs');
    execFileSync('node', [script, configPath]);
    const migrated = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(migrated.computer).toMatchObject({
      defaultProvider: 'podman',
      podman: {
        enabled: true,
        image: 'localhost/qqbot-agent-workspace:latest',
        memoryMb: 1024,
        pidsLimit: 256,
        commandTimeoutMs: 45_000,
      },
    });
    expect(migrated.computer).not.toHaveProperty('local');

    execFileSync('node', [script, configPath]);
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual(migrated);
  });

  it('executes each context cutover argument once and publishes V3 before the app swap', () => {
    const installerPath = join(process.cwd(), 'deploy/installer.sh');
    const installer = readFileSync(installerPath, 'utf8');
    execFileSync('bash', ['-n', installerPath]);

    const contextBlock = installer.match(
      /if \[\[ "\$\{CONTEXT_PRESET_CUTOVER_REQUIRED\}" == "1" \]\]; then[\s\S]*?\nfi/u,
    )?.[0];
    expect(contextBlock).toBeDefined();
    const output = execFileSync('bash', ['-c', [
      'set -euo pipefail',
      'CONTEXT_PRESET_CUTOVER_REQUIRED=1',
      'STAGE_QQBOT=/stage/qqbot',
      'DATA_DIR=/opt/qqbot/data',
      'APP_DIR=/opt/qqbot/app/qqbot',
      'CONTEXT_PRESET_BACKUP_DIR=/opt/qqbot/backup/context',
      'node() { printf "<%s>\\n" "$@"; }',
      contextBlock!,
    ].join('\n')], { encoding: 'utf8' });
    expect(output.match(/<--confirm-service-stopped>/gu)).toHaveLength(1);

    expect(installer).toContain('if [[ "${MEMORY_SCHEMA_STATE}" == "v2" ]]');
    const modelApply = installer.indexOf('model-config-v3-cutover.mjs" apply');
    const memoryApply = installer.indexOf('memory-v3-cutover.mjs" apply');
    const appSwap = installer.indexOf('deployment_transaction_swap_application');
    expect(modelApply).toBeGreaterThanOrEqual(0);
    expect(memoryApply).toBeGreaterThan(modelApply);
    expect(appSwap).toBeGreaterThan(memoryApply);
  });
});

#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

function envValue(name, fallback = '') {
  const value = process.env[name];
  return value == null || value === '' ? fallback : value;
}

function requireEnv(name) {
  const value = envValue(name);
  if (!value) {
    throw new Error(`missing required environment variable: ${name}`);
  }
  return value;
}

function systemdQuote(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function writeUnit(dir, name, content) {
  writeFileSync(join(dir, name), `${content.trim()}\n`, 'utf8');
  console.log(`[systemd] wrote ${join(dir, name)}`);
}

const appDir = resolve(requireEnv('QQBOT_DEPLOY_APP_DIR'));
const sharedDir = resolve(requireEnv('QQBOT_SHARED_DIR'));
const target = envValue('QQBOT_SYSTEMD_TARGET', 'qqbot.target');
const systemdDir = resolve(envValue('QQBOT_SYSTEMD_DIR', '/etc/systemd/system'));

if (target !== 'qqbot.target') {
  console.log(`[systemd] custom target ${target}; leaving existing unit files unchanged`);
  process.exit(0);
}

mkdirSync(systemdDir, { recursive: true });

const envServer = `${sharedDir}/.env.server`;
const envRuntime = `${sharedDir}/.env.runtime`;
const app = systemdQuote(appDir);
const shared = systemdQuote(sharedDir);

writeUnit(
  systemdDir,
  'qqbot-pmhq.service',
  `
[Unit]
Description=QQBot PMHQ Service
After=network-online.target
Wants=network-online.target
PartOf=qqbot.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=${app}
EnvironmentFile=${envServer}
EnvironmentFile=-${envRuntime}
Environment=CONTAINERS_CONF=${app}/config/podman/containers.conf
Environment=QQBOT_ENV_BASE_FILE=${envServer}
Environment=QQBOT_ENV_OVERRIDE_FILE=${envRuntime}
ExecStartPre=/usr/bin/env bash -lc "podman rm -f qqbot-voice-asr >/dev/null 2>&1 || true"
ExecStart=/usr/bin/env bash -lc 'cd "${app}" && ./scripts/podman-pmhq-service.sh up'
ExecStop=/usr/bin/env bash -lc 'cd "${app}" && ./scripts/podman-pmhq-service.sh stop'

[Install]
WantedBy=qqbot.target
`,
);

writeUnit(
  systemdDir,
  'qqbot-llbot.service',
  `
[Unit]
Description=QQBot LLBot Service
After=network-online.target qqbot-pmhq.service
Wants=network-online.target qqbot-pmhq.service
PartOf=qqbot.target

[Service]
Type=simple
WorkingDirectory=${app}
EnvironmentFile=${envServer}
EnvironmentFile=-${envRuntime}
ExecStart=/usr/bin/env bash -lc 'cd "${app}" && exec ./scripts/run-llbot-host.sh'
Restart=always
RestartSec=5

[Install]
WantedBy=qqbot.target
`,
);

writeUnit(
  systemdDir,
  'qqbot-koishi.service',
  `
[Unit]
Description=QQBot Koishi Service
After=network-online.target qqbot-llbot.service
Wants=network-online.target qqbot-llbot.service
PartOf=qqbot.target qqbot-llbot.service

[Service]
Type=simple
WorkingDirectory=${app}
EnvironmentFile=${envServer}
EnvironmentFile=-${envRuntime}
Environment=QQBOT_ENV_BASE_FILE=${envServer}
Environment=QQBOT_ENV_OVERRIDE_FILE=${envRuntime}
Environment=CHATLUNA_PRESET_DIRS=${shared}/presets:${app}/data/chathub/presets
Environment=CHATLUNA_RUNTIME_PRESET_DIR=${shared}/presets
ExecStart=/usr/bin/env bash -lc 'cd "${app}" && exec pnpm start:server'
Restart=always
RestartSec=5

[Install]
WantedBy=qqbot.target
`,
);

writeUnit(
  systemdDir,
  'qqbot.target',
  `
[Unit]
Description=QQBot Full Stack Target
Wants=qqbot-pmhq.service qqbot-llbot.service qqbot-koishi.service
After=qqbot-pmhq.service qqbot-llbot.service

[Install]
WantedBy=multi-user.target
`,
);

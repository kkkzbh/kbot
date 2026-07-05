#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

function envValue(name, fallback = '') {
  const value = process.env[name];
  return value == null || value === '' ? fallback : value;
}

function requireEnv(name) {
  const value = envValue(name);
  if (!value) throw new Error(`missing required environment variable: ${name}`);
  return value;
}

function quote(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function writeUnit(dir, name, content) {
  writeFileSync(join(dir, name), `${content.trim()}\n`, 'utf8');
  console.log(`[systemd] wrote ${join(dir, name)}`);
}

const appDir = resolve(requireEnv('QQBOT_APP_DIR'));
const dataDir = resolve(requireEnv('QQBOT_DATA_DIR'));
const sharedDir = resolve(requireEnv('QQBOT_SHARED_DIR'));
const systemdDir = resolve(envValue('QQBOT_SYSTEMD_DIR', '/etc/systemd/system'));
const envServer = `${sharedDir}/.env.server`;
const envRuntime = `${sharedDir}/.env.runtime`;
const app = quote(appDir);
const data = quote(dataDir);
const server = quote(envServer);
const runtime = quote(envRuntime);

mkdirSync(systemdDir, { recursive: true });

writeUnit(systemdDir, 'qqbot-pmhq.service', `
[Unit]
Description=QQBot PMHQ Service
After=network-online.target
Wants=network-online.target
PartOf=qqbot.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=${app}
EnvironmentFile=${server}
EnvironmentFile=-${runtime}
Environment=CONTAINERS_CONF=${app}/config/podman/containers.conf
Environment=QQBOT_ENV_BASE_FILE=${server}
Environment=QQBOT_ENV_OVERRIDE_FILE=${runtime}
ExecStartPre=/usr/bin/env bash -lc 'mkdir -p "${data}/pmhq/QQ"'
ExecStart=/usr/bin/env bash -lc 'cd "${app}" && ./scripts/podman-pmhq-service.sh up'
ExecStop=/usr/bin/env bash -lc 'cd "${app}" && ./scripts/podman-pmhq-service.sh stop'

[Install]
WantedBy=qqbot.target
`);

writeUnit(systemdDir, 'qqbot-llbot.service', `
[Unit]
Description=QQBot LLBot Service
After=network-online.target qqbot-pmhq.service
Wants=network-online.target qqbot-pmhq.service
PartOf=qqbot.target

[Service]
Type=simple
WorkingDirectory=${app}
EnvironmentFile=${server}
EnvironmentFile=-${runtime}
ExecStart=/usr/bin/env bash -lc 'cd "${app}" && exec ./scripts/run-llbot-host.sh'
Restart=always
RestartSec=5

[Install]
WantedBy=qqbot.target
`);

writeUnit(systemdDir, 'qqbot-koishi.service', `
[Unit]
Description=QQBot Koishi Service
After=network-online.target qqbot-llbot.service
Wants=network-online.target qqbot-llbot.service
PartOf=qqbot.target qqbot-llbot.service

[Service]
Type=simple
WorkingDirectory=${app}
EnvironmentFile=${server}
EnvironmentFile=-${runtime}
Environment=QQBOT_ENV_BASE_FILE=${server}
Environment=QQBOT_ENV_OVERRIDE_FILE=${runtime}
Environment=CHATLUNA_PRESET_DIRS=${data}/chathub/presets:${app}/data/chathub/presets
Environment=CHATLUNA_RUNTIME_PRESET_DIR=${data}/chathub/presets
ExecStart=/usr/bin/env bash -lc 'cd "${app}" && exec pnpm start:server'
Restart=always
RestartSec=5

[Install]
WantedBy=qqbot.target
`);

writeUnit(systemdDir, 'qqbot.target', `
[Unit]
Description=QQBot Full Stack Target
Wants=qqbot-pmhq.service qqbot-llbot.service qqbot-koishi.service
After=qqbot-pmhq.service qqbot-llbot.service

[Install]
WantedBy=multi-user.target
`);

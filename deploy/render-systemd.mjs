#!/usr/bin/env node
import { existsSync, mkdirSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
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
const quadletDir = resolve(envValue('QQBOT_QUADLET_DIR', '/etc/containers/systemd'));
const envServer = `${sharedDir}/.env.server`;
const envRuntime = `${sharedDir}/.env.runtime`;
const cloudflaredHbuJwTokenFile = resolve(envValue('QQBOT_CLOUDFLARED_HBU_JW_TOKEN_FILE', '/etc/cloudflared/qqbot-hbu-jw.token'));
const cloudflaredGenshinTokenFile = resolve(envValue('QQBOT_CLOUDFLARED_GENSHIN_TOKEN_FILE', '/etc/cloudflared/qqbot-genshin.token'));
const hbuWebVpnBrokerCredential = resolve(envValue('QQBOT_HBU_WEBVPN_BROKER_CREDENTIAL', '/etc/credstore.encrypted/hbu-webvpn-broker.cred'));
const cloudflaredOriginUrl = envValue('QQBOT_CLOUDFLARED_ORIGIN_URL', 'http://127.0.0.1:5140');
const app = quote(appDir);
const data = quote(dataDir);
const server = quote(envServer);
const runtime = quote(envRuntime);
const hbuJwToken = quote(cloudflaredHbuJwTokenFile);
const genshinToken = quote(cloudflaredGenshinTokenFile);
const hbuBrokerCredential = quote(hbuWebVpnBrokerCredential);
const cloudflaredOrigin = quote(cloudflaredOriginUrl);
const pmhqImage = envValue('PMHQ_IMAGE', 'docker.io/linyuchen/pmhq');
const pmhqTag = envValue('PMHQ_TAG', 'latest');
const pmhqBindHost = envValue('PMHQ_BIND_HOST', '127.0.0.1');
const pmhqPort = envValue('PMHQ_PORT', '13000');

if (pmhqBindHost !== '127.0.0.1') throw new Error('server PMHQ_BIND_HOST must be 127.0.0.1');
if (!/^\d{2,5}$/.test(pmhqPort) || Number(pmhqPort) > 65535) throw new Error('invalid PMHQ_PORT');
if (!/^[A-Za-z0-9._/:@-]+$/.test(pmhqImage) || !/^[A-Za-z0-9._-]+$/.test(pmhqTag)) {
  throw new Error('invalid PMHQ image reference');
}

mkdirSync(systemdDir, { recursive: true });
mkdirSync(quadletDir, { recursive: true });

const podmanRestartDropInDir = join(systemdDir, 'podman-restart.service.d');
const legacyPodmanRestartDropIn = join(podmanRestartDropInDir, 'qqbot-no-global-stop.conf');
const legacyPmhqUnit = join(systemdDir, 'qqbot-pmhq.service');
for (const file of [legacyPodmanRestartDropIn, legacyPmhqUnit]) {
  if (!existsSync(file)) continue;
  rmSync(file);
  console.log(`[systemd] removed obsolete ${file}`);
}
try {
  rmdirSync(podmanRestartDropInDir);
} catch (error) {
  if (error?.code !== 'ENOENT' && error?.code !== 'ENOTEMPTY') throw error;
}

writeUnit(quadletDir, 'qqbot-pmhq.container', `
[Unit]
Description=QQBot PMHQ Service
After=network-online.target
Wants=network-online.target

[Container]
Image=${pmhqImage}:${pmhqTag}
ContainerName=pmhq
PublishPort=${pmhqBindHost}:${pmhqPort}:13000
EnvironmentFile=${sharedDir}/.env.pmhq
Volume=${dataDir}/pmhq/QQ:/root/.config/QQ:Z
HealthCmd=curl -f http://localhost:13000/health
HealthInterval=30s
HealthTimeout=10s
HealthRetries=3
HealthStartPeriod=40s
HealthOnFailure=kill
Notify=healthy
Pull=newer

[Service]
WorkingDirectory=${app}
Environment=CONTAINERS_CONF=${app}/config/podman/containers.conf
ExecStartPre=/usr/bin/env bash -lc 'mkdir -p "${data}/pmhq/QQ"'
ExecStartPre=${app}/scripts/wait-pmhq-login-network.sh
Restart=on-failure
RestartSec=5
TimeoutStartSec=240
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
After=network-online.target qqbot-llbot.service hbu-webvpn-agent.service
Wants=network-online.target qqbot-llbot.service hbu-webvpn-agent.service
PartOf=qqbot.target qqbot-llbot.service

[Service]
Type=simple
WorkingDirectory=${app}
EnvironmentFile=${server}
EnvironmentFile=-${runtime}
Environment=QQBOT_ENV_BASE_FILE=${server}
Environment=QQBOT_ENV_OVERRIDE_FILE=${runtime}
Environment=CHATLUNA_BUNDLED_CONTEXT_PRESET_DIR=${app}/data/chathub/context-presets
Environment=CHATLUNA_RUNTIME_CONTEXT_PRESET_DIR=${data}/chathub/context-presets
Environment=CHATLUNA_BUNDLED_ROLE_PRESET_DIR=${app}/data/chathub/role-presets
Environment=CHATLUNA_RUNTIME_ROLE_PRESET_DIR=${data}/chathub/role-presets
Environment=CHATLUNA_ARCHIVE_DIR=${data}/chatluna/archive
Environment=CHATLUNA_SEARCH_SERVICE_ARTIFACT_DIR=${data}/chatluna/web-artifacts
Environment=CHATLUNA_AGENT_DATA_DIR=${data}/chatluna
LoadCredentialEncrypted=hbu-webvpn-broker:${hbuBrokerCredential}
Environment=HBU_JW_WEBVPN_BROKER_TOKEN_FILE=%d/hbu-webvpn-broker
ExecStartPre=/usr/bin/install -d -m 700 ${data}/chatluna/archive
ExecStartPre=/usr/bin/install -d -m 700 ${data}/chatluna/web-artifacts
ExecStartPre=/usr/bin/install -d -m 700 ${data}/chatluna/agents
ExecStart=/usr/bin/env bash -lc 'cd "${app}" && exec pnpm start:server'
Restart=always
RestartSec=5

[Install]
WantedBy=qqbot.target
`);

writeUnit(systemdDir, 'cloudflared-qqbot-hbu-jw.service', `
[Unit]
Description=Cloudflare Tunnel qqbot-hbu-jw
After=network-online.target
Wants=network-online.target
PartOf=qqbot.target

[Service]
Type=simple
ExecStart=/usr/local/bin/cloudflared tunnel --no-autoupdate run --token-file ${hbuJwToken} --url ${cloudflaredOrigin}
Restart=always
RestartSec=5

[Install]
WantedBy=qqbot.target
`);

writeUnit(systemdDir, 'cloudflared-qqbot-genshin.service', `
[Unit]
Description=Cloudflare Tunnel qqbot-genshin
After=network-online.target
Wants=network-online.target
PartOf=qqbot.target

[Service]
Type=simple
ExecStart=/usr/local/bin/cloudflared tunnel --no-autoupdate run --token-file ${genshinToken} --url ${cloudflaredOrigin}
Restart=always
RestartSec=5

[Install]
WantedBy=qqbot.target
`);

writeUnit(systemdDir, 'qqbot.target', `
[Unit]
Description=QQBot Application Stack Target
Wants=qqbot-llbot.service qqbot-koishi.service cloudflared-qqbot-hbu-jw.service cloudflared-qqbot-genshin.service
After=qqbot-llbot.service

[Install]
WantedBy=multi-user.target
`);

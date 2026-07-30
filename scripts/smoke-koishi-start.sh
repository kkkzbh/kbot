#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

./scripts/ensure-chatluna-build.sh --check
node ./scripts/verify-runtime-artifacts.mjs --config koishi.yml

mkdir -p "$ROOT_DIR/.runtime"
SMOKE_RUNTIME_DIR="$(mktemp -d "$ROOT_DIR/.runtime/koishi-smoke-XXXXXX")"
LOG_FILE="$SMOKE_RUNTIME_DIR/koishi.log"
TMP_KOISHI_YML="$SMOKE_RUNTIME_DIR/koishi.yml"
export QQBOT_MODEL_CONFIG_PATH="$SMOKE_RUNTIME_DIR/model-config.json"
export QQBOT_MODEL_CONFIG_KEK_PATH="$SMOKE_RUNTIME_DIR/model-config.kek"
export QQBOT_NATURAL_TRIGGER_CONFIG_PATH="$SMOKE_RUNTIME_DIR/natural-trigger.json"
export SQLITE_PATH="$SMOKE_RUNTIME_DIR/koishi.db"
export CHATLUNA_AGENT_DATA_DIR="$SMOKE_RUNTIME_DIR/chatluna"
export CHATLUNA_COMMON_FS=true
export CHATLUNA_COMMON_FS_SCOPE_PATH="$SMOKE_RUNTIME_DIR/computer"

cleanup() {
  rm -rf -- "$SMOKE_RUNTIME_DIR"
}
trap cleanup EXIT

# Provide deterministic minimal runtime env for local/CI smoke start.
export ONEBOT_SELF_ID="${ONEBOT_SELF_ID:-100000001}"
export ONEBOT_TOKEN="${ONEBOT_TOKEN:-}"
if [[ -z "${KOISHI_PORT:-}" ]]; then
  export KOISHI_PORT="$(
    python - <<'PY'
import socket
s = socket.socket()
s.bind(('127.0.0.1', 0))
print(s.getsockname()[1])
s.close()
PY
  )"
else
  export KOISHI_PORT
fi
export TASK_AUTOMATION_INTENT_ENABLED="${TASK_AUTOMATION_INTENT_ENABLED:-false}"
export CHATLUNA_SEARCH_SERVICE_ENABLED="${CHATLUNA_SEARCH_SERVICE_ENABLED:-true}"
export CHATLUNA_SEARCH_SERVICE_MODE="${CHATLUNA_SEARCH_SERVICE_MODE:-live}"
export CHATLUNA_SEARCH_SERVICE_TOPK="${CHATLUNA_SEARCH_SERVICE_TOPK:-5}"
export CHATLUNA_SEARCH_SERVICE_PER_DOMAIN_LIMIT="${CHATLUNA_SEARCH_SERVICE_PER_DOMAIN_LIMIT:-2}"
export CHATLUNA_SEARCH_SERVICE_TAVILY_API_KEY="${CHATLUNA_SEARCH_SERVICE_TAVILY_API_KEY:-tvly-ci-smoke}"
export CHATLUNA_SEARCH_SERVICE_ARTIFACT_DIR="${CHATLUNA_SEARCH_SERVICE_ARTIFACT_DIR:-$SMOKE_RUNTIME_DIR/web-artifacts}"
export CHATLUNA_BUNDLED_CONTEXT_PRESET_DIR="${CHATLUNA_BUNDLED_CONTEXT_PRESET_DIR:-$ROOT_DIR/data/chathub/context-presets}"
export CHATLUNA_RUNTIME_CONTEXT_PRESET_DIR="${CHATLUNA_RUNTIME_CONTEXT_PRESET_DIR:-$SMOKE_RUNTIME_DIR/context-presets}"
export CHATLUNA_BUNDLED_ROLE_PRESET_DIR="${CHATLUNA_BUNDLED_ROLE_PRESET_DIR:-$ROOT_DIR/data/chathub/role-presets}"
export CHATLUNA_RUNTIME_ROLE_PRESET_DIR="${CHATLUNA_RUNTIME_ROLE_PRESET_DIR:-$SMOKE_RUNTIME_DIR/role-presets}"
export CHATLUNA_ARCHIVE_DIR="${CHATLUNA_ARCHIVE_DIR:-$SMOKE_RUNTIME_DIR/archive}"
export QQ_VOICE_INPUT_ENABLED="${QQ_VOICE_INPUT_ENABLED:-false}"
export QQ_VOICE_OUTPUT_ENABLED="${QQ_VOICE_OUTPUT_ENABLED:-false}"
export QQ_VOICE_OUTPUT_LANGUAGE="${QQ_VOICE_OUTPUT_LANGUAGE:-zh}"
export QQBOT_ADMIN_ORIGIN="${QQBOT_ADMIN_ORIGIN:-http://127.0.0.1:${KOISHI_PORT}}"
export QQBOT_ADMIN_SSH_ORIGIN="${QQBOT_ADMIN_SSH_ORIGIN:-http://127.0.0.1:${KOISHI_PORT}}"
mkdir -p "$CHATLUNA_COMMON_FS_SCOPE_PATH"
mkdir -p "$CHATLUNA_AGENT_DATA_DIR/agents"

node --input-type=module <<'NODE'
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

await writeFile(
  join(process.env.CHATLUNA_AGENT_DATA_DIR, 'agents/config.json'),
  `${JSON.stringify({
    version: 4,
    computer: {
      defaultProvider: 'local',
      local: {
        enabled: true,
        sandboxMode: 'workspace-write',
        approvalMode: 'never',
        dangerouslySkipPermissions: true,
        scopePath: process.env.CHATLUNA_COMMON_FS_SCOPE_PATH,
        networkPolicy: 'allow',
      },
    },
  }, null, 2)}\n`,
  'utf8',
);
NODE

python - "$SQLITE_PATH" <<'PY'
import json
import sqlite3
import sys

connection = sqlite3.connect(sys.argv[1])
connection.execute(
    '''
    CREATE TABLE chatluna_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updatedAt DATETIME NOT NULL
    )
    '''
)
connection.execute(
    '''
    INSERT INTO chatluna_meta (key, value, updatedAt)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ''',
    ('globalDefaultPresetId', json.dumps('sakiko')),
)
connection.commit()
connection.close()
PY

node ./dist/tools/memory-v3-cutover.mjs initialize --database "$SQLITE_PATH"

node --input-type=module <<'NODE'
import { ModelConfigService } from './dist/plugins/model-config/index.js';

const modelConfig = ModelConfigService.fromEnvironment();
await modelConfig.createInitial({
  draft: {
    connections: [
      {
        id: 'smoke',
        displayName: 'Smoke',
        adapter: 'openaiCompatible',
        baseUrl: 'https://models.example.test/v1',
        auth: {
          kind: 'apiKey',
          secretRef: 'connection:smoke:api-key',
        },
        catalogDriver: 'static',
      },
    ],
    models: [
      {
        id: 'chat',
        connectionId: 'smoke',
        displayName: 'Smoke Chat',
        transportModel: 'smoke-chat',
        contextSize: 131072,
        requestMode: 'chat_completions',
        structuredOutputProtocol: 'native_chat_json_schema',
        capabilities: {
          vision: true,
          tools: true,
          structuredOutput: true,
        },
        timeoutMs: 30000,
        requestDefaults: {},
      },
    ],
    bindings: [
      {
        workload: 'main.chat',
        mode: 'dedicated',
        connectionId: 'smoke',
        modelId: 'chat',
      },
      {
        workload: 'memory.extract',
        mode: 'dedicated',
        connectionId: 'smoke',
        modelId: 'chat',
      },
      { workload: 'affinity.analysis', mode: 'inheritMain' },
      { workload: 'naturalTrigger.decision', mode: 'disabled' },
      { workload: 'agent.subagent.default', mode: 'inheritInvocation' },
      { workload: 'sticker.index', mode: 'disabled' },
    ],
  },
  apiKeys: {
    smoke: 'sk-ci-smoke',
  },
});
NODE

node --input-type=module <<'NODE'
import { writeNaturalTriggerConfigDocumentAtomic } from './dist/plugins/natural-trigger-config/store.js';

await writeNaturalTriggerConfigDocumentAtomic(
  process.env.QQBOT_NATURAL_TRIGGER_CONFIG_PATH,
  {
    schemaVersion: 1,
    savedRevision: 1,
    appliedRevision: 0,
    updatedAt: new Date().toISOString(),
    config: {
      enabled: false,
      allowedGroupIds: [],
      voiceAdmission: { enabled: false },
      mechanisms: {
        quote: { enabled: true },
        alias: { enabled: false, aliases: [] },
        heuristic: { enabled: false },
        focus: { enabled: false, windowMs: 0 },
        random: { enabled: false, probability: 0 },
      },
      modelDecision: { minConfidence: 0.62 },
      pacing: { minReplyIntervalMs: 0 },
      antiSpam: {
        enabled: false,
        windowMs: 10000,
        threshold: 10,
        muteMs: 180000,
      },
    },
  },
);
NODE

cp koishi.yml "$TMP_KOISHI_YML"

node --input-type=module - "$TMP_KOISHI_YML" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';

const filePath = process.argv[2];
const config = YAML.parse(readFileSync(filePath, 'utf8'));
const entry = config?.plugins?.['group:entry'];

if (!entry || typeof entry !== 'object') {
  throw new Error('Invalid koishi.yml: missing plugins.group:entry');
}

const keep = new Set([
  'http:main',
  'server:0b8t2q',
  './dist/plugins/console-access:agent-console-access',
  'console:agent-console',
  './dist/plugins/admin-api:admin-api',
  'database-sqlite:8jr5yp',
  './dist/plugins/model-runtime:model-runtime',
  './dist/plugins/natural-trigger-config:natural-trigger-config',
  './dist/plugins/prompt-fragment-policy:prompt-fragment-policy',
  './dist/plugins/feature-policy:feature-policy',
  './dist/plugins/tool-policy:tool-policy',
  'cron:task',
  './dist/plugins/automation:automation',
  './dist/plugins/reply:voice',
  'chatluna:0qm1bk',
  'chatluna-agent:computer-agent',
  'puppeteer:0vx5c7',
  'chatluna-web-run-service:web',
  './dist/plugins/sticker:sticker',
  './dist/plugins/model-guard:mjddgg',
  './dist/plugins/memory:memory',
]);

for (const key of Object.keys(entry)) {
  if (!keep.has(key)) {
    delete entry[key];
  }
}

for (const [key, value] of Object.entries(entry)) {
  if (!key.startsWith('./dist/')) {
    continue;
  }

  const separator = key.indexOf(':');
  const pluginPath = separator === -1 ? key : key.slice(0, separator);
  const qualifier = separator === -1 ? '' : key.slice(separator);
  delete entry[key];
  entry[`${resolve(process.cwd(), pluginPath)}${qualifier}`] = value;
}

writeFileSync(filePath, YAML.stringify(config), 'utf8');
NODE

set +e
timeout 25s pnpm exec koishi start "$TMP_KOISHI_YML" >"$LOG_FILE" 2>&1 &
koishi_pid=$!
set -e

set +e
node --input-type=module <<'NODE'
import { request } from 'node:http';
import WebSocket from 'ws';

const baseUrl = `http://127.0.0.1:${process.env.KOISHI_PORT}`;
const requiredTools = ['skill', 'file_read', 'bash'];
let lastDetail = 'Koishi HTTP server did not become ready';

function requestStatusWithHost(path, host) {
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: '127.0.0.1',
      port: Number(process.env.KOISHI_PORT),
      path,
      headers: { host },
    }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode ?? 0));
    });
    req.once('error', reject);
    req.end();
  });
}

for (let attempt = 0; attempt < 60; attempt += 1) {
  try {
    const policiesResponse = await fetch(`${baseUrl}/api/admin/v1/policies`);
    if (!policiesResponse.ok) {
      lastDetail = `policies endpoint returned HTTP ${policiesResponse.status}`;
    } else {
      const policies = await policiesResponse.json();
      const catalog = Array.isArray(policies?.tools?.catalog) ? policies.tools.catalog : [];
      const registered = new Map(catalog.map((tool) => [tool.toolName, tool.registered === true]));
      const missing = requiredTools.filter((name) => registered.get(name) !== true);
      if (missing.length === 0) {
        const consoleResponse = await fetch(`${baseUrl}/koishi-console/`);
        if (!consoleResponse.ok) {
          throw new Error(`Console endpoint returned HTTP ${consoleResponse.status}`);
        }
        const publicStatus = await requestStatusWithHost('/koishi-console/', 'jw.public.example');
        if (publicStatus !== 421) {
          throw new Error(`public Console Host was not rejected: HTTP ${publicStatus}`);
        }
        const publicWebSocketCloseCode = await new Promise((resolve, reject) => {
          const socket = new WebSocket(
            `ws://127.0.0.1:${process.env.KOISHI_PORT}/koishi-console/status`,
            { headers: { host: 'jw.public.example' } },
          );
          const timeout = setTimeout(() => {
            socket.terminate();
            reject(new Error('public Console WebSocket remained open'));
          }, 2000);
          socket.once('close', (code) => {
            clearTimeout(timeout);
            resolve(code);
          });
          socket.once('error', (error) => {
            clearTimeout(timeout);
            reject(error);
          });
        });
        if (publicWebSocketCloseCode !== 1008) {
          throw new Error(`public Console WebSocket closed with code ${publicWebSocketCloseCode}`);
        }
        console.log(`ChatLuna runtime registered tools: ${requiredTools.join(', ')}`);
        process.exit(0);
      }
      lastDetail = `tools not registered yet: ${missing.join(', ')}`;
    }
  } catch (error) {
    lastDetail = error instanceof Error ? error.message : String(error);
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}

throw new Error(lastDetail);
NODE
probe_exit_code=$?
wait "$koishi_pid"
exit_code=$?
set -e

cat "$LOG_FILE"

# 25s timeout is expected for smoke startup.
if [[ "$exit_code" -ne 0 && "$exit_code" -ne 124 ]]; then
  echo "Koishi smoke startup exited unexpectedly with code: $exit_code" >&2
  exit "$exit_code"
fi

if [[ "$probe_exit_code" -ne 0 ]]; then
  echo "Koishi smoke startup did not expose the required ChatLuna Agent tools." >&2
  exit "$probe_exit_code"
fi

if grep -nE "cannot resolve plugin|property database is not registered|TypeError: Cannot read properties of undefined|\\[W\\] app Error:|\\[E\\] app " "$LOG_FILE" >/dev/null; then
  echo "Koishi smoke startup detected runtime errors in logs." >&2
  exit 1
fi

if ! grep -F "dist/plugins/automation:automation" "$LOG_FILE" >/dev/null; then
  echo "Koishi smoke startup did not load task-automation plugin." >&2
  exit 1
fi

if ! grep -F "dist/plugins/model-runtime:model-runtime" "$LOG_FILE" >/dev/null; then
  echo "Koishi smoke startup did not load model-runtime plugin." >&2
  exit 1
fi

if ! grep -F "dist/plugins/reply:voice" "$LOG_FILE" >/dev/null; then
  echo "Koishi smoke startup did not load qq-voice plugin." >&2
  exit 1
fi

if ! grep -F "loader apply plugin chatluna-web-run-service:web" "$LOG_FILE" >/dev/null; then
  echo "Koishi smoke startup did not load chatluna-web-run-service plugin." >&2
  exit 1
fi

if ! grep -F "registered web_run capabilities=" "$LOG_FILE" >/dev/null; then
  echo "Koishi smoke startup did not register web_run." >&2
  exit 1
fi

if ! grep -F "dist/plugins/model-guard" "$LOG_FILE" >/dev/null; then
  echo "Koishi smoke startup did not load chatluna-model-guard plugin." >&2
  exit 1
fi

if ! grep -F "dist/plugins/memory:memory" "$LOG_FILE" >/dev/null; then
  echo "Koishi smoke startup did not load memory plugin." >&2
  exit 1
fi

if ! grep -F "dist/plugins/admin-api:admin-api" "$LOG_FILE" >/dev/null; then
  echo "Koishi smoke startup did not load admin-api plugin." >&2
  exit 1
fi

if ! grep -F "loader apply plugin console:agent-console" "$LOG_FILE" >/dev/null; then
  echo "Koishi smoke startup did not load the internal Console." >&2
  exit 1
fi

if ! grep -F "internal Console guard registered at /koishi-console" "$LOG_FILE" >/dev/null; then
  echo "Koishi smoke startup did not register the internal Console access guard." >&2
  exit 1
fi

if ! grep -F "loader apply plugin chatluna-agent:computer-agent" "$LOG_FILE" >/dev/null; then
  echo "Koishi smoke startup did not load chatluna-agent." >&2
  exit 1
fi

if ! grep -F "admin-api independent admin workspace registered at /" "$LOG_FILE" >/dev/null; then
  echo "Koishi smoke startup did not complete admin-api registration." >&2
  exit 1
fi

if grep -F "dist/plugins/web-search:search" "$LOG_FILE" >/dev/null; then
  echo "Koishi smoke startup unexpectedly loaded deleted local web-search plugin." >&2
  exit 1
fi

if grep -nE "loader apply plugin adapter-onebot:onebot|loader apply plugin chatluna-openai-like-adapter:" "$LOG_FILE" >/dev/null; then
  echo "Koishi smoke startup unexpectedly loaded external dependency plugins." >&2
  exit 1
fi

echo "Koishi smoke startup check passed."

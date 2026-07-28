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
export SQLITE_PATH="$SMOKE_RUNTIME_DIR/koishi.db"

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
export QQBOT_ADMIN_ORIGIN="${QQBOT_ADMIN_ORIGIN:-http://127.0.0.1:${KOISHI_PORT}}"
export QQBOT_ADMIN_SSH_ORIGIN="${QQBOT_ADMIN_SSH_ORIGIN:-http://127.0.0.1:${KOISHI_PORT}}"

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
  './dist/plugins/admin-api:admin-api',
  'database-sqlite:8jr5yp',
  './dist/plugins/model-runtime:model-runtime',
  'cron:task',
  './dist/plugins/automation:automation',
  './dist/plugins/reply:voice',
  'chatluna:0qm1bk',
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
timeout 25s pnpm exec koishi start "$TMP_KOISHI_YML" >"$LOG_FILE" 2>&1
exit_code=$?
set -e

cat "$LOG_FILE"

# 25s timeout is expected for smoke startup.
if [[ "$exit_code" -ne 0 && "$exit_code" -ne 124 ]]; then
  echo "Koishi smoke startup exited unexpectedly with code: $exit_code" >&2
  exit "$exit_code"
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

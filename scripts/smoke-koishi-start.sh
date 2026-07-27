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
export CHATLUNA_SEARCH_SERVICE_TOPK="${CHATLUNA_SEARCH_SERVICE_TOPK:-5}"
export CHATLUNA_SEARCH_SERVICE_SUMMARY_TYPE="${CHATLUNA_SEARCH_SERVICE_SUMMARY_TYPE:-speed}"
export CHATLUNA_SEARCH_SERVICE_TAVILY_API_KEY="${CHATLUNA_SEARCH_SERVICE_TAVILY_API_KEY:-tvly-ci-smoke}"
export QQ_VOICE_INPUT_ENABLED="${QQ_VOICE_INPUT_ENABLED:-false}"
export QQ_VOICE_OUTPUT_ENABLED="${QQ_VOICE_OUTPUT_ENABLED:-false}"
export QQBOT_ADMIN_ORIGIN="${QQBOT_ADMIN_ORIGIN:-http://127.0.0.1:${KOISHI_PORT}}"
export QQBOT_ADMIN_SSH_ORIGIN="${QQBOT_ADMIN_SSH_ORIGIN:-http://127.0.0.1:${KOISHI_PORT}}"

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
        modelType: 'chat',
        contextSize: 131072,
        requestMode: 'chat_completions',
        structuredOutputProtocol: 'native_chat_json_schema',
        capabilities: {
          chat: true,
          embedding: false,
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
      { workload: 'memory.embedding', mode: 'disabled' },
      { workload: 'affinity.analysis', mode: 'inheritMain' },
      { workload: 'naturalTrigger.decision', mode: 'disabled' },
      { workload: 'search.summary', mode: 'inheritInvocation' },
      { workload: 'chatluna.defaultEmbedding', mode: 'disabled' },
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
import YAML from 'yaml';

const filePath = process.argv[2];
const config = YAML.parse(readFileSync(filePath, 'utf8'));
const entry = config?.plugins?.['group:entry'];

if (!entry || typeof entry !== 'object') {
  throw new Error('Invalid koishi.yml: missing plugins.group:entry');
}

const keep = new Set([
  'server:0b8t2q',
  './dist/plugins/admin-api:admin-api',
  'database-sqlite:8jr5yp',
  './dist/plugins/model-runtime:model-runtime',
  'cron:task',
  './dist/plugins/automation:automation',
  './dist/plugins/reply:voice',
  'chatluna:0qm1bk',
  'puppeteer:0vx5c7',
  'chatluna-search-service:search',
  './dist/plugins/sticker:sticker',
  './dist/plugins/model-guard:mjddgg',
  './dist/plugins/memory:memory',
]);

for (const key of Object.keys(entry)) {
  if (!keep.has(key)) {
    delete entry[key];
  }
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

if grep -nE "cannot resolve plugin|property database is not registered|TypeError: Cannot read properties of undefined|\\[W\\] app Error:|\\[E\\] app .*TypeError|\\[E\\] app .*ReferenceError|\\[E\\] app .*SyntaxError" "$LOG_FILE" >/dev/null; then
  echo "Koishi smoke startup detected runtime errors in logs." >&2
  exit 1
fi

if ! grep -F "loader apply plugin ./dist/plugins/automation" "$LOG_FILE" >/dev/null; then
  echo "Koishi smoke startup did not load task-automation plugin." >&2
  exit 1
fi

if ! grep -F "loader apply plugin ./dist/plugins/model-runtime:model-runtime" "$LOG_FILE" >/dev/null; then
  echo "Koishi smoke startup did not load model-runtime plugin." >&2
  exit 1
fi

if ! grep -F "loader apply plugin ./dist/plugins/reply:voice" "$LOG_FILE" >/dev/null; then
  echo "Koishi smoke startup did not load qq-voice plugin." >&2
  exit 1
fi

if ! grep -F "loader apply plugin chatluna-search-service:search" "$LOG_FILE" >/dev/null; then
  echo "Koishi smoke startup did not load chatluna-search-service plugin." >&2
  exit 1
fi

if ! grep -F "loader apply plugin ./dist/plugins/model-guard" "$LOG_FILE" >/dev/null; then
  echo "Koishi smoke startup did not load chatluna-model-guard plugin." >&2
  exit 1
fi

if ! grep -F "loader apply plugin ./dist/plugins/memory:memory" "$LOG_FILE" >/dev/null; then
  echo "Koishi smoke startup did not load memory plugin." >&2
  exit 1
fi

if ! grep -F "loader apply plugin ./dist/plugins/admin-api:admin-api" "$LOG_FILE" >/dev/null; then
  echo "Koishi smoke startup did not load admin-api plugin." >&2
  exit 1
fi

if ! grep -F "admin-api independent admin workspace registered at /" "$LOG_FILE" >/dev/null; then
  echo "Koishi smoke startup did not complete admin-api registration." >&2
  exit 1
fi

if grep -F "loader apply plugin ./dist/plugins/web-search:search" "$LOG_FILE" >/dev/null; then
  echo "Koishi smoke startup unexpectedly loaded deleted local web-search plugin." >&2
  exit 1
fi

if grep -nE "loader apply plugin adapter-onebot:onebot|loader apply plugin chatluna-openai-like-adapter:" "$LOG_FILE" >/dev/null; then
  echo "Koishi smoke startup unexpectedly loaded external dependency plugins." >&2
  exit 1
fi

echo "Koishi smoke startup check passed."

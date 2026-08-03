#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  probe-direct-model.sh

Description:
  Run read-only, single-turn model probes from chat-reply-probe-cases.json
  against the effective main.chat model and preset. This path never creates
  a QQ session, sends a QQ message, or writes conversation/model state.

Environment:
  PROBE_CASE_IDS          Optional comma-separated case IDs (default: all)
  PROBE_REPETITIONS       Samples per case, from 1 to 50 (default: 1)
  PROBE_REASONING_EFFORT  Optional low, medium, or high override (default: main.chat)
  PROBE_MAX_TOKENS        Per-call token limit, from 1 to 4096 (default: 1024)
  KEEP_INSPECTOR          Set to 1 to keep an already-opened inspector open
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if (( $# > 0 )); then
  echo "[error] probe-direct-model.sh takes no positional arguments; select cases with PROBE_CASE_IDS." >&2
  exit 2
fi

for command in curl node; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "[error] Missing command: $command" >&2
    exit 2
  fi
done

ROOT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

worker_pid="$(ps -ef | awk '/koishi\/lib\/worker/ && !/awk/ {print $2; exit}')"
if [[ -z "$worker_pid" ]]; then
  echo "[error] Failed to find local Koishi worker pid." >&2
  exit 1
fi

opened_inspector=0
if ! curl -fsS http://127.0.0.1:9229/json/list >/dev/null 2>&1; then
  kill -USR1 "$worker_pid"
  opened_inspector=1
  for _ in $(seq 1 50); do
    if curl -fsS http://127.0.0.1:9229/json/list >/dev/null 2>&1; then
      break
    fi
    sleep 0.2
  done
fi

if ! curl -fsS http://127.0.0.1:9229/json/list >/dev/null 2>&1; then
  echo "[error] Inspector did not become available on 127.0.0.1:9229." >&2
  exit 1
fi

if [[ "${KEEP_INSPECTOR:-0}" == "1" ]]; then
  opened_inspector=0
fi

QQBOT_DIRECT_OPENED_INSPECTOR="$opened_inspector" \
PROBE_MANIFEST_FILE="$ROOT_DIR/scripts/chat-reply-probe-cases.json" \
node "$ROOT_DIR/scripts/probe-direct-model.mjs"

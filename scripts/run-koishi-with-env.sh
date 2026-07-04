#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL_RUNTIME_ENV_FILE="${ROOT_DIR}/.runtime/.env.runtime"

resolve_env_file() {
  if [[ -n "${QQBOT_ENV_FILE:-}" ]]; then
    local explicit="${QQBOT_ENV_FILE}"
    if [[ "$explicit" != /* ]]; then
      explicit="${ROOT_DIR}/${explicit}"
    fi
    printf '%s\n' "$explicit"
    return
  fi

  printf '%s\n' "${ROOT_DIR}/.env.local"
}

resolve_optional_env_file() {
  local explicit="$1"
  if [[ -z "$explicit" ]]; then
    return 1
  fi
  if [[ "$explicit" != /* ]]; then
    explicit="${ROOT_DIR}/${explicit}"
  fi
  printf '%s\n' "$explicit"
}

load_env_file() {
  local env_file="$1"
  if [[ ! -f "$env_file" ]]; then
    echo "[error] bot env file not found: $env_file" >&2
    exit 2
  fi

  set -a
  # shellcheck disable=SC1090
  source "$env_file"
  set +a
}

append_no_proxy_host() {
  local env_name="$1"
  local host="$2"
  local current="${!env_name:-}"
  case ",${current}," in
    *",${host},"*) ;;
    *) export "${env_name}=${current:+${current},}${host}" ;;
  esac
}

configure_hbu_jw_proxy_bypass() {
  append_no_proxy_host NO_PROXY zhjw.hbu.cn
  append_no_proxy_host no_proxy zhjw.hbu.cn
}

BASE_ENV_FILE="$(resolve_optional_env_file "${QQBOT_ENV_BASE_FILE:-}" || true)"
OVERRIDE_ENV_FILE="$(resolve_optional_env_file "${QQBOT_ENV_OVERRIDE_FILE:-}" || true)"

if [[ -n "$BASE_ENV_FILE" || -n "$OVERRIDE_ENV_FILE" ]]; then
  if [[ -z "$BASE_ENV_FILE" ]]; then
    echo "[error] QQBOT_ENV_BASE_FILE is required when runtime env layering is enabled" >&2
    exit 2
  fi

  load_env_file "$BASE_ENV_FILE"
  if [[ -n "$OVERRIDE_ENV_FILE" && -f "$OVERRIDE_ENV_FILE" ]]; then
    load_env_file "$OVERRIDE_ENV_FILE"
  fi
  echo "[info] Loaded bot env base: $BASE_ENV_FILE"
  if [[ -n "$OVERRIDE_ENV_FILE" ]]; then
    echo "[info] Loaded bot env override: $OVERRIDE_ENV_FILE"
  fi
else
  ENV_FILE="$(resolve_env_file)"
  if [[ "$ENV_FILE" == "${ROOT_DIR}/.env.local" ]]; then
    load_env_file "$ENV_FILE"
    [[ -f "$LOCAL_RUNTIME_ENV_FILE" ]] && load_env_file "$LOCAL_RUNTIME_ENV_FILE"
    echo "[info] Loaded bot env base: $ENV_FILE"
    if [[ -f "$LOCAL_RUNTIME_ENV_FILE" ]]; then
      echo "[info] Loaded bot env override: $LOCAL_RUNTIME_ENV_FILE"
    fi
  else
    load_env_file "$ENV_FILE"
    echo "[info] Loaded bot env: $ENV_FILE"
  fi
fi

configure_hbu_jw_proxy_bypass

cd "$ROOT_DIR"
./scripts/ensure-chatluna-build.sh --check
node ./scripts/verify-runtime-artifacts.mjs --config koishi.yml
exec pnpm exec koishi start koishi.yml

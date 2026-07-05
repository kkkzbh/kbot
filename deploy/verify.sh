#!/usr/bin/env bash
set -euo pipefail

SCOPE="${1:-full}"
case "${SCOPE}" in
  koishi|full) ;;
  *) echo "[verify] invalid scope: ${SCOPE}" >&2; exit 2 ;;
esac

BASE_DIR="${QQBOT_BASE_DIR:-/opt/qqbot}"
APP_DIR="${BASE_DIR}/app/qqbot"
ENV_SERVER="${BASE_DIR}/shared/.env.server"
ENV_RUNTIME="${BASE_DIR}/shared/.env.runtime"

load_env_file() {
  local env_file="$1"
  if [[ -f "${env_file}" ]]; then
    set -a
    # shellcheck disable=SC1090
    . "${env_file}"
    set +a
  fi
}

load_env_file "${ENV_SERVER}"
load_env_file "${ENV_RUNTIME}"

exec bash "${APP_DIR}/scripts/verify-qqbot-host-runtime.sh" "${SCOPE}"

#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${QQBOT_SERVER_ENV_FILE:-${ROOT_DIR}/.env.server}"
STATE_FILE="${QQBOT_SERVER_LOGIN_RECOVERY_FILE:-${ROOT_DIR}/.server-login-recovery.env}"

if [ $# -ne 1 ]; then
  echo "Usage: $0 prepare|restore" >&2
  exit 1
fi

ACTION="$1"

if [ ! -f "${ENV_FILE}" ]; then
  echo "Missing server env file: ${ENV_FILE}" >&2
  exit 1
fi

load_env() {
  set -a
  # shellcheck disable=SC1090
  . "${ENV_FILE}"
  set +a
}

set_auto_login_value() {
  local next_value="$1"

  node - "${ENV_FILE}" "${next_value}" <<'NODE'
const fs = require('node:fs');

const [, , envPath, nextValue] = process.argv;
const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
let replaced = false;
const output = lines.map((line) => {
  if (!line.startsWith('AUTO_LOGIN_QQ=')) {
    return line;
  }
  replaced = true;
  return `AUTO_LOGIN_QQ=${nextValue}`;
});

if (!replaced) {
  output.push(`AUTO_LOGIN_QQ=${nextValue}`);
}

fs.writeFileSync(envPath, `${output.join('\n').replace(/\n+$/g, '')}\n`, 'utf8');
NODE
}

restart_server_target() {
  systemctl daemon-reload
  systemctl restart qqbot.target
}

prepare_manual_login() {
  load_env

  cat > "${STATE_FILE}" <<EOF
AUTO_LOGIN_QQ_ORIG=${AUTO_LOGIN_QQ:-}
EOF

  set_auto_login_value ""

  if command -v systemctl >/dev/null 2>&1; then
    systemctl stop qqbot.target >/dev/null 2>&1 || true
  fi

  systemctl daemon-reload
  systemctl start qqbot-pmhq.service
  systemctl start qqbot-llbot.service
  "${ROOT_DIR}/scripts/verify-qqbot-host-runtime.sh"

  cat <<EOF
Manual login recovery mode is ready.
- AUTO_LOGIN_QQ is temporarily cleared in ${ENV_FILE}.
- Open the server LLBot WebUI and complete QR/manual login.
- After login succeeds, run: ${ROOT_DIR}/scripts/server-recover-qq-login.sh restore
EOF
}

restore_auto_login() {
  if [ ! -f "${STATE_FILE}" ]; then
    echo "Missing recovery state file: ${STATE_FILE}" >&2
    exit 1
  fi

  # shellcheck disable=SC1090
  . "${STATE_FILE}"
  rm -f "${STATE_FILE}"

  set_auto_login_value "${AUTO_LOGIN_QQ_ORIG:-}"

  restart_server_target
  echo "qqbot.target restarted with AUTO_LOGIN_QQ restored."
}

case "${ACTION}" in
  prepare)
    prepare_manual_login
    ;;
  restore)
    restore_auto_login
    ;;
  *)
    echo "Unknown action: ${ACTION}" >&2
    exit 1
    ;;
esac

#!/usr/bin/env bash
set -euo pipefail

BUNDLE_PATH="${1:-}"
VERIFY_SCOPE="${2:-full}"
BASE_DIR="${QQBOT_BASE_DIR:-/opt/qqbot}"
APP_ROOT="${BASE_DIR}/app"
APP_DIR="${APP_ROOT}/qqbot"
DATA_DIR="${BASE_DIR}/data"
SHARED_DIR="${BASE_DIR}/shared"
INCOMING_DIR="${BASE_DIR}/incoming"
STAGING_DIR="${BASE_DIR}/.staging"
WORK_DIR="${STAGING_DIR}/work"
ENV_SERVER="${SHARED_DIR}/.env.server"
ENV_RUNTIME="${SHARED_DIR}/.env.runtime"
CLOUDFLARED_HBU_JW_TOKEN_FILE="${QQBOT_CLOUDFLARED_HBU_JW_TOKEN_FILE:-/etc/cloudflared/qqbot-hbu-jw.token}"
CLOUDFLARED_GENSHIN_TOKEN_FILE="${QQBOT_CLOUDFLARED_GENSHIN_TOKEN_FILE:-/etc/cloudflared/qqbot-genshin.token}"
SYSTEMD_DIR="/etc/systemd/system"

case "${VERIFY_SCOPE}" in
  koishi|full) ;;
  *) echo "[installer] invalid verify scope: ${VERIFY_SCOPE}" >&2; exit 2 ;;
esac

if [[ -z "${BUNDLE_PATH}" || ! -f "${BUNDLE_PATH}" ]]; then
  echo "[installer] missing bundle: ${BUNDLE_PATH}" >&2
  exit 2
fi

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[installer] missing command: $1" >&2
    exit 2
  fi
}

for cmd in bash tar node pnpm systemctl journalctl curl podman podman-compose cloudflared; do
  require_cmd "${cmd}"
done

if [[ ! -s "${CLOUDFLARED_HBU_JW_TOKEN_FILE}" ]]; then
  echo "[installer] missing Cloudflare tunnel token file: ${CLOUDFLARED_HBU_JW_TOKEN_FILE}" >&2
  echo "[installer] install the qqbot-hbu-jw token before deploying" >&2
  exit 2
fi
chmod 600 "${CLOUDFLARED_HBU_JW_TOKEN_FILE}"

if [[ ! -s "${CLOUDFLARED_GENSHIN_TOKEN_FILE}" ]]; then
  echo "[installer] missing Cloudflare tunnel token file: ${CLOUDFLARED_GENSHIN_TOKEN_FILE}" >&2
  echo "[installer] install the qqbot-genshin token before deploying" >&2
  exit 2
fi
chmod 600 "${CLOUDFLARED_GENSHIN_TOKEN_FILE}"

if ! command -v corepack >/dev/null 2>&1 && ! command -v npm >/dev/null 2>&1; then
  echo "[installer] missing command: corepack or npm" >&2
  exit 2
fi

mkdir -p \
  "${DATA_DIR}/pmhq/QQ" \
  "${DATA_DIR}/llonebot" \
  "${DATA_DIR}/llbot-runtime" \
  "${DATA_DIR}/chatluna-storage" \
  "${DATA_DIR}/chathub/presets" \
  "${DATA_DIR}/chathub/stickers" \
  "${DATA_DIR}/cache/yarn" \
  "${DATA_DIR}/cache/pnpm-store" \
  "${SHARED_DIR}" \
  "${INCOMING_DIR}" \
  "${STAGING_DIR}"
chmod 700 "${DATA_DIR}" "${SHARED_DIR}"

if [[ ! -f "${ENV_SERVER}" ]]; then
  echo "[installer] missing server env: ${ENV_SERVER}" >&2
  echo "[installer] deploy.sh must install a real .env.server before running installer" >&2
  exit 2
fi
chmod 600 "${ENV_SERVER}"

ensure_server_env_key() {
  local key="$1"
  local value="$2"
  if grep -Eq "^${key}=" "${ENV_SERVER}"; then
    return
  fi
  printf '%s=%s\n' "${key}" "${value}" >> "${ENV_SERVER}"
}

ensure_server_env_defaults() {
  ensure_server_env_key "GENSHIN_PUBLIC_BASE_URL" "https://genshin.kkkzbh.cn"
  ensure_server_env_key "GENSHIN_BIND_PAGE_PATH" "/genshin/bind"
  ensure_server_env_key "GENSHIN_BIND_TOKEN_TTL_MS" "600000"
  ensure_server_env_key "GENSHIN_CREDENTIAL_KEK_PATH" "${DATA_DIR}/genshin-credential-kek"
  ensure_server_env_key "GENSHIN_AUTO_SIGN_ENABLED" "true"
  ensure_server_env_key "GENSHIN_AUTO_SIGN_CRON" '"10 9 * * *"'
  ensure_server_env_key "GENSHIN_TIMEZONE" "Asia/Shanghai"
  ensure_server_env_key "GENSHIN_TAKUMI_APP_VERSION" "2.70.1"
  ensure_server_env_key "GENSHIN_SIGN_ACT_ID" "e202311201442471"
  ensure_server_env_key "GENSHIN_REDEEM_GAME_VERSION" "CNRELWin6.0.0"
  chmod 600 "${ENV_SERVER}"
}
ensure_server_env_defaults

BUNDLE_ENTRIES="${STAGING_DIR}/bundle.entries"
tar -tzf "${BUNDLE_PATH}" > "${BUNDLE_ENTRIES}"

require_bundle_entry() {
  local entry="$1"
  local candidate
  while IFS= read -r candidate; do
    if [[ "${candidate}" == "${entry}" || "${candidate}" == "${entry}/"* ]]; then
      return 0
    fi
  done < "${BUNDLE_ENTRIES}"
  echo "[installer] missing bundle entry: ${entry}" >&2
  exit 2
}

require_bundle_entry "build-manifest.json"
require_bundle_entry "qqbot/package.json"
require_bundle_entry "qqbot/koishi.yml"
require_bundle_entry "qqbot/dist"
require_bundle_entry "qqbot/deploy/render-systemd.mjs"
require_bundle_entry "chatluna/packages/core/package.json"

clear_managed_dir() {
  local target="$1"
  case "${target}" in
    "${BASE_DIR}/.staging"|"${BASE_DIR}/incoming"|"${BASE_DIR}/app") ;;
    *) echo "[installer] unmanaged clear target: ${target}" >&2; exit 2 ;;
  esac
  mkdir -p "${target}"
  find "${target}" -mindepth 1 -maxdepth 1 -exec rm -r -- {} +
}

clear_managed_dir "${STAGING_DIR}"
mkdir -p "${WORK_DIR}"
tar -xzf "${BUNDLE_PATH}" -C "${WORK_DIR}"

STAGE_QQBOT="${WORK_DIR}/qqbot"
STAGE_CHATLUNA="${WORK_DIR}/chatluna"
if [[ ! -d "${STAGE_QQBOT}/dist" ]]; then
  echo "[installer] missing built dist in staging" >&2
  exit 2
fi

(
  set -a
  # shellcheck disable=SC1090
  . "${ENV_SERVER}"
  if [[ -f "${ENV_RUNTIME}" ]]; then
    # shellcheck disable=SC1090
    . "${ENV_RUNTIME}"
  fi
  set +a
  node "${STAGE_QQBOT}/scripts/validate-admin-config.mjs"
)

write_runtime_env() {
  local generated_keys=(
    SQLITE_PATH
    PMHQ_QQ_CONFIG_DIR
    QQBOT_QQ_CONFIG_MOUNT_SOURCE
    PMHQ_BIND_HOST
    PMHQ_PORT
    LLBOT_RUNTIME_DIR
    LLONEBOT_DATA_DIR
    LLONEBOT_WEBUI_PORT
    LLONEBOT_WS_PORT
    ONEBOT_WS_ENDPOINT
    CHATLUNA_STORAGE_PATH
    CHATLUNA_STORAGE_SERVER_PATH
    CHATLUNA_RUNTIME_PRESET_DIR
    CHATLUNA_STICKER_DIR
    PUPPETEER_EXECUTABLE_PATH
  )
  local tmp
  tmp="$(mktemp "${ENV_RUNTIME}.tmp.XXXXXX")"

  is_generated_runtime_key() {
    local key="$1"
    local item
    for item in "${generated_keys[@]}"; do
      [[ "${key}" == "${item}" ]] && return 0
    done
    return 1
  }

  if [[ -f "${ENV_RUNTIME}" ]]; then
    local line key
    while IFS= read -r line || [[ -n "${line}" ]]; do
      if [[ "${line}" =~ ^([A-Za-z_][A-Za-z0-9_]*)= ]]; then
        key="${BASH_REMATCH[1]}"
        is_generated_runtime_key "${key}" && continue
      fi
      printf '%s\n' "${line}" >> "${tmp}"
    done < "${ENV_RUNTIME}"
    if [[ -s "${tmp}" ]]; then
      printf '\n' >> "${tmp}"
    fi
  fi

  printf '%s\n' "SQLITE_PATH=${DATA_DIR}/koishi.db" >> "${tmp}"
  printf '%s\n' "PMHQ_QQ_CONFIG_DIR=${DATA_DIR}/pmhq/QQ" >> "${tmp}"
  printf '%s\n' "QQBOT_QQ_CONFIG_MOUNT_SOURCE=${DATA_DIR}/pmhq/QQ" >> "${tmp}"
  printf '%s\n' "PMHQ_BIND_HOST=127.0.0.1" >> "${tmp}"
  printf '%s\n' "PMHQ_PORT=13000" >> "${tmp}"
  printf '%s\n' "LLBOT_RUNTIME_DIR=${DATA_DIR}/llbot-runtime" >> "${tmp}"
  printf '%s\n' "LLONEBOT_DATA_DIR=${DATA_DIR}/llonebot" >> "${tmp}"
  printf '%s\n' "LLONEBOT_WEBUI_PORT=3080" >> "${tmp}"
  printf '%s\n' "LLONEBOT_WS_PORT=3001" >> "${tmp}"
  printf '%s\n' "ONEBOT_WS_ENDPOINT=ws://127.0.0.1:3001" >> "${tmp}"
  printf '%s\n' "CHATLUNA_STORAGE_PATH=${DATA_DIR}/chatluna-storage" >> "${tmp}"
  printf '%s\n' "CHATLUNA_STORAGE_SERVER_PATH=http://127.0.0.1:5140" >> "${tmp}"
  printf '%s\n' "CHATLUNA_RUNTIME_PRESET_DIR=${DATA_DIR}/chathub/presets" >> "${tmp}"
  printf '%s\n' "CHATLUNA_STICKER_DIR=${DATA_DIR}/chathub/stickers" >> "${tmp}"
  printf '%s\n' "PUPPETEER_EXECUTABLE_PATH=/usr/lib64/chromium-browser/headless_shell" >> "${tmp}"
  chmod 600 "${tmp}"
  mv "${tmp}" "${ENV_RUNTIME}"
}
write_runtime_env

if [[ -z "$(find "${DATA_DIR}/chathub/presets" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" && -d "${STAGE_QQBOT}/data/chathub/presets" ]]; then
  cp -a "${STAGE_QQBOT}/data/chathub/presets/." "${DATA_DIR}/chathub/presets/"
fi
if [[ -z "$(find "${DATA_DIR}/chathub/stickers" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" && -d "${STAGE_QQBOT}/data/chathub/stickers" ]]; then
  cp -a "${STAGE_QQBOT}/data/chathub/stickers/." "${DATA_DIR}/chathub/stickers/"
fi

source "${STAGE_QQBOT}/scripts/lib/chatluna-package-manager.sh"
YARN_CACHE_FOLDER="${DATA_DIR}/cache/yarn" chatluna_yarn_install_immutable "${STAGE_CHATLUNA}"
CHATLUNA_ROOT_DIR="${STAGE_CHATLUNA}" bash "${STAGE_QQBOT}/scripts/ensure-chatluna-build.sh" --check

(
  cd "${STAGE_QQBOT}"
  pnpm install --frozen-lockfile --store-dir "${DATA_DIR}/cache/pnpm-store"
  node ./scripts/verify-runtime-artifacts.mjs --config koishi.yml
)

QQBOT_APP_DIR="${APP_DIR}" \
QQBOT_APP_ROOT="${APP_ROOT}" \
QQBOT_DATA_DIR="${DATA_DIR}" \
QQBOT_SHARED_DIR="${SHARED_DIR}" \
QQBOT_SYSTEMD_DIR="${SYSTEMD_DIR}" \
QQBOT_CLOUDFLARED_HBU_JW_TOKEN_FILE="${CLOUDFLARED_HBU_JW_TOKEN_FILE}" \
QQBOT_CLOUDFLARED_GENSHIN_TOKEN_FILE="${CLOUDFLARED_GENSHIN_TOKEN_FILE}" \
  node "${STAGE_QQBOT}/deploy/render-systemd.mjs"
systemctl daemon-reload

if systemctl cat qqbot.target >/dev/null 2>&1; then
  systemctl stop qqbot.target
fi
clear_managed_dir "${APP_ROOT}"
rmdir "${APP_ROOT}"
mv "${WORK_DIR}" "${APP_ROOT}"
chmod 755 "${APP_ROOT}" "${APP_DIR}"
systemctl enable qqbot.target >/dev/null
systemctl restart qqbot.target
QQBOT_BASE_DIR="${BASE_DIR}" bash "${APP_DIR}/deploy/verify.sh" "${VERIFY_SCOPE}"

clear_managed_dir "${INCOMING_DIR}"
clear_managed_dir "${STAGING_DIR}"
echo "[installer] deployed single instance to ${APP_ROOT}"

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

for cmd in bash tar node pnpm systemctl journalctl curl podman podman-compose; do
  require_cmd "${cmd}"
done

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

require_bundle_entry() {
  local entry="$1"
  if ! tar -tzf "${BUNDLE_PATH}" | grep -qx "${entry}"; then
    if ! tar -tzf "${BUNDLE_PATH}" | grep -q "^${entry}/"; then
      echo "[installer] missing bundle entry: ${entry}" >&2
      exit 2
    fi
  fi
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

write_runtime_env() {
  : > "${ENV_RUNTIME}"
  printf '%s\n' "SQLITE_PATH=${DATA_DIR}/koishi.db" >> "${ENV_RUNTIME}"
  printf '%s\n' "PMHQ_QQ_CONFIG_DIR=${DATA_DIR}/pmhq/QQ" >> "${ENV_RUNTIME}"
  printf '%s\n' "PMHQ_BIND_HOST=127.0.0.1" >> "${ENV_RUNTIME}"
  printf '%s\n' "PMHQ_PORT=13000" >> "${ENV_RUNTIME}"
  printf '%s\n' "LLBOT_RUNTIME_DIR=${DATA_DIR}/llbot-runtime" >> "${ENV_RUNTIME}"
  printf '%s\n' "LLONEBOT_DATA_DIR=${DATA_DIR}/llonebot" >> "${ENV_RUNTIME}"
  printf '%s\n' "LLONEBOT_WEBUI_PORT=3080" >> "${ENV_RUNTIME}"
  printf '%s\n' "LLONEBOT_WS_PORT=3001" >> "${ENV_RUNTIME}"
  printf '%s\n' "ONEBOT_WS_ENDPOINT=ws://127.0.0.1:3001" >> "${ENV_RUNTIME}"
  printf '%s\n' "CHATLUNA_STORAGE_PATH=${DATA_DIR}/chatluna-storage" >> "${ENV_RUNTIME}"
  printf '%s\n' "CHATLUNA_STORAGE_SERVER_PATH=http://127.0.0.1:5140" >> "${ENV_RUNTIME}"
  printf '%s\n' "CHATLUNA_RUNTIME_PRESET_DIR=${DATA_DIR}/chathub/presets" >> "${ENV_RUNTIME}"
  printf '%s\n' "CHATLUNA_STICKER_DIR=${DATA_DIR}/chathub/stickers" >> "${ENV_RUNTIME}"
  printf '%s\n' "PUPPETEER_EXECUTABLE_PATH=/usr/lib64/chromium-browser/headless_shell" >> "${ENV_RUNTIME}"
  chmod 600 "${ENV_RUNTIME}"
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
  node "${STAGE_QQBOT}/deploy/render-systemd.mjs"

systemctl stop qqbot.target >/dev/null 2>&1 || true
clear_managed_dir "${APP_ROOT}"
rmdir "${APP_ROOT}"
mv "${WORK_DIR}" "${APP_ROOT}"
chmod 755 "${APP_ROOT}" "${APP_DIR}"
systemctl daemon-reload
systemctl enable qqbot.target >/dev/null
systemctl restart qqbot.target
QQBOT_BASE_DIR="${BASE_DIR}" bash "${APP_DIR}/deploy/verify.sh" "${VERIFY_SCOPE}"

clear_managed_dir "${INCOMING_DIR}"
clear_managed_dir "${STAGING_DIR}"
echo "[installer] deployed single instance to ${APP_ROOT}"

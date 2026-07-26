#!/usr/bin/env bash
set -euo pipefail

BUNDLE_PATH="${1:-}"
VERIFY_SCOPE="${2:-full}"
ACTIVATION_MODE="${3:-start}"
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
MODEL_CONFIG_MAPPING_FILE="${SHARED_DIR}/model-config-mapping.json"
AGENT_DATA_ROOT="${DATA_DIR}/chatluna"
PERSISTENT_AGENT_DIR="${AGENT_DATA_ROOT}/agents"
LEGACY_APP_AGENT_DIR="${APP_DIR}/data/chatluna/agent"
CLOUDFLARED_HBU_JW_TOKEN_FILE="${QQBOT_CLOUDFLARED_HBU_JW_TOKEN_FILE:-/etc/cloudflared/qqbot-hbu-jw.token}"
CLOUDFLARED_GENSHIN_TOKEN_FILE="${QQBOT_CLOUDFLARED_GENSHIN_TOKEN_FILE:-/etc/cloudflared/qqbot-genshin.token}"
HBU_WEBVPN_BROKER_CREDENTIAL="${QQBOT_HBU_WEBVPN_BROKER_CREDENTIAL:-/etc/credstore.encrypted/hbu-webvpn-broker.cred}"
SYSTEMD_DIR="/etc/systemd/system"
QUADLET_DIR="/etc/containers/systemd"
ACTIVATION_STARTED=0
TRANSACTION_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
TRANSACTION_BACKUP_DIR="${BASE_DIR}/backup/deploy-${TRANSACTION_ID}"
TRANSACTION_PATHS_DIR="${TRANSACTION_BACKUP_DIR}/paths"
PREVIOUS_APP_ROOT="${TRANSACTION_BACKUP_DIR}/previous-app"
FAILED_NEW_APP_ROOT="${TRANSACTION_BACKUP_DIR}/failed-new-app"
TRANSACTION_BACKUP_CREATED=0
TRANSACTION_SNAPSHOT_COMPLETE=0
APP_SWAPPED=0
APP_PREVIOUS_EXISTED=0

remove_snapshot_target() {
  local target="$1"
  if [[ -d "${target}" && ! -L "${target}" ]]; then
    rm -r -- "${target}"
  elif [[ -e "${target}" || -L "${target}" ]]; then
    rm -f -- "${target}"
  fi
}

snapshot_path() {
  local key="$1"
  local target="$2"
  if [[ ! "${key}" =~ ^[a-z0-9-]+$ ]]; then
    echo "[installer] invalid transaction snapshot key: ${key}" >&2
    return 1
  fi
  mkdir -p "${TRANSACTION_PATHS_DIR}/${key}"
  if [[ -e "${target}" || -L "${target}" ]]; then
    cp -a -- "${target}" "${TRANSACTION_PATHS_DIR}/${key}/value"
    touch "${TRANSACTION_PATHS_DIR}/${key}/present"
  else
    touch "${TRANSACTION_PATHS_DIR}/${key}/absent"
  fi
}

restore_snapshot_path() {
  local key="$1"
  local target="$2"
  local snapshot="${TRANSACTION_PATHS_DIR}/${key}"
  if [[ -f "${snapshot}/present" ]]; then
    remove_snapshot_target "${target}"
    mkdir -p "$(dirname "${target}")"
    cp -a -- "${snapshot}/value" "${target}"
    return
  fi
  if [[ -f "${snapshot}/absent" ]]; then
    remove_snapshot_target "${target}"
    return
  fi
  echo "[installer] transaction snapshot is missing: ${key}" >&2
  return 1
}

snapshot_database() {
  local target="${DATA_DIR}/koishi.db"
  local snapshot="${TRANSACTION_PATHS_DIR}/database"
  mkdir -p "${snapshot}"
  if [[ -f "${target}" ]]; then
    python3 - "${target}" "${snapshot}/koishi.db" <<'PY'
import sqlite3
import sys

source = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
destination = sqlite3.connect(sys.argv[2])
try:
    source.backup(destination)
finally:
    destination.close()
    source.close()
PY
    chmod 600 "${snapshot}/koishi.db"
    touch "${snapshot}/present"
  elif [[ -e "${target}" || -L "${target}" ]]; then
    echo "[installer] SQLite path must be a regular file: ${target}" >&2
    return 1
  else
    touch "${snapshot}/absent"
  fi
}

restore_database_snapshot() {
  local target="${DATA_DIR}/koishi.db"
  local snapshot="${TRANSACTION_PATHS_DIR}/database"
  remove_snapshot_target "${target}"
  remove_snapshot_target "${target}-wal"
  remove_snapshot_target "${target}-shm"
  if [[ -f "${snapshot}/present" ]]; then
    cp -a -- "${snapshot}/koishi.db" "${target}"
  elif [[ ! -f "${snapshot}/absent" ]]; then
    echo "[installer] transaction database snapshot is missing" >&2
    return 1
  fi
}

restore_early_environment() {
  restore_snapshot_path "env-server" "${ENV_SERVER}"
  restore_snapshot_path "env-runtime" "${ENV_RUNTIME}"
  restore_snapshot_path "env-pmhq" "${SHARED_DIR}/.env.pmhq"
}

rollback_after_failure() {
  local status="$?"
  trap - EXIT
  if [[ "${status}" -eq 0 ]]; then
    exit 0
  fi
  set +e
  local rollback_failed=0
  if [[ "${ACTIVATION_STARTED}" == "1" ]]; then
    echo "[installer] deployment failed after cutover began; restoring transaction ${TRANSACTION_BACKUP_DIR}" >&2
    systemctl stop qqbot.target >/dev/null 2>&1

    if [[ "${APP_SWAPPED}" == "1" ]]; then
      if [[ -e "${APP_ROOT}" || -L "${APP_ROOT}" ]]; then
        if [[ -e "${FAILED_NEW_APP_ROOT}" || -L "${FAILED_NEW_APP_ROOT}" ]]; then
          rollback_failed=1
          echo "[installer] failed-new-app destination already exists: ${FAILED_NEW_APP_ROOT}" >&2
        else
          mv "${APP_ROOT}" "${FAILED_NEW_APP_ROOT}" || rollback_failed=1
        fi
      fi
    fi
    if [[ "${APP_PREVIOUS_EXISTED}" == "1" ]]; then
      if [[ -e "${APP_ROOT}" || -L "${APP_ROOT}" ]]; then
        rollback_failed=1
        echo "[installer] cannot restore previous app over existing path: ${APP_ROOT}" >&2
      else
        mv "${PREVIOUS_APP_ROOT}" "${APP_ROOT}" || rollback_failed=1
      fi
    fi

    if [[ "${TRANSACTION_SNAPSHOT_COMPLETE}" == "1" ]]; then
      restore_database_snapshot || rollback_failed=1
      restore_snapshot_path "persistent-agents" "${PERSISTENT_AGENT_DIR}" || rollback_failed=1
      restore_snapshot_path "persistent-skills" "${AGENT_DATA_ROOT}/skills" || rollback_failed=1
      restore_snapshot_path "persistent-computer" "${AGENT_DATA_ROOT}/computer" || rollback_failed=1
      restore_snapshot_path "legacy-app-agent" "${LEGACY_APP_AGENT_DIR}" || rollback_failed=1
      restore_snapshot_path "archives" "${DATA_DIR}/chatluna/archive" || rollback_failed=1
      restore_snapshot_path "legacy-presets" "${DATA_DIR}/chathub/presets" || rollback_failed=1
      restore_snapshot_path "context-presets" "${DATA_DIR}/chathub/context-presets" || rollback_failed=1
      restore_snapshot_path "role-presets" "${DATA_DIR}/chathub/role-presets" || rollback_failed=1
      restore_snapshot_path "model-config" "${DATA_DIR}/model-config.json" || rollback_failed=1
      restore_snapshot_path "model-kek" "${SHARED_DIR}/model-config.kek" || rollback_failed=1
      restore_snapshot_path "model-map" "${MODEL_CONFIG_MAPPING_FILE}" || rollback_failed=1
      restore_snapshot_path "unit-pmhq-container" "${QUADLET_DIR}/qqbot-pmhq.container" || rollback_failed=1
      restore_snapshot_path "unit-llbot" "${SYSTEMD_DIR}/qqbot-llbot.service" || rollback_failed=1
      restore_snapshot_path "unit-koishi" "${SYSTEMD_DIR}/qqbot-koishi.service" || rollback_failed=1
      restore_snapshot_path "unit-hbu-tunnel" "${SYSTEMD_DIR}/cloudflared-qqbot-hbu-jw.service" || rollback_failed=1
      restore_snapshot_path "unit-genshin-tunnel" "${SYSTEMD_DIR}/cloudflared-qqbot-genshin.service" || rollback_failed=1
      restore_snapshot_path "unit-target" "${SYSTEMD_DIR}/qqbot.target" || rollback_failed=1
      restore_snapshot_path "legacy-pmhq-unit" "${SYSTEMD_DIR}/qqbot-pmhq.service" || rollback_failed=1
      restore_snapshot_path "legacy-podman-dropin" "${SYSTEMD_DIR}/podman-restart.service.d/qqbot-no-global-stop.conf" || rollback_failed=1
    fi
  fi

  if [[ "${TRANSACTION_BACKUP_CREATED}" == "1" ]]; then
    restore_early_environment || rollback_failed=1
  fi

  if [[ "${ACTIVATION_STARTED}" == "1" ]]; then
    systemctl daemon-reload || rollback_failed=1
    if [[ "${rollback_failed}" == "0" ]]; then
      systemctl start qqbot.target || rollback_failed=1
    fi
    if [[ "${rollback_failed}" == "0" ]]; then
      QQBOT_BASE_DIR="${BASE_DIR}" bash "${APP_DIR}/deploy/verify.sh" "${VERIFY_SCOPE}" \
        || rollback_failed=1
    fi
  fi

  if [[ "${rollback_failed}" != "0" ]]; then
    systemctl stop qqbot.target >/dev/null 2>&1
    echo "[installer] rollback incomplete; qqbot.target remains stopped" >&2
    echo "[installer] recovery material: ${TRANSACTION_BACKUP_DIR}" >&2
  elif [[ "${ACTIVATION_STARTED}" == "1" ]]; then
    echo "[installer] previous deployment restored and verified" >&2
  fi
  exit "${status}"
}
trap rollback_after_failure EXIT

case "${VERIFY_SCOPE}" in
  koishi|full) ;;
  *) echo "[installer] invalid verify scope: ${VERIFY_SCOPE}" >&2; exit 2 ;;
esac
case "${ACTIVATION_MODE}" in
  start|keep-stopped) ;;
  *) echo "[installer] invalid activation mode: ${ACTIVATION_MODE}" >&2; exit 2 ;;
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

for cmd in bash tar node pnpm python3 systemctl journalctl curl podman cloudflared; do
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

if [[ ! -s "${HBU_WEBVPN_BROKER_CREDENTIAL}" ]]; then
  echo "[installer] missing HBU WebVPN broker credential: ${HBU_WEBVPN_BROKER_CREDENTIAL}" >&2
  exit 2
fi
chmod 600 "${HBU_WEBVPN_BROKER_CREDENTIAL}"

if ! command -v corepack >/dev/null 2>&1 && ! command -v npm >/dev/null 2>&1; then
  echo "[installer] missing command: corepack or npm" >&2
  exit 2
fi

mkdir -p \
  "${DATA_DIR}/pmhq/QQ" \
  "${DATA_DIR}/llonebot" \
  "${DATA_DIR}/llbot-runtime" \
  "${DATA_DIR}/chatluna-storage" \
  "${DATA_DIR}/chatluna/archive" \
  "${PERSISTENT_AGENT_DIR}" \
  "${DATA_DIR}/chathub/context-presets" \
  "${DATA_DIR}/chathub/role-presets" \
  "${DATA_DIR}/chathub/stickers" \
  "${DATA_DIR}/cache/yarn" \
  "${DATA_DIR}/cache/pnpm-store" \
  "${SHARED_DIR}" \
  "${INCOMING_DIR}" \
  "${STAGING_DIR}"
chmod 700 "${DATA_DIR}" "${SHARED_DIR}" "${DATA_DIR}/chatluna/archive"

if [[ ! -f "${ENV_SERVER}" ]]; then
  echo "[installer] missing server env: ${ENV_SERVER}" >&2
  echo "[installer] deploy.sh must install a real .env.server before running installer" >&2
  exit 2
fi
chmod 600 "${ENV_SERVER}"

mkdir -p "${BASE_DIR}/backup"
mkdir "${TRANSACTION_BACKUP_DIR}"
chmod 700 "${TRANSACTION_BACKUP_DIR}"
snapshot_path "env-server" "${ENV_SERVER}"
snapshot_path "env-runtime" "${ENV_RUNTIME}"
snapshot_path "env-pmhq" "${SHARED_DIR}/.env.pmhq"
TRANSACTION_BACKUP_CREATED=1

ensure_server_env_key() {
  local key="$1"
  local value="$2"
  if grep -Eq "^${key}=" "${ENV_SERVER}"; then
    return
  fi
  printf '%s=%s\n' "${key}" "${value}" >> "${ENV_SERVER}"
}

remove_env_key() {
  local file="$1"
  local key="$2"
  if [[ ! -f "${file}" ]] || ! grep -Eq "^${key}=" "${file}"; then
    return
  fi
  local tmp
  tmp="$(mktemp "${file}.tmp.XXXXXX")"
  awk -v prefix="${key}=" 'index($0, prefix) != 1' "${file}" > "${tmp}"
  chmod 600 "${tmp}"
  mv "${tmp}" "${file}"
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
  ensure_server_env_key "HBU_JW_WEBVPN_BROKER_URL" "http://127.0.0.1:8789"
  local file
  for file in "${ENV_SERVER}" "${ENV_RUNTIME}"; do
    remove_env_key "${file}" "HBU_JW_WEBVPN_BROKER_ACCOUNT"
    remove_env_key "${file}" "CHATLUNA_DEFAULT_PRESET"
    remove_env_key "${file}" "CHATLUNA_PRESET_DIRS"
    remove_env_key "${file}" "CHATLUNA_BUNDLED_PRESET_DIR"
    remove_env_key "${file}" "CHATLUNA_RUNTIME_PRESET_DIR"
  done
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

require_bundle_catalog() {
  local entry="$1"
  local candidate
  while IFS= read -r candidate; do
    if [[ "${candidate}" == "${entry}/"*.yml ]]; then
      return 0
    fi
  done < "${BUNDLE_ENTRIES}"
  echo "[installer] bundled preset catalog has no YAML definitions: ${entry}" >&2
  exit 2
}

require_bundle_entry "build-manifest.json"
require_bundle_entry "qqbot/package.json"
require_bundle_entry "qqbot/koishi.yml"
require_bundle_entry "qqbot/dist"
require_bundle_entry "qqbot/dist/tools/context-preset-cutover.mjs"
require_bundle_entry "qqbot/dist/tools/context-preset-sqlite.py"
require_bundle_entry "qqbot/dist/tools/model-config-cutover.mjs"
require_bundle_entry "qqbot/data/chathub/context-presets"
require_bundle_entry "qqbot/data/chathub/role-presets"
require_bundle_catalog "qqbot/data/chathub/context-presets"
require_bundle_catalog "qqbot/data/chathub/role-presets"
require_bundle_entry "qqbot/deploy/render-systemd.mjs"
require_bundle_entry "qqbot/scripts/wait-pmhq-login-network.sh"
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
    QQBOT_MODEL_CONFIG_PATH
    QQBOT_MODEL_CONFIG_KEK_PATH
    CHATLUNA_AGENT_DATA_DIR
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
    CHATLUNA_BUNDLED_CONTEXT_PRESET_DIR
    CHATLUNA_RUNTIME_CONTEXT_PRESET_DIR
    CHATLUNA_BUNDLED_ROLE_PRESET_DIR
    CHATLUNA_RUNTIME_ROLE_PRESET_DIR
    CHATLUNA_ARCHIVE_DIR
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
  printf '%s\n' "QQBOT_MODEL_CONFIG_PATH=${DATA_DIR}/model-config.json" >> "${tmp}"
  printf '%s\n' "QQBOT_MODEL_CONFIG_KEK_PATH=${SHARED_DIR}/model-config.kek" >> "${tmp}"
  printf '%s\n' "CHATLUNA_AGENT_DATA_DIR=${AGENT_DATA_ROOT}" >> "${tmp}"
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
  printf '%s\n' "CHATLUNA_BUNDLED_CONTEXT_PRESET_DIR=${APP_DIR}/data/chathub/context-presets" >> "${tmp}"
  printf '%s\n' "CHATLUNA_RUNTIME_CONTEXT_PRESET_DIR=${DATA_DIR}/chathub/context-presets" >> "${tmp}"
  printf '%s\n' "CHATLUNA_BUNDLED_ROLE_PRESET_DIR=${APP_DIR}/data/chathub/role-presets" >> "${tmp}"
  printf '%s\n' "CHATLUNA_RUNTIME_ROLE_PRESET_DIR=${DATA_DIR}/chathub/role-presets" >> "${tmp}"
  printf '%s\n' "CHATLUNA_ARCHIVE_DIR=${DATA_DIR}/chatluna/archive" >> "${tmp}"
  printf '%s\n' "CHATLUNA_STICKER_DIR=${DATA_DIR}/chathub/stickers" >> "${tmp}"
  printf '%s\n' "PUPPETEER_EXECUTABLE_PATH=/usr/lib64/chromium-browser/headless_shell" >> "${tmp}"
  chmod 600 "${tmp}"
  mv "${tmp}" "${ENV_RUNTIME}"
}
write_runtime_env

write_pmhq_env() {
  local pmhq_env="${SHARED_DIR}/.env.pmhq"
  local tmp
  tmp="$(mktemp "${pmhq_env}.tmp.XXXXXX")"
  trap 'rm -f -- "${tmp}"' RETURN
  (
    set -a
    # shellcheck disable=SC1090
    . "${ENV_SERVER}"
    if [[ -f "${ENV_RUNTIME}" ]]; then
      # shellcheck disable=SC1090
      . "${ENV_RUNTIME}"
    fi
    set +a
    local pmhq_headless="${ENABLE_HEADLESS:-false}"
    local pmhq_auto_login="${AUTO_LOGIN_QQ:-}"
    local pmhq_timezone="${TZ:-Asia/Shanghai}"
    case "${pmhq_headless}" in true|false) ;; *) echo "[installer] ENABLE_HEADLESS must be true or false" >&2; exit 2 ;; esac
    if [[ -n "${pmhq_auto_login}" && ! "${pmhq_auto_login}" =~ ^[0-9]+$ ]]; then
      echo "[installer] AUTO_LOGIN_QQ must be empty or numeric" >&2
      exit 2
    fi
    if [[ ! "${pmhq_timezone}" =~ ^[A-Za-z0-9_+/-]+$ ]]; then
      echo "[installer] invalid TZ for PMHQ" >&2
      exit 2
    fi
    printf '%s\n' \
      "ENABLE_HEADLESS=${pmhq_headless}" \
      "AUTO_LOGIN_QQ=${pmhq_auto_login}" \
      "TZ=${pmhq_timezone}" > "${tmp}"
  )
  chmod 600 "${tmp}"
  mv "${tmp}" "${pmhq_env}"
  trap - RETURN
}
write_pmhq_env

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

CONTEXT_PRESET_CUTOVER_REQUIRED=0
CONTEXT_PRESET_BACKUP_DIR=""
if [[ -d "${APP_DIR}/data/chathub/presets" ]]; then
  if [[ ! -d "${DATA_DIR}/chathub/presets" ]]; then
    echo "[installer] legacy bundled presets exist without the legacy runtime directory" >&2
    exit 2
  fi
  CONTEXT_PRESET_CUTOVER_REQUIRED=1
  CONTEXT_PRESET_BACKUP_DIR="${BASE_DIR}/backup/context-presets-$(date -u +%Y%m%dT%H%M%SZ)"
  node "${STAGE_QQBOT}/dist/tools/context-preset-cutover.mjs" preflight \
    --database "${DATA_DIR}/koishi.db" \
    --legacy-bundled-dir "${APP_DIR}/data/chathub/presets" \
    --legacy-runtime-dir "${DATA_DIR}/chathub/presets" \
    --bundled-role-dir "${STAGE_QQBOT}/data/chathub/role-presets" \
    --bundled-context-dir "${STAGE_QQBOT}/data/chathub/context-presets" \
    --runtime-role-dir "${DATA_DIR}/chathub/role-presets" \
    --runtime-context-dir "${DATA_DIR}/chathub/context-presets" \
    --report "${STAGING_DIR}/context-preset-preflight.json"
fi

MODEL_CONFIG_CUTOVER_REQUIRED=0
MODEL_CONFIG_BACKUP_DIR=""
MODEL_CONFIG_MAPPING_ARGS=()
if [[ -e "${MODEL_CONFIG_MAPPING_FILE}" ]]; then
  if [[ -L "${MODEL_CONFIG_MAPPING_FILE}" || ! -f "${MODEL_CONFIG_MAPPING_FILE}" ]]; then
    echo "[installer] model config mapping must be a regular file: ${MODEL_CONFIG_MAPPING_FILE}" >&2
    exit 2
  fi
  chmod 600 "${MODEL_CONFIG_MAPPING_FILE}"
  MODEL_CONFIG_MAPPING_ARGS=(--model-map-file "${MODEL_CONFIG_MAPPING_FILE}")
fi
if [[ -f "${DATA_DIR}/model-config.json" && -f "${SHARED_DIR}/model-config.kek" ]]; then
  :
elif [[ -e "${DATA_DIR}/model-config.json" || -e "${SHARED_DIR}/model-config.kek" ]]; then
  echo "[installer] canonical model config and KEK must either both exist or both be absent" >&2
  exit 2
else
  if [[ ! -f "${DATA_DIR}/koishi.db" ]]; then
    echo "[installer] canonical model config is absent and the legacy SQLite database is missing" >&2
    echo "[installer] initialize or import an explicit canonical model config before a clean install" >&2
    exit 2
  fi
  MODEL_CONFIG_CUTOVER_REQUIRED=1
  MODEL_CONFIG_BACKUP_DIR="${BASE_DIR}/backup/model-config-$(date -u +%Y%m%dT%H%M%SZ)"
  node "${STAGE_QQBOT}/dist/tools/model-config-cutover.mjs" preflight \
    --database "${DATA_DIR}/koishi.db" \
    --env-file "${ENV_SERVER}" \
    --env-file "${ENV_RUNTIME}" \
    --agent-data-root "${AGENT_DATA_ROOT}" \
    --legacy-agent-root "${LEGACY_APP_AGENT_DIR}" \
    --archive-root "${DATA_DIR}/chatluna/archive" \
    --config-out "${DATA_DIR}/model-config.json" \
    --kek-out "${SHARED_DIR}/model-config.kek" \
    "${MODEL_CONFIG_MAPPING_ARGS[@]}"
fi

ACTIVATION_STARTED=1
if systemctl cat qqbot.target >/dev/null 2>&1; then
  systemctl stop qqbot.target
fi

snapshot_database
snapshot_path "persistent-agents" "${PERSISTENT_AGENT_DIR}"
snapshot_path "persistent-skills" "${AGENT_DATA_ROOT}/skills"
snapshot_path "persistent-computer" "${AGENT_DATA_ROOT}/computer"
snapshot_path "legacy-app-agent" "${LEGACY_APP_AGENT_DIR}"
snapshot_path "archives" "${DATA_DIR}/chatluna/archive"
snapshot_path "legacy-presets" "${DATA_DIR}/chathub/presets"
snapshot_path "context-presets" "${DATA_DIR}/chathub/context-presets"
snapshot_path "role-presets" "${DATA_DIR}/chathub/role-presets"
snapshot_path "model-config" "${DATA_DIR}/model-config.json"
snapshot_path "model-kek" "${SHARED_DIR}/model-config.kek"
snapshot_path "model-map" "${MODEL_CONFIG_MAPPING_FILE}"
snapshot_path "unit-pmhq-container" "${QUADLET_DIR}/qqbot-pmhq.container"
snapshot_path "unit-llbot" "${SYSTEMD_DIR}/qqbot-llbot.service"
snapshot_path "unit-koishi" "${SYSTEMD_DIR}/qqbot-koishi.service"
snapshot_path "unit-hbu-tunnel" "${SYSTEMD_DIR}/cloudflared-qqbot-hbu-jw.service"
snapshot_path "unit-genshin-tunnel" "${SYSTEMD_DIR}/cloudflared-qqbot-genshin.service"
snapshot_path "unit-target" "${SYSTEMD_DIR}/qqbot.target"
snapshot_path "legacy-pmhq-unit" "${SYSTEMD_DIR}/qqbot-pmhq.service"
snapshot_path "legacy-podman-dropin" "${SYSTEMD_DIR}/podman-restart.service.d/qqbot-no-global-stop.conf"
TRANSACTION_SNAPSHOT_COMPLETE=1

(
  set -a
  # shellcheck disable=SC1090
  . "${ENV_SERVER}"
  # shellcheck disable=SC1090
  . "${ENV_RUNTIME}"
  set +a
  QQBOT_APP_DIR="${APP_DIR}" \
  QQBOT_APP_ROOT="${APP_ROOT}" \
  QQBOT_DATA_DIR="${DATA_DIR}" \
  QQBOT_SHARED_DIR="${SHARED_DIR}" \
  QQBOT_SYSTEMD_DIR="${SYSTEMD_DIR}" \
  QQBOT_QUADLET_DIR="${QUADLET_DIR}" \
  QQBOT_CLOUDFLARED_HBU_JW_TOKEN_FILE="${CLOUDFLARED_HBU_JW_TOKEN_FILE}" \
  QQBOT_CLOUDFLARED_GENSHIN_TOKEN_FILE="${CLOUDFLARED_GENSHIN_TOKEN_FILE}" \
  QQBOT_HBU_WEBVPN_BROKER_CREDENTIAL="${HBU_WEBVPN_BROKER_CREDENTIAL}" \
    node "${STAGE_QQBOT}/deploy/render-systemd.mjs"
)
systemctl daemon-reload
systemctl cat qqbot-pmhq.service >/dev/null

if [[ "${CONTEXT_PRESET_CUTOVER_REQUIRED}" == "1" ]]; then
  node "${STAGE_QQBOT}/dist/tools/context-preset-cutover.mjs" apply \
    --database "${DATA_DIR}/koishi.db" \
    --legacy-bundled-dir "${APP_DIR}/data/chathub/presets" \
    --legacy-runtime-dir "${DATA_DIR}/chathub/presets" \
    --bundled-role-dir "${STAGE_QQBOT}/data/chathub/role-presets" \
    --bundled-context-dir "${STAGE_QQBOT}/data/chathub/context-presets" \
    --runtime-role-dir "${DATA_DIR}/chathub/role-presets" \
    --runtime-context-dir "${DATA_DIR}/chathub/context-presets" \
    --backup-dir "${CONTEXT_PRESET_BACKUP_DIR}" \
    --report "${CONTEXT_PRESET_BACKUP_DIR}/applied.json" \
    --confirm-service-stopped
fi
if [[ "${MODEL_CONFIG_CUTOVER_REQUIRED}" == "1" ]]; then
  node "${STAGE_QQBOT}/dist/tools/model-config-cutover.mjs" apply \
    --database "${DATA_DIR}/koishi.db" \
    --env-file "${ENV_SERVER}" \
    --env-file "${ENV_RUNTIME}" \
    --agent-data-root "${AGENT_DATA_ROOT}" \
    --legacy-agent-root "${LEGACY_APP_AGENT_DIR}" \
    --archive-root "${DATA_DIR}/chatluna/archive" \
    --config-out "${DATA_DIR}/model-config.json" \
    --kek-out "${SHARED_DIR}/model-config.kek" \
    "${MODEL_CONFIG_MAPPING_ARGS[@]}" \
    --backup-dir "${MODEL_CONFIG_BACKUP_DIR}" \
    --report "${MODEL_CONFIG_BACKUP_DIR}/applied.json" \
    --confirm-service-stopped
fi
if [[ -e "${APP_ROOT}" || -L "${APP_ROOT}" ]]; then
  mv "${APP_ROOT}" "${PREVIOUS_APP_ROOT}"
  APP_PREVIOUS_EXISTED=1
fi
mv "${WORK_DIR}" "${APP_ROOT}"
APP_SWAPPED=1
chmod 755 "${APP_ROOT}" "${APP_DIR}"
systemctl enable qqbot.target >/dev/null
if [[ "${ACTIVATION_MODE}" == "start" ]]; then
  systemctl restart qqbot.target
  QQBOT_BASE_DIR="${BASE_DIR}" bash "${APP_DIR}/deploy/verify.sh" "${VERIFY_SCOPE}"
else
  echo "[installer] application installed with qqbot.target kept stopped"
fi

if [[ "${CONTEXT_PRESET_CUTOVER_REQUIRED}" == "1" && "${ACTIVATION_MODE}" == "start" ]]; then
  rm -r -- "${DATA_DIR}/chathub/presets"
fi
clear_managed_dir "${INCOMING_DIR}"
clear_managed_dir "${STAGING_DIR}"
ACTIVATION_STARTED=0
echo "[installer] deployed single instance to ${APP_ROOT}"

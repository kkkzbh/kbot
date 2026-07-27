#!/usr/bin/env bash
set -euo pipefail

BUNDLE_PATH="${1:-}"
VERIFY_SCOPE="${2:-full}"
ACTIVATION_MODE="${3:-start}"
INSTALLER_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOYMENT_TRANSACTION_LIB="${INSTALLER_DIR}/deployment-transaction.sh"
if [[ ! -f "${DEPLOYMENT_TRANSACTION_LIB}" ]]; then
  echo "[installer] missing deployment transaction policy: ${DEPLOYMENT_TRANSACTION_LIB}" >&2
  exit 2
fi
# shellcheck disable=SC1090
source "${DEPLOYMENT_TRANSACTION_LIB}"
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
DEPLOYMENT_TRANSACTION_STATE_FILE="${SHARED_DIR}/deployment-transaction.state"
NEW_TRANSACTION_ID="${TRANSACTION_ID}"
NEW_TRANSACTION_BACKUP_DIR="${TRANSACTION_BACKUP_DIR}"

inhibit_deployment_boot() {
  local inhibit_failed=0
  local unit
  for unit in qqbot.target qqbot-koishi.service qqbot-llbot.service; do
    if systemctl cat "${unit}" >/dev/null 2>&1; then
      systemctl disable "${unit}" >/dev/null || inhibit_failed=1
    fi
  done
  sync -f "${SYSTEMD_DIR}" || inhibit_failed=1
  if [[ -d "${SYSTEMD_DIR}/multi-user.target.wants" ]]; then
    sync -f "${SYSTEMD_DIR}/multi-user.target.wants" || inhibit_failed=1
  fi
  [[ "${inhibit_failed}" == "0" ]]
}

verify_deployment_boot_inhibited() {
  if systemctl is-enabled --quiet qqbot.target 2>/dev/null; then
    echo "[installer] qqbot.target is still enabled during deployment transaction" >&2
    return 1
  fi
  if systemctl is-enabled --quiet qqbot-koishi.service 2>/dev/null; then
    echo "[installer] qqbot-koishi.service must not own an independent boot path" >&2
    return 1
  fi
  if systemctl is-enabled --quiet qqbot-llbot.service 2>/dev/null; then
    echo "[installer] qqbot-llbot.service must not own an independent boot path" >&2
    return 1
  fi
}

enable_deployment_boot() {
  systemctl enable qqbot.target >/dev/null || return 1
  sync -f "${SYSTEMD_DIR}" || return 1
  sync -f "${SYSTEMD_DIR}/multi-user.target.wants" || return 1
  if ! systemctl is-enabled --quiet qqbot.target; then
    echo "[installer] qqbot.target did not become enabled after deployment gates" >&2
    return 1
  fi
}

restore_early_environment() {
  local restore_failed=0
  deployment_transaction_restore_snapshot_path "${TRANSACTION_PATHS_DIR}" "env-server" "${ENV_SERVER}" || restore_failed=1
  deployment_transaction_restore_snapshot_path "${TRANSACTION_PATHS_DIR}" "env-runtime" "${ENV_RUNTIME}" || restore_failed=1
  deployment_transaction_restore_snapshot_path "${TRANSACTION_PATHS_DIR}" "env-pmhq" "${SHARED_DIR}/.env.pmhq" || restore_failed=1
  [[ "${restore_failed}" == "0" ]]
}

stop_deployment_stack() {
  local stop_failed=0
  systemctl stop qqbot.target qqbot-koishi.service qqbot-llbot.service || stop_failed=1
  inhibit_deployment_boot || stop_failed=1
  if systemctl is-active --quiet qqbot.target; then
    echo "[installer] qqbot.target is still active after stop" >&2
    stop_failed=1
  fi
  if systemctl is-active --quiet qqbot-koishi.service; then
    echo "[installer] qqbot-koishi.service is still active after target stop" >&2
    stop_failed=1
  fi
  verify_deployment_boot_inhibited || stop_failed=1
  [[ "${stop_failed}" == "0" ]]
}

restore_offline_transaction() {
  local restore_failed=0

  if [[ "${DEPLOYMENT_TRANSACTION_PHASE}" != "offline-restore-verification" ]]; then
    deployment_transaction_restore_application \
      "${APP_ROOT}" \
      "${PREVIOUS_APP_ROOT}" \
      "${FAILED_NEW_APP_ROOT}" \
      || restore_failed=1

    if [[ "${TRANSACTION_SNAPSHOT_COMPLETE}" == "1" ]]; then
      deployment_transaction_restore_database_snapshot \
        "${TRANSACTION_PATHS_DIR}" \
        "${DATA_DIR}/koishi.db" \
        || restore_failed=1
      deployment_transaction_restore_snapshot_path "${TRANSACTION_PATHS_DIR}" "persistent-agents" "${PERSISTENT_AGENT_DIR}" || restore_failed=1
      deployment_transaction_restore_snapshot_path "${TRANSACTION_PATHS_DIR}" "persistent-skills" "${AGENT_DATA_ROOT}/skills" || restore_failed=1
      deployment_transaction_restore_snapshot_path "${TRANSACTION_PATHS_DIR}" "persistent-computer" "${AGENT_DATA_ROOT}/computer" || restore_failed=1
      deployment_transaction_restore_snapshot_path "${TRANSACTION_PATHS_DIR}" "legacy-app-agent" "${LEGACY_APP_AGENT_DIR}" || restore_failed=1
      deployment_transaction_restore_snapshot_path "${TRANSACTION_PATHS_DIR}" "archives" "${DATA_DIR}/chatluna/archive" || restore_failed=1
      deployment_transaction_restore_snapshot_path "${TRANSACTION_PATHS_DIR}" "legacy-presets" "${DATA_DIR}/chathub/presets" || restore_failed=1
      deployment_transaction_restore_snapshot_path "${TRANSACTION_PATHS_DIR}" "context-presets" "${DATA_DIR}/chathub/context-presets" || restore_failed=1
      deployment_transaction_restore_snapshot_path "${TRANSACTION_PATHS_DIR}" "role-presets" "${DATA_DIR}/chathub/role-presets" || restore_failed=1
      deployment_transaction_restore_snapshot_path "${TRANSACTION_PATHS_DIR}" "model-config" "${DATA_DIR}/model-config.json" || restore_failed=1
      deployment_transaction_restore_snapshot_path "${TRANSACTION_PATHS_DIR}" "model-kek" "${SHARED_DIR}/model-config.kek" || restore_failed=1
      deployment_transaction_restore_snapshot_path "${TRANSACTION_PATHS_DIR}" "model-map" "${MODEL_CONFIG_MAPPING_FILE}" || restore_failed=1
      deployment_transaction_restore_snapshot_path "${TRANSACTION_PATHS_DIR}" "unit-pmhq-container" "${QUADLET_DIR}/qqbot-pmhq.container" || restore_failed=1
      deployment_transaction_restore_snapshot_path "${TRANSACTION_PATHS_DIR}" "unit-llbot" "${SYSTEMD_DIR}/qqbot-llbot.service" || restore_failed=1
      deployment_transaction_restore_snapshot_path "${TRANSACTION_PATHS_DIR}" "unit-koishi" "${SYSTEMD_DIR}/qqbot-koishi.service" || restore_failed=1
      deployment_transaction_restore_snapshot_path "${TRANSACTION_PATHS_DIR}" "unit-hbu-tunnel" "${SYSTEMD_DIR}/cloudflared-qqbot-hbu-jw.service" || restore_failed=1
      deployment_transaction_restore_snapshot_path "${TRANSACTION_PATHS_DIR}" "unit-genshin-tunnel" "${SYSTEMD_DIR}/cloudflared-qqbot-genshin.service" || restore_failed=1
      deployment_transaction_restore_snapshot_path "${TRANSACTION_PATHS_DIR}" "unit-target" "${SYSTEMD_DIR}/qqbot.target" || restore_failed=1
      deployment_transaction_restore_snapshot_path "${TRANSACTION_PATHS_DIR}" "legacy-pmhq-unit" "${SYSTEMD_DIR}/qqbot-pmhq.service" || restore_failed=1
      deployment_transaction_restore_snapshot_path "${TRANSACTION_PATHS_DIR}" "legacy-podman-dropin" "${SYSTEMD_DIR}/podman-restart.service.d/qqbot-no-global-stop.conf" || restore_failed=1
    fi

    if [[ "${TRANSACTION_BACKUP_CREATED}" == "1" ]]; then
      restore_early_environment || restore_failed=1
    fi
    if [[ "${restore_failed}" == "0" ]]; then
      if [[ -f "${DATA_DIR}/koishi.db" ]]; then
        deployment_transaction_validate_sqlite_database "${DATA_DIR}/koishi.db" || restore_failed=1
        sync -f "${DATA_DIR}/koishi.db" || restore_failed=1
      elif [[ -e "${DATA_DIR}/koishi.db" || -L "${DATA_DIR}/koishi.db" ]]; then
        echo "[installer] restored SQLite path is not a regular file" >&2
        restore_failed=1
      fi
    fi
    if [[ "${restore_failed}" == "0" ]]; then
      sync -f "${DATA_DIR}" || restore_failed=1
      sync -f "${SHARED_DIR}" || restore_failed=1
      sync -f "${SYSTEMD_DIR}" || restore_failed=1
      if [[ -d "${APP_ROOT}" ]]; then
        sync -f "${APP_ROOT}" || restore_failed=1
      else
        deployment_transaction_fsync_existing_parent "${APP_ROOT}" || restore_failed=1
      fi
    fi
    if [[ "${restore_failed}" == "0" ]]; then
      deployment_transaction_mark_restore_verification || restore_failed=1
    fi
  fi

  systemctl daemon-reload || restore_failed=1
  if [[ "${restore_failed}" == "0" && "${APP_PREVIOUS_EXISTED}" == "0" ]]; then
    deployment_transaction_complete || restore_failed=1
    [[ "${restore_failed}" == "0" ]]
    return
  fi
  if [[ "${restore_failed}" == "0" ]]; then
    systemctl start qqbot.target || restore_failed=1
  fi
  if [[ "${restore_failed}" == "0" ]]; then
    QQBOT_BASE_DIR="${BASE_DIR}" bash "${APP_DIR}/deploy/verify.sh" "${VERIFY_SCOPE}" \
      || restore_failed=1
  fi
  if [[ "${restore_failed}" == "0" ]]; then
    deployment_transaction_complete_after_boot_verification enable_deployment_boot \
      || restore_failed=1
  fi
  if [[ "${restore_failed}" != "0" ]]; then
    stop_deployment_stack || true
  fi

  [[ "${restore_failed}" == "0" ]]
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
    case "${DEPLOYMENT_TRANSACTION_PHASE}" in
      offline-*|app-swap-intent|app-previous-moved)
        echo "[installer] deployment failed before runtime ownership transfer; restoring transaction ${TRANSACTION_BACKUP_DIR}" >&2
        ;;
    esac
    deployment_transaction_execute_activated_failure \
      stop_deployment_stack \
      restore_offline_transaction \
      || rollback_failed=1
    if [[ "${DEPLOYMENT_TRANSACTION_FAILURE_ACTION}" == "stop-and-roll-forward" ]]; then
      echo "[installer] deployment failed after runtime ownership transfer; no snapshot was restored" >&2
      echo "[installer] the new application and database remain paired; repair forward before restarting qqbot.target" >&2
      echo "[installer] recovery material: ${TRANSACTION_BACKUP_DIR}" >&2
      if [[ "${rollback_failed}" != "0" ]]; then
        echo "[installer] qqbot.target or qqbot-koishi.service could not be confirmed stopped" >&2
      fi
      exit "${status}"
    fi
    if [[ "${DEPLOYMENT_TRANSACTION_FAILURE_ACTION}" == "keep-installed-stopped" ]]; then
      echo "[installer] deployment remains installed and boot-inhibited for an explicit resume" >&2
      exit "${status}"
    fi
  fi

  if [[ "${ACTIVATION_STARTED}" != "1" && "${TRANSACTION_BACKUP_CREATED}" == "1" ]]; then
    restore_early_environment || rollback_failed=1
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

for cmd in bash tar node pnpm python3 systemctl journalctl curl podman cloudflared sync flock; do
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
  "${DATA_DIR}/chatluna/web-artifacts" \
  "${PERSISTENT_AGENT_DIR}" \
  "${DATA_DIR}/chathub/context-presets" \
  "${DATA_DIR}/chathub/role-presets" \
  "${DATA_DIR}/chathub/stickers" \
  "${DATA_DIR}/cache/yarn" \
  "${DATA_DIR}/cache/pnpm-store" \
  "${SHARED_DIR}" \
  "${INCOMING_DIR}" \
  "${STAGING_DIR}"
chmod 700 \
  "${DATA_DIR}" \
  "${SHARED_DIR}" \
  "${DATA_DIR}/chatluna/archive" \
  "${DATA_DIR}/chatluna/web-artifacts"
exec 9>"${SHARED_DIR}/deployment-installer.lock"
chmod 600 "${SHARED_DIR}/deployment-installer.lock"
if ! flock -n 9; then
  echo "[installer] another deployment transaction is active" >&2
  exit 2
fi

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

set_env_key() {
  local file="$1"
  local key="$2"
  local value="$3"
  local tmp
  tmp="$(mktemp "${file}.tmp.XXXXXX")"
  if [[ -f "${file}" ]]; then
    awk -v prefix="${key}=" 'index($0, prefix) != 1' "${file}" > "${tmp}"
  fi
  printf '%s=%s\n' "${key}" "${value}" >> "${tmp}"
  chmod 600 "${tmp}"
  mv "${tmp}" "${file}"
}

adopt_loaded_deployment_transaction() {
  VERIFY_SCOPE="${DEPLOYMENT_TRANSACTION_VERIFY_SCOPE}"
  TRANSACTION_ID="${DEPLOYMENT_TRANSACTION_ID}"
  TRANSACTION_BACKUP_DIR="${DEPLOYMENT_TRANSACTION_BACKUP_DIR}"
  TRANSACTION_PATHS_DIR="${TRANSACTION_BACKUP_DIR}/paths"
  PREVIOUS_APP_ROOT="${TRANSACTION_BACKUP_DIR}/previous-app"
  FAILED_NEW_APP_ROOT="${TRANSACTION_BACKUP_DIR}/failed-new-app"
  TRANSACTION_BACKUP_CREATED=1
  TRANSACTION_SNAPSHOT_COMPLETE="${DEPLOYMENT_TRANSACTION_SNAPSHOT_COMPLETE}"
  APP_SWAPPED="${DEPLOYMENT_TRANSACTION_APP_SWAPPED}"
  APP_PREVIOUS_EXISTED="${DEPLOYMENT_TRANSACTION_APP_PREVIOUS_EXISTED}"
}

reset_new_deployment_transaction() {
  deployment_transaction_initialize
  TRANSACTION_ID="${NEW_TRANSACTION_ID}"
  TRANSACTION_BACKUP_DIR="${NEW_TRANSACTION_BACKUP_DIR}"
  TRANSACTION_PATHS_DIR="${TRANSACTION_BACKUP_DIR}/paths"
  PREVIOUS_APP_ROOT="${TRANSACTION_BACKUP_DIR}/previous-app"
  FAILED_NEW_APP_ROOT="${TRANSACTION_BACKUP_DIR}/failed-new-app"
  TRANSACTION_BACKUP_CREATED=0
  TRANSACTION_SNAPSHOT_COMPLETE=0
  APP_SWAPPED=0
  APP_PREVIOUS_EXISTED=0
}

run_memory_v2_runtime_gates() {
  if [[ "${DEPLOYMENT_TRANSACTION_PURPOSE}" == "memory-v2" && ! -s "${DEPLOYMENT_TRANSACTION_PREFLIGHT_REPORT}" ]]; then
    echo "[installer] persisted Memory V2 preflight report is missing: ${DEPLOYMENT_TRANSACTION_PREFLIGHT_REPORT}" >&2
    return 1
  fi

  verify_deployment_boot_inhibited
  systemctl daemon-reload
  systemctl restart qqbot.target
  QQBOT_BASE_DIR="${BASE_DIR}" bash "${APP_DIR}/deploy/verify.sh" "${DEPLOYMENT_TRANSACTION_VERIFY_SCOPE}"

  if [[ "${DEPLOYMENT_TRANSACTION_PURPOSE}" == "ordinary" ]]; then
    deployment_transaction_mark_runtime_phase runtime-final
  fi

  if [[ "${DEPLOYMENT_TRANSACTION_PHASE}" == "runtime-bootstrap" ]]; then
    node "${APP_DIR}/dist/tools/memory-v2-cutover.mjs" bootstrap-verify \
      --database "${DATA_DIR}/koishi.db" \
      --model-config "${DATA_DIR}/model-config.json" \
      --koishi-config "${APP_DIR}/koishi.yml" \
      --bundled-context-dir "${APP_DIR}/data/chathub/context-presets" \
      --runtime-context-dir "${DATA_DIR}/chathub/context-presets" \
      --preflight-report "${DEPLOYMENT_TRANSACTION_PREFLIGHT_REPORT}"
    deployment_transaction_mark_runtime_phase runtime-probes
  fi

  if [[ "${DEPLOYMENT_TRANSACTION_PHASE}" == "runtime-probes" ]]; then
    set_env_key "${ENV_SERVER}" "MEMORY_MAINTENANCE" "false"
    set_env_key "${ENV_SERVER}" "MEMORY_READ_ENABLED" "false"
    set_env_key "${ENV_SERVER}" "MEMORY_WRITE_ENABLED" "false"
    remove_env_key "${ENV_RUNTIME}" "MEMORY_MAINTENANCE"
    remove_env_key "${ENV_RUNTIME}" "MEMORY_READ_ENABLED"
    remove_env_key "${ENV_RUNTIME}" "MEMORY_WRITE_ENABLED"
    systemctl restart qqbot-koishi.service
    QQBOT_BASE_DIR="${BASE_DIR}" bash "${APP_DIR}/deploy/verify.sh" koishi
    (
      set -a
      # shellcheck disable=SC1090
      . "${ENV_SERVER}"
      if [[ -f "${ENV_RUNTIME}" ]]; then
        # shellcheck disable=SC1090
        . "${ENV_RUNTIME}"
      fi
      set +a
      node "${APP_DIR}/dist/tools/memory-v2-cutover.mjs" probe-gate \
        --database "${DATA_DIR}/koishi.db" \
        --preflight-report "${DEPLOYMENT_TRANSACTION_PREFLIGHT_REPORT}" \
        --admin-origin "${QQBOT_ADMIN_SSH_ORIGIN}"
    )
    deployment_transaction_mark_runtime_phase runtime-backfill
  fi

  if [[ "${DEPLOYMENT_TRANSACTION_PHASE}" == "runtime-backfill" ]]; then
    local attempt=0
    local ready=0
    local verify_error="${STAGING_DIR}/memory-v2-verify.error"
    mkdir -p "${STAGING_DIR}"
    while [[ "${attempt}" -lt 180 ]]; do
      attempt=$((attempt + 1))
      if node "${APP_DIR}/dist/tools/memory-v2-cutover.mjs" verify \
        --database "${DATA_DIR}/koishi.db" \
        --model-config "${DATA_DIR}/model-config.json" \
        --koishi-config "${APP_DIR}/koishi.yml" \
        --bundled-context-dir "${APP_DIR}/data/chathub/context-presets" \
        --runtime-context-dir "${DATA_DIR}/chathub/context-presets" \
        --preflight-report "${DEPLOYMENT_TRANSACTION_PREFLIGHT_REPORT}" \
        2>"${verify_error}"
      then
        ready=1
        break
      fi
      sleep 5
    done
    if [[ "${ready}" != "1" ]]; then
      cat "${verify_error}" >&2
      echo "[installer] Memory V2 final backfill and stranded gate timed out" >&2
      return 1
    fi
    rm -f -- "${verify_error}"
    deployment_transaction_mark_runtime_phase runtime-final
  fi

  if [[ "${DEPLOYMENT_TRANSACTION_PHASE}" != "runtime-final" ]]; then
    echo "[installer] runtime transaction stopped in unexpected phase: ${DEPLOYMENT_TRANSACTION_PHASE}" >&2
    return 1
  fi
  QQBOT_BASE_DIR="${BASE_DIR}" bash "${APP_DIR}/deploy/verify.sh" "${DEPLOYMENT_TRANSACTION_VERIFY_SCOPE}"
}

resume_or_recover_deployment_transaction() {
  local load_status=0
  deployment_transaction_load_existing "${DEPLOYMENT_TRANSACTION_STATE_FILE}" || load_status=$?
  if [[ "${load_status}" == "1" ]]; then
    return 0
  fi
  if [[ "${load_status}" != "0" ]]; then
    return "${load_status}"
  fi

  case "${DEPLOYMENT_TRANSACTION_BACKUP_DIR}" in
    "${BASE_DIR}/backup/deploy-"*) ;;
    *) echo "[installer] persisted deployment backup is outside the managed backup root" >&2; return 2 ;;
  esac
  if [[
    "${DEPLOYMENT_TRANSACTION_PURPOSE}" == "memory-v2"
    && "${DEPLOYMENT_TRANSACTION_PREFLIGHT_REPORT}" != "${DEPLOYMENT_TRANSACTION_BACKUP_DIR}/memory-v2-preflight.json"
  ]]; then
    echo "[installer] persisted Memory V2 report path is outside its transaction backup" >&2
    return 2
  fi
  adopt_loaded_deployment_transaction
  inhibit_deployment_boot
  verify_deployment_boot_inhibited
  ACTIVATION_STARTED=1

  case "${DEPLOYMENT_TRANSACTION_PHASE}" in
    runtime-bootstrap|runtime-probes|runtime-backfill|runtime-final)
      echo "[installer] resuming transaction ${TRANSACTION_ID} at ${DEPLOYMENT_TRANSACTION_PHASE}"
      run_memory_v2_runtime_gates
      deployment_transaction_complete_after_boot_verification enable_deployment_boot
      ACTIVATION_STARTED=0
      echo "[installer] resumed deployment transaction ${TRANSACTION_ID}"
      exit 0
      ;;
    installed-stopped)
      if [[ "${ACTIVATION_MODE}" == "keep-stopped" ]]; then
        echo "[installer] transaction ${TRANSACTION_ID} remains installed and boot-inhibited"
        ACTIVATION_STARTED=0
        exit 0
      fi
      deployment_transaction_transfer_runtime_ownership
      run_memory_v2_runtime_gates
      deployment_transaction_complete_after_boot_verification enable_deployment_boot
      ACTIVATION_STARTED=0
      echo "[installer] activated stopped deployment transaction ${TRANSACTION_ID}"
      exit 0
      ;;
    offline-inhibited|offline-snapshot-ready|app-swap-intent|app-previous-moved|offline-app-swapped|offline-restore-verification)
      echo "[installer] recovering interrupted offline transaction ${TRANSACTION_ID}" >&2
      restore_offline_transaction
      ACTIVATION_STARTED=0
      reset_new_deployment_transaction
      ;;
    *)
      echo "[installer] unsupported persisted deployment phase: ${DEPLOYMENT_TRANSACTION_PHASE}" >&2
      return 2
      ;;
  esac
}

resume_or_recover_deployment_transaction

mkdir -p "${BASE_DIR}/backup"
mkdir "${TRANSACTION_BACKUP_DIR}"
chmod 700 "${TRANSACTION_BACKUP_DIR}"
sync -f "${BASE_DIR}/backup"
sync -f "${TRANSACTION_BACKUP_DIR}"
deployment_transaction_snapshot_path "${TRANSACTION_PATHS_DIR}" "env-server" "${ENV_SERVER}"
deployment_transaction_snapshot_path "${TRANSACTION_PATHS_DIR}" "env-runtime" "${ENV_RUNTIME}"
deployment_transaction_snapshot_path "${TRANSACTION_PATHS_DIR}" "env-pmhq" "${SHARED_DIR}/.env.pmhq"
TRANSACTION_BACKUP_CREATED=1

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
    remove_env_key "${file}" "MEMORY_EXTRACT_BASE_URL"
    remove_env_key "${file}" "MEMORY_EXTRACT_API_KEY"
    remove_env_key "${file}" "MEMORY_EXTRACT_MODEL"
    remove_env_key "${file}" "MEMORY_EXTRACT_TIMEOUT_MS"
    remove_env_key "${file}" "MEMORY_EXTRACT_REQUEST_MODE"
    remove_env_key "${file}" "MEMORY_EXTRACT_STRUCTURED_OUTPUT_PROTOCOL"
    remove_env_key "${file}" "MEMORY_EXTRACT_SUPPORTS_JSON_MODE"
    remove_env_key "${file}" "MEMORY_EMBED_BASE_URL"
    remove_env_key "${file}" "MEMORY_EMBED_API_KEY"
    remove_env_key "${file}" "MEMORY_EMBED_MODEL"
    remove_env_key "${file}" "MEMORY_EMBED_TIMEOUT_MS"
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
require_bundle_entry "qqbot/dist/tools/model-auth-connection-cutover.mjs"
require_bundle_entry "qqbot/dist/tools/memory-v2-cutover.mjs"
require_bundle_entry "qqbot/dist/tools/memory-evaluation.mjs"
require_bundle_entry "qqbot/dist/tools/memory-evaluation-adapter.mjs"
require_bundle_entry "qqbot/data/chathub/context-presets"
require_bundle_entry "qqbot/data/chathub/role-presets"
require_bundle_catalog "qqbot/data/chathub/context-presets"
require_bundle_catalog "qqbot/data/chathub/role-presets"
require_bundle_entry "qqbot/deploy/deployment-transaction.sh"
require_bundle_entry "qqbot/deploy/model-config-contract.mjs"
require_bundle_entry "qqbot/deploy/render-systemd.mjs"
require_bundle_entry "qqbot/scripts/verify-memory-v2-readiness.mjs"
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
    CHATLUNA_SEARCH_SERVICE_ARTIFACT_DIR
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
  printf '%s\n' "CHATLUNA_SEARCH_SERVICE_ARTIFACT_DIR=${DATA_DIR}/chatluna/web-artifacts" >> "${tmp}"
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

MEMORY_V2_STATE="empty"
if [[ -f "${DATA_DIR}/koishi.db" ]]; then
  MEMORY_V2_STATUS_JSON="$(
    node "${STAGE_QQBOT}/dist/tools/memory-v2-cutover.mjs" status \
      --database "${DATA_DIR}/koishi.db"
  )"
  MEMORY_V2_STATE="$(
    node -e '
      const value = JSON.parse(process.argv[1]);
      if (!["empty", "legacy", "v2"].includes(value.state)) process.exit(2);
      process.stdout.write(value.state);
    ' "${MEMORY_V2_STATUS_JSON}"
  )"
fi

MODEL_CONFIG_CUTOVER_REQUIRED=0
MODEL_CONFIG_CONTRACT_REQUIRED=0
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
  MODEL_CONFIG_CONTRACT_REQUIRED=1
  if [[ "${MEMORY_V2_STATE}" != "legacy" ]]; then
    node "${STAGE_QQBOT}/deploy/model-config-contract.mjs" preflight \
      --config "${DATA_DIR}/model-config.json" \
      --schema-module "${STAGE_QQBOT}/dist/plugins/model-config/types.js"
  fi
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

MEMORY_V2_CUTOVER_REQUIRED=0
MEMORY_V2_INITIALIZE_REQUIRED=0
MEMORY_V2_BACKUP_DIR="${TRANSACTION_BACKUP_DIR}/memory-v2-cutover"
MEMORY_V2_PREFLIGHT_REPORT="${TRANSACTION_BACKUP_DIR}/memory-v2-preflight.json"
if [[ -f "${DATA_DIR}/koishi.db" ]]; then
  if [[ "${MEMORY_V2_STATE}" == "legacy" ]]; then
    if [[ "${ACTIVATION_MODE}" != "start" ]]; then
      echo "[installer] Memory V2 cutover requires activation mode start" >&2
      exit 2
    fi
    if [[ ! -f "${DATA_DIR}/model-config.json" || ! -f "${SHARED_DIR}/model-config.kek" ]]; then
      echo "[installer] Memory V2 cutover requires an already-applied canonical model config" >&2
      exit 2
    fi
    MEMORY_V2_CUTOVER_REQUIRED=1
    node "${STAGE_QQBOT}/dist/tools/memory-v2-cutover.mjs" preflight \
      --database "${DATA_DIR}/koishi.db" \
      --model-config "${DATA_DIR}/model-config.json" \
      --koishi-config "${STAGE_QQBOT}/koishi.yml" \
      --bundled-context-dir "${STAGE_QQBOT}/data/chathub/context-presets" \
      --runtime-context-dir "${DATA_DIR}/chathub/context-presets" \
      --report "${MEMORY_V2_PREFLIGHT_REPORT}"
  elif [[ "${MEMORY_V2_STATE}" == "empty" ]]; then
    MEMORY_V2_INITIALIZE_REQUIRED=1
  fi
else
  MEMORY_V2_INITIALIZE_REQUIRED=1
fi

ACTIVATION_STARTED=1
DEPLOYMENT_TRANSACTION_PURPOSE="ordinary"
if [[ "${MEMORY_V2_CUTOVER_REQUIRED}" == "1" ]]; then
  DEPLOYMENT_TRANSACTION_PURPOSE="memory-v2"
  sync -f "${MEMORY_V2_PREFLIGHT_REPORT}"
  sync -f "${TRANSACTION_BACKUP_DIR}"
fi
deployment_transaction_configure \
  "${DEPLOYMENT_TRANSACTION_STATE_FILE}" \
  "${TRANSACTION_ID}" \
  "${TRANSACTION_BACKUP_DIR}" \
  "${MEMORY_V2_PREFLIGHT_REPORT}" \
  "${VERIFY_SCOPE}" \
  "${DEPLOYMENT_TRANSACTION_PURPOSE}" \
  "${ACTIVATION_MODE}"
if [[ -e "${APP_ROOT}" || -L "${APP_ROOT}" ]]; then
  APP_PREVIOUS_EXISTED=1
fi
deployment_transaction_set_previous_app_existed "${APP_PREVIOUS_EXISTED}"
deployment_transaction_begin_offline_activation \
  inhibit_deployment_boot \
  verify_deployment_boot_inhibited
if systemctl cat qqbot.target >/dev/null 2>&1; then
  stop_deployment_stack
fi

deployment_transaction_snapshot_database "${TRANSACTION_PATHS_DIR}" "${DATA_DIR}/koishi.db"
deployment_transaction_snapshot_path "${TRANSACTION_PATHS_DIR}" "persistent-agents" "${PERSISTENT_AGENT_DIR}"
deployment_transaction_snapshot_path "${TRANSACTION_PATHS_DIR}" "persistent-skills" "${AGENT_DATA_ROOT}/skills"
deployment_transaction_snapshot_path "${TRANSACTION_PATHS_DIR}" "persistent-computer" "${AGENT_DATA_ROOT}/computer"
deployment_transaction_snapshot_path "${TRANSACTION_PATHS_DIR}" "legacy-app-agent" "${LEGACY_APP_AGENT_DIR}"
deployment_transaction_snapshot_path "${TRANSACTION_PATHS_DIR}" "archives" "${DATA_DIR}/chatluna/archive"
deployment_transaction_snapshot_path "${TRANSACTION_PATHS_DIR}" "legacy-presets" "${DATA_DIR}/chathub/presets"
deployment_transaction_snapshot_path "${TRANSACTION_PATHS_DIR}" "context-presets" "${DATA_DIR}/chathub/context-presets"
deployment_transaction_snapshot_path "${TRANSACTION_PATHS_DIR}" "role-presets" "${DATA_DIR}/chathub/role-presets"
deployment_transaction_snapshot_path "${TRANSACTION_PATHS_DIR}" "model-config" "${DATA_DIR}/model-config.json"
deployment_transaction_snapshot_path "${TRANSACTION_PATHS_DIR}" "model-kek" "${SHARED_DIR}/model-config.kek"
deployment_transaction_snapshot_path "${TRANSACTION_PATHS_DIR}" "model-map" "${MODEL_CONFIG_MAPPING_FILE}"
deployment_transaction_snapshot_path "${TRANSACTION_PATHS_DIR}" "unit-pmhq-container" "${QUADLET_DIR}/qqbot-pmhq.container"
deployment_transaction_snapshot_path "${TRANSACTION_PATHS_DIR}" "unit-llbot" "${SYSTEMD_DIR}/qqbot-llbot.service"
deployment_transaction_snapshot_path "${TRANSACTION_PATHS_DIR}" "unit-koishi" "${SYSTEMD_DIR}/qqbot-koishi.service"
deployment_transaction_snapshot_path "${TRANSACTION_PATHS_DIR}" "unit-hbu-tunnel" "${SYSTEMD_DIR}/cloudflared-qqbot-hbu-jw.service"
deployment_transaction_snapshot_path "${TRANSACTION_PATHS_DIR}" "unit-genshin-tunnel" "${SYSTEMD_DIR}/cloudflared-qqbot-genshin.service"
deployment_transaction_snapshot_path "${TRANSACTION_PATHS_DIR}" "unit-target" "${SYSTEMD_DIR}/qqbot.target"
deployment_transaction_snapshot_path "${TRANSACTION_PATHS_DIR}" "legacy-pmhq-unit" "${SYSTEMD_DIR}/qqbot-pmhq.service"
deployment_transaction_snapshot_path "${TRANSACTION_PATHS_DIR}" "legacy-podman-dropin" "${SYSTEMD_DIR}/podman-restart.service.d/qqbot-no-global-stop.conf"
TRANSACTION_SNAPSHOT_COMPLETE=1
deployment_transaction_mark_snapshot_complete

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
if [[
  "${MODEL_CONFIG_CONTRACT_REQUIRED}" == "1"
  && "${MEMORY_V2_CUTOVER_REQUIRED}" != "1"
]]; then
  node "${STAGE_QQBOT}/deploy/model-config-contract.mjs" apply \
    --config "${DATA_DIR}/model-config.json" \
    --schema-module "${STAGE_QQBOT}/dist/plugins/model-config/types.js" \
    --report "${TRANSACTION_BACKUP_DIR}/model-config-contract.json" \
    --confirm-service-stopped
fi
if [[ "${MEMORY_V2_INITIALIZE_REQUIRED}" == "1" ]]; then
  node "${STAGE_QQBOT}/dist/tools/memory-v2-cutover.mjs" initialize \
    --database "${DATA_DIR}/koishi.db" \
    --confirm-service-stopped
  set_env_key "${ENV_SERVER}" "MEMORY_ENABLED" "true"
  set_env_key "${ENV_SERVER}" "MEMORY_MAINTENANCE" "false"
  set_env_key "${ENV_SERVER}" "MEMORY_READ_ENABLED" "false"
  set_env_key "${ENV_SERVER}" "MEMORY_WRITE_ENABLED" "false"
  remove_env_key "${ENV_RUNTIME}" "MEMORY_ENABLED"
  remove_env_key "${ENV_RUNTIME}" "MEMORY_MAINTENANCE"
  remove_env_key "${ENV_RUNTIME}" "MEMORY_READ_ENABLED"
  remove_env_key "${ENV_RUNTIME}" "MEMORY_WRITE_ENABLED"
fi
if [[ "${MEMORY_V2_CUTOVER_REQUIRED}" == "1" ]]; then
  node "${STAGE_QQBOT}/dist/tools/memory-v2-cutover.mjs" apply \
    --database "${DATA_DIR}/koishi.db" \
    --model-config "${DATA_DIR}/model-config.json" \
    --koishi-config "${STAGE_QQBOT}/koishi.yml" \
    --bundled-context-dir "${STAGE_QQBOT}/data/chathub/context-presets" \
    --runtime-context-dir "${DATA_DIR}/chathub/context-presets" \
    --preflight-report "${MEMORY_V2_PREFLIGHT_REPORT}" \
    --backup-dir "${MEMORY_V2_BACKUP_DIR}" \
    --report "${MEMORY_V2_BACKUP_DIR}/applied.json" \
    --confirm-service-stopped
  set_env_key "${ENV_SERVER}" "MEMORY_ENABLED" "true"
  set_env_key "${ENV_SERVER}" "MEMORY_MAINTENANCE" "true"
  set_env_key "${ENV_SERVER}" "MEMORY_READ_ENABLED" "false"
  set_env_key "${ENV_SERVER}" "MEMORY_WRITE_ENABLED" "false"
  remove_env_key "${ENV_RUNTIME}" "MEMORY_ENABLED"
  remove_env_key "${ENV_RUNTIME}" "MEMORY_MAINTENANCE"
  remove_env_key "${ENV_RUNTIME}" "MEMORY_READ_ENABLED"
  remove_env_key "${ENV_RUNTIME}" "MEMORY_WRITE_ENABLED"
  if [[ "${MODEL_CONFIG_CONTRACT_REQUIRED}" == "1" ]]; then
    node "${STAGE_QQBOT}/deploy/model-config-contract.mjs" preflight \
      --config "${DATA_DIR}/model-config.json" \
      --schema-module "${STAGE_QQBOT}/dist/plugins/model-config/types.js"
    node "${STAGE_QQBOT}/deploy/model-config-contract.mjs" apply \
      --config "${DATA_DIR}/model-config.json" \
      --schema-module "${STAGE_QQBOT}/dist/plugins/model-config/types.js" \
      --report "${TRANSACTION_BACKUP_DIR}/model-config-contract.json" \
      --confirm-service-stopped
  fi
fi
deployment_transaction_fsync_tree "${WORK_DIR}"
deployment_transaction_swap_application \
  "${APP_ROOT}" \
  "${WORK_DIR}" \
  "${PREVIOUS_APP_ROOT}"
APP_SWAPPED=1
chmod 755 "${APP_ROOT}" "${APP_DIR}"
if [[ "${ACTIVATION_MODE}" == "start" ]]; then
  deployment_transaction_transfer_runtime_ownership
  run_memory_v2_runtime_gates
else
  deployment_transaction_mark_installed_stopped
  echo "[installer] application installed with qqbot.target kept stopped"
fi

if [[ "${CONTEXT_PRESET_CUTOVER_REQUIRED}" == "1" && "${ACTIVATION_MODE}" == "start" ]]; then
  rm -r -- "${DATA_DIR}/chathub/presets"
fi
clear_managed_dir "${INCOMING_DIR}"
clear_managed_dir "${STAGING_DIR}"
if [[ "${ACTIVATION_MODE}" == "start" ]]; then
  deployment_transaction_complete_after_boot_verification enable_deployment_boot
fi
ACTIVATION_STARTED=0
echo "[installer] deployed single instance to ${APP_ROOT}"

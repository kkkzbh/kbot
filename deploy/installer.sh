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
JOURNALD_DROP_IN_DIR="/etc/systemd/journald.conf.d"
JOURNALD_RETENTION_FILE="${JOURNALD_DROP_IN_DIR}/qqbot-retention.conf"
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
      deployment_transaction_restore_snapshot_path "${TRANSACTION_PATHS_DIR}" "natural-trigger-config" "${DATA_DIR}/natural-trigger.json" || restore_failed=1
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
      deployment_transaction_restore_snapshot_path "${TRANSACTION_PATHS_DIR}" "journald-retention" "${JOURNALD_RETENTION_FILE}" || restore_failed=1
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
  systemctl restart systemd-journald.service || restore_failed=1
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

for cmd in bash tar node pnpm python3 systemctl journalctl curl podman cloudflared sync flock runuser useradd usermod groupadd getent newuidmap newgidmap pasta fuse-overlayfs; do
  require_cmd "${cmd}"
done

ensure_qqbot_account() {
  if getent passwd 1000 >/dev/null && [[ "$(getent passwd 1000 | cut -d: -f1)" != "qqbot" ]]; then
    echo "[installer] UID 1000 is already assigned to another account" >&2
    exit 2
  fi
  if getent group 1000 >/dev/null && [[ "$(getent group 1000 | cut -d: -f1)" != "qqbot" ]]; then
    echo "[installer] GID 1000 is already assigned to another group" >&2
    exit 2
  fi
  if ! getent group qqbot >/dev/null; then
    groupadd --gid 1000 qqbot
  fi
  if ! getent passwd qqbot >/dev/null; then
    useradd --uid 1000 --gid qqbot --home-dir "${DATA_DIR}/qqbot-home" --create-home --shell /usr/sbin/nologin qqbot
  fi
  if ! grep -q '^qqbot:' /etc/subuid; then
    usermod --add-subuids 524288-589823 qqbot
  fi
  if ! grep -q '^qqbot:' /etc/subgid; then
    usermod --add-subgids 524288-589823 qqbot
  fi
}
ensure_qqbot_account

run_qqbot_podman() {
  (
    cd "${DATA_DIR}/qqbot-home"
    runuser -u qqbot -- env \
      HOME="${DATA_DIR}/qqbot-home" \
      XDG_RUNTIME_DIR=/run/qqbot \
      podman --cgroup-manager=cgroupfs "$@"
  )
}

remove_agent_workspace_containers() {
  install -d -o qqbot -g qqbot -m 700 /run/qqbot
  local listed
  listed="$(run_qqbot_podman ps -aq --filter label=io.qqbot.agent-workspace=true)"
  if [[ -n "${listed}" ]]; then
    local containers=()
    mapfile -t containers <<< "${listed}"
    run_qqbot_podman rm -f -- "${containers[@]}"
  fi
  if [[ -n "$(run_qqbot_podman ps -aq --filter label=io.qqbot.agent-workspace=true)" ]]; then
    echo "[installer] Agent workspace containers remain after shutdown" >&2
    return 1
  fi
}

adopt_runtime_data_ownership() {
  chown qqbot:qqbot "${DATA_DIR}" "${DATA_DIR}/qqbot-home"
  local runtime_path
  while IFS= read -r -d '' runtime_path; do
    chown -R qqbot:qqbot "${runtime_path}"
  done < <(
    find "${DATA_DIR}" -mindepth 1 -maxdepth 1 \
      ! -path "${DATA_DIR}/qqbot-home" -print0
  )
}

prepare_model_auth_runtime_ownership() {
  local state_name
  local state_path
  local secret_name
  local secret_path
  for state_name in \
    codex-chatgpt.oauth.json \
    codex-release-metadata.json \
    github-copilot.oauth.json \
    github-copilot.session.json; do
    state_path="${SHARED_DIR}/${state_name}"
    if [[ -L "${state_path}" ]]; then
      echo "[installer] model auth runtime state must not be a symbolic link: ${state_path}" >&2
      return 1
    fi
    if [[ ! -e "${state_path}" ]]; then
      continue
    fi
    if [[ ! -f "${state_path}" ]]; then
      echo "[installer] model auth runtime state must be a regular file: ${state_path}" >&2
      return 1
    fi
    chown qqbot:qqbot "${state_path}"
    chmod 600 "${state_path}"
  done

  find "${SHARED_DIR}" -maxdepth 1 -type f \( \
    -name 'codex-chatgpt.oauth.json.tmp.*' -o \
    -name 'codex-release-metadata.json.tmp.*' -o \
    -name 'github-copilot.oauth.json.tmp.*' -o \
    -name 'github-copilot.session.json.tmp.*' \
  \) -delete

  for secret_name in \
    codex-oauth.bridge-secret \
    github-copilot.bridge-secret; do
    secret_path="${SHARED_DIR}/${secret_name}"
    if [[ -L "${secret_path}" ]]; then
      echo "[installer] model auth bridge secret must not be a symbolic link: ${secret_path}" >&2
      return 1
    fi
    if [[ ! -e "${secret_path}" ]]; then
      continue
    fi
    if [[ ! -f "${secret_path}" ]]; then
      echo "[installer] model auth bridge secret must be a regular file: ${secret_path}" >&2
      return 1
    fi
    chown root:qqbot "${secret_path}"
    chmod 640 "${secret_path}"
  done
}

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
  "${DATA_DIR}/qqbot-home" \
  "${SHARED_DIR}" \
  "${INCOMING_DIR}" \
  "${STAGING_DIR}"
chmod 700 \
  "${DATA_DIR}" \
  "${DATA_DIR}/chatluna/archive" \
  "${DATA_DIR}/chatluna/web-artifacts"
chown qqbot:qqbot "${DATA_DIR}" "${DATA_DIR}/qqbot-home"
chown root:qqbot "${SHARED_DIR}"
chmod 750 "${SHARED_DIR}"
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
chown root:qqbot "${ENV_SERVER}"
chmod 640 "${ENV_SERVER}"

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
  if [[ "${file}" == "${ENV_SERVER}" || "${file}" == "${ENV_RUNTIME}" ]]; then
    chown root:qqbot "${file}"
    chmod 640 "${file}"
  fi
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
  if [[ "${file}" == "${ENV_SERVER}" || "${file}" == "${ENV_RUNTIME}" ]]; then
    chown root:qqbot "${file}"
    chmod 640 "${file}"
  fi
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

run_runtime_gates() {
  if [[ "${DEPLOYMENT_TRANSACTION_PURPOSE}" == "memory-v3" && ! -s "${DEPLOYMENT_TRANSACTION_PREFLIGHT_REPORT}" ]]; then
    echo "[installer] persisted Memory V3 preflight report is missing: ${DEPLOYMENT_TRANSACTION_PREFLIGHT_REPORT}" >&2
    return 1
  fi

  verify_deployment_boot_inhibited
  systemctl daemon-reload
  systemctl restart qqbot.target
  QQBOT_BASE_DIR="${BASE_DIR}" bash "${APP_DIR}/deploy/verify.sh" "${DEPLOYMENT_TRANSACTION_VERIFY_SCOPE}"
  deployment_transaction_mark_runtime_phase runtime-final
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
    "${DEPLOYMENT_TRANSACTION_PURPOSE}" == "memory-v3"
    && "${DEPLOYMENT_TRANSACTION_PREFLIGHT_REPORT}" != "${DEPLOYMENT_TRANSACTION_BACKUP_DIR}/memory-v3-preflight.json"
  ]]; then
    echo "[installer] persisted Memory V3 report path is outside its transaction backup" >&2
    return 2
  fi
  adopt_loaded_deployment_transaction
  inhibit_deployment_boot
  verify_deployment_boot_inhibited
  ACTIVATION_STARTED=1

  case "${DEPLOYMENT_TRANSACTION_PHASE}" in
    runtime-bootstrap|runtime-final)
      echo "[installer] resuming transaction ${TRANSACTION_ID} at ${DEPLOYMENT_TRANSACTION_PHASE}"
      run_runtime_gates
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
      run_runtime_gates
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
  ensure_server_env_key "HBU_JW_CREDENTIAL_KEK_PATH" "${SHARED_DIR}/hbu-jw/credential-kek.key"
  ensure_server_env_key "CHAOXING_CREDENTIAL_KEK_PATH" "${SHARED_DIR}/chaoxing/credential-kek.key"
  ensure_server_env_key "CAMPUS_AUTH_CREDENTIAL_KEK_PATH" "${SHARED_DIR}/campus-auth/credential-kek.key"
  ensure_server_env_key "GENSHIN_PUBLIC_BASE_URL" "https://genshin.kkkzbh.cn"
  ensure_server_env_key "GENSHIN_BIND_PAGE_PATH" "/genshin/bind"
  ensure_server_env_key "GENSHIN_BIND_TOKEN_TTL_MS" "600000"
  ensure_server_env_key "GENSHIN_CREDENTIAL_KEK_PATH" "${DATA_DIR}/genshin-credential-kek"
  ensure_server_env_key "GENSHIN_AUTO_SIGN_ENABLED" "true"
  ensure_server_env_key "GENSHIN_AUTO_SIGN_CRON" '"10 9 * * *"'
  ensure_server_env_key "GENSHIN_TIMEZONE" "Asia/Shanghai"
  ensure_server_env_key "GENSHIN_TAKUMI_APP_VERSION" "2.70.1"
  ensure_server_env_key "GENSHIN_SIGN_ACT_ID" "e202311201442471"
  ensure_server_env_key "HBU_JW_WEBVPN_BROKER_URL" "http://127.0.0.1:8789"
  local file
  for file in "${ENV_SERVER}" "${ENV_RUNTIME}"; do
    remove_env_key "${file}" "GENSHIN_REDEEM_GAME_VERSION"
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
    remove_env_key "${file}" "MEMORY_EMBED_BATCH_SIZE"
    remove_env_key "${file}" "MEMORY_QUERY_TOPK"
    remove_env_key "${file}" "MEMORY_PROMPT_BUDGET_TOKENS"
  done
  chown root:qqbot "${ENV_SERVER}"
  chmod 640 "${ENV_SERVER}"
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
require_bundle_entry "qqbot/dist/tools/model-config-v3-cutover.mjs"
require_bundle_entry "qqbot/dist/tools/model-auth-connection-cutover.mjs"
require_bundle_entry "qqbot/dist/tools/natural-trigger-cutover.mjs"
require_bundle_entry "qqbot/dist/tools/memory-v3-cutover.mjs"
require_bundle_entry "qqbot/dist/tools/memory-evaluation.mjs"
require_bundle_entry "qqbot/dist/tools/memory-evaluation-adapter.mjs"
require_bundle_entry "qqbot/data/chathub/context-presets"
require_bundle_entry "qqbot/data/chathub/role-presets"
require_bundle_catalog "qqbot/data/chathub/context-presets"
require_bundle_catalog "qqbot/data/chathub/role-presets"
require_bundle_entry "qqbot/deploy/deployment-transaction.sh"
require_bundle_entry "qqbot/deploy/render-systemd.mjs"
require_bundle_entry "qqbot/scripts/stop-agent-workspace-containers.sh"
require_bundle_entry "qqbot/scripts/verify-memory-v3-readiness.mjs"
require_bundle_entry "qqbot/scripts/wait-pmhq-login-network.sh"
require_bundle_entry "qqbot/scripts/migrate-agent-workspace-podman.mjs"
require_bundle_entry "qqbot/docker/agent-workspace/Dockerfile"
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
    QQBOT_NATURAL_TRIGGER_CONFIG_PATH
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
  printf '%s\n' "QQBOT_NATURAL_TRIGGER_CONFIG_PATH=${DATA_DIR}/natural-trigger.json" >> "${tmp}"
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
  chown root:qqbot "${ENV_RUNTIME}"
  chmod 640 "${ENV_RUNTIME}"
}
write_runtime_env

prepare_koishi_kek_ownership() {
  (
    set -a
    # shellcheck disable=SC1090
    . "${ENV_SERVER}"
    # shellcheck disable=SC1090
    . "${ENV_RUNTIME}"
    set +a

    local variable
    local configured_path
    local resolved_path
    local parent_dir
    for variable in \
      QQBOT_MODEL_CONFIG_KEK_PATH \
      HBU_JW_CREDENTIAL_KEK_PATH \
      CHAOXING_CREDENTIAL_KEK_PATH \
      CAMPUS_AUTH_CREDENTIAL_KEK_PATH \
      GENSHIN_CREDENTIAL_KEK_PATH; do
      configured_path="${!variable:-}"
      if [[ -z "${configured_path}" || "${configured_path}" != /* ]]; then
        echo "[installer] ${variable} must be an absolute managed path" >&2
        exit 2
      fi
      resolved_path="$(realpath -m -- "${configured_path}")"
      if [[ "${resolved_path}" != "${configured_path}" ]]; then
        echo "[installer] ${variable} must be normalized: ${configured_path}" >&2
        exit 2
      fi
      case "${resolved_path}" in
        "${DATA_DIR}/"*|"${SHARED_DIR}/"*) ;;
        *) echo "[installer] ${variable} is outside the managed runtime roots" >&2; exit 2 ;;
      esac

      parent_dir="$(dirname -- "${resolved_path}")"
      if [[ "${parent_dir}" != "${SHARED_DIR}" ]]; then
        install -d -o qqbot -g qqbot -m 700 "${parent_dir}"
      fi
      if [[ -e "${resolved_path}" || -L "${resolved_path}" ]]; then
        if [[ ! -f "${resolved_path}" || -L "${resolved_path}" ]]; then
          echo "[installer] ${variable} must name a regular file" >&2
          exit 2
        fi
        chown qqbot:qqbot "${resolved_path}"
        chmod 600 "${resolved_path}"
      elif [[ "${variable}" == "QQBOT_MODEL_CONFIG_KEK_PATH" ]]; then
        echo "[installer] model config KEK is missing: ${resolved_path}" >&2
        exit 2
      fi
    done
  )
}

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

MODEL_CONFIG_V3_CUTOVER_REQUIRED=0
MODEL_CONFIG_V3_REPORT="${TRANSACTION_BACKUP_DIR}/model-config-v3-preflight.json"
if [[ -f "${DATA_DIR}/model-config.json" && -f "${SHARED_DIR}/model-config.kek" ]]; then
  MODEL_CONFIG_SCHEMA_VERSION="$(
    node -e '
      const fs = require("node:fs");
      const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      if (!Number.isSafeInteger(value.schemaVersion)) process.exit(2);
      process.stdout.write(String(value.schemaVersion));
    ' "${DATA_DIR}/model-config.json"
  )"
  if [[ "${MODEL_CONFIG_SCHEMA_VERSION}" == "2" ]]; then
    MODEL_CONFIG_V3_CUTOVER_REQUIRED=1
    node "${STAGE_QQBOT}/dist/tools/model-config-v3-cutover.mjs" preflight \
      --config "${DATA_DIR}/model-config.json" \
      --report "${MODEL_CONFIG_V3_REPORT}"
  elif [[ "${MODEL_CONFIG_SCHEMA_VERSION}" == "3" ]]; then
    node -e '
      const { pathToFileURL } = require("node:url");
      const fs = require("node:fs");
      (async () => {
        const schema = await import(pathToFileURL(process.argv[2]).href);
        schema.modelConfigDocumentSchema.parse(JSON.parse(fs.readFileSync(process.argv[1], "utf8")));
      })().catch((error) => {
        console.error(error);
        process.exit(1);
      });
    ' "${DATA_DIR}/model-config.json" "${STAGE_QQBOT}/dist/plugins/model-config/types.js"
  else
    echo "[installer] unsupported model config schema: ${MODEL_CONFIG_SCHEMA_VERSION}" >&2
    exit 2
  fi
elif [[ -e "${DATA_DIR}/model-config.json" || -e "${SHARED_DIR}/model-config.kek" ]]; then
  echo "[installer] canonical model config and KEK must either both exist or both be absent" >&2
  exit 2
else
  echo "[installer] Model Config V2 or V3 and its KEK are required" >&2
  exit 2
fi

NATURAL_TRIGGER_CUTOVER_REPORT="${TRANSACTION_BACKUP_DIR}/natural-trigger-preflight.json"
node "${STAGE_QQBOT}/dist/tools/natural-trigger-cutover.mjs" preflight \
  --env "${ENV_SERVER}" \
  --override-env "${ENV_RUNTIME}" \
  --database "${DATA_DIR}/koishi.db" \
  --config "${DATA_DIR}/natural-trigger.json" \
  --report "${NATURAL_TRIGGER_CUTOVER_REPORT}"

MEMORY_V3_CUTOVER_REQUIRED=0
MEMORY_V3_INITIALIZE_REQUIRED=0
MEMORY_V3_PREFLIGHT_REPORT="${TRANSACTION_BACKUP_DIR}/memory-v3-preflight.json"
if [[ -f "${DATA_DIR}/koishi.db" ]]; then
  MEMORY_SCHEMA_STATE="$(
    node -e '
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(process.argv[1], { readOnly: true });
      const rows = db.prepare(
        "SELECT name FROM sqlite_master WHERE type = '\''table'\'' AND name LIKE '\''memory\\_%'\'' ESCAPE '\''\\'\''"
      ).all();
      db.close();
      const names = rows.map((row) => row.name);
      const hasV2 = names.some((name) => name.startsWith("memory_v2_"));
      const hasV3 = names.some((name) => name.startsWith("memory_v3_"));
      if (hasV2 && hasV3) process.exit(2);
      process.stdout.write(hasV2 ? "v2" : hasV3 ? "v3" : "empty");
    ' "${DATA_DIR}/koishi.db"
  )"
  if [[ "${MEMORY_SCHEMA_STATE}" == "v2" ]]; then
    MEMORY_V3_CUTOVER_REQUIRED=1
    node "${STAGE_QQBOT}/dist/tools/memory-v3-cutover.mjs" preflight \
      --database "${DATA_DIR}/koishi.db" \
      --report "${MEMORY_V3_PREFLIGHT_REPORT}"
  elif [[ "${MEMORY_SCHEMA_STATE}" == "empty" ]]; then
    MEMORY_V3_INITIALIZE_REQUIRED=1
  fi
else
  MEMORY_V3_INITIALIZE_REQUIRED=1
fi

ACTIVATION_STARTED=1
DEPLOYMENT_TRANSACTION_PURPOSE="ordinary"
if [[ "${MEMORY_V3_CUTOVER_REQUIRED}" == "1" ]]; then
  DEPLOYMENT_TRANSACTION_PURPOSE="memory-v3"
  sync -f "${MEMORY_V3_PREFLIGHT_REPORT}"
  sync -f "${TRANSACTION_BACKUP_DIR}"
fi
deployment_transaction_configure \
  "${DEPLOYMENT_TRANSACTION_STATE_FILE}" \
  "${TRANSACTION_ID}" \
  "${TRANSACTION_BACKUP_DIR}" \
  "${MEMORY_V3_PREFLIGHT_REPORT}" \
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
remove_agent_workspace_containers

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
deployment_transaction_snapshot_path "${TRANSACTION_PATHS_DIR}" "natural-trigger-config" "${DATA_DIR}/natural-trigger.json"
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
deployment_transaction_snapshot_path "${TRANSACTION_PATHS_DIR}" "journald-retention" "${JOURNALD_RETENTION_FILE}"
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
  QQBOT_JOURNALD_DROP_IN_DIR="${JOURNALD_DROP_IN_DIR}" \
  QQBOT_CLOUDFLARED_HBU_JW_TOKEN_FILE="${CLOUDFLARED_HBU_JW_TOKEN_FILE}" \
  QQBOT_CLOUDFLARED_GENSHIN_TOKEN_FILE="${CLOUDFLARED_GENSHIN_TOKEN_FILE}" \
  QQBOT_HBU_WEBVPN_BROKER_CREDENTIAL="${HBU_WEBVPN_BROKER_CREDENTIAL}" \
    node "${STAGE_QQBOT}/deploy/render-systemd.mjs"
)
systemctl daemon-reload
systemctl restart systemd-journald.service
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
if [[ "${MODEL_CONFIG_V3_CUTOVER_REQUIRED}" == "1" ]]; then
  node "${STAGE_QQBOT}/dist/tools/model-config-v3-cutover.mjs" apply \
    --config "${DATA_DIR}/model-config.json" \
    --report "${MODEL_CONFIG_V3_REPORT}"
fi
node "${STAGE_QQBOT}/dist/tools/natural-trigger-cutover.mjs" apply \
  --env "${ENV_SERVER}" \
  --override-env "${ENV_RUNTIME}" \
  --database "${DATA_DIR}/koishi.db" \
  --config "${DATA_DIR}/natural-trigger.json" \
  --report "${NATURAL_TRIGGER_CUTOVER_REPORT}" \
  --confirm-service-stopped
if [[ "${MEMORY_V3_INITIALIZE_REQUIRED}" == "1" ]]; then
  node "${STAGE_QQBOT}/dist/tools/memory-v3-cutover.mjs" initialize \
    --database "${DATA_DIR}/koishi.db"
  set_env_key "${ENV_SERVER}" "MEMORY_ENABLED" "true"
  set_env_key "${ENV_SERVER}" "MEMORY_MAINTENANCE" "false"
  set_env_key "${ENV_SERVER}" "MEMORY_READ_ENABLED" "true"
  set_env_key "${ENV_SERVER}" "MEMORY_WRITE_ENABLED" "false"
  remove_env_key "${ENV_RUNTIME}" "MEMORY_ENABLED"
  remove_env_key "${ENV_RUNTIME}" "MEMORY_MAINTENANCE"
  remove_env_key "${ENV_RUNTIME}" "MEMORY_READ_ENABLED"
  remove_env_key "${ENV_RUNTIME}" "MEMORY_WRITE_ENABLED"
fi
if [[ "${MEMORY_V3_CUTOVER_REQUIRED}" == "1" ]]; then
  node "${STAGE_QQBOT}/dist/tools/memory-v3-cutover.mjs" apply \
    --database "${DATA_DIR}/koishi.db" \
    --report "${MEMORY_V3_PREFLIGHT_REPORT}"
  set_env_key "${ENV_SERVER}" "MEMORY_ENABLED" "true"
  set_env_key "${ENV_SERVER}" "MEMORY_MAINTENANCE" "false"
  set_env_key "${ENV_SERVER}" "MEMORY_READ_ENABLED" "true"
  set_env_key "${ENV_SERVER}" "MEMORY_WRITE_ENABLED" "false"
  remove_env_key "${ENV_RUNTIME}" "MEMORY_ENABLED"
  remove_env_key "${ENV_RUNTIME}" "MEMORY_MAINTENANCE"
  remove_env_key "${ENV_RUNTIME}" "MEMORY_READ_ENABLED"
  remove_env_key "${ENV_RUNTIME}" "MEMORY_WRITE_ENABLED"
fi
node "${STAGE_QQBOT}/scripts/migrate-agent-workspace-podman.mjs" \
  "${PERSISTENT_AGENT_DIR}/config.json"
adopt_runtime_data_ownership
chgrp -R qqbot "${SHARED_DIR}"
find "${SHARED_DIR}" -type f -exec chmod g+r {} +
install -d -o qqbot -g qqbot -m 700 "${SHARED_DIR}/backup"
if [[ -f "${ENV_RUNTIME}" ]]; then
  chown qqbot:qqbot "${ENV_RUNTIME}"
  chmod 600 "${ENV_RUNTIME}"
fi
chown root:qqbot "${SHARED_DIR}"
chmod 1770 "${SHARED_DIR}"
prepare_model_auth_runtime_ownership
prepare_koishi_kek_ownership
deployment_transaction_fsync_tree "${WORK_DIR}"
deployment_transaction_swap_application \
  "${APP_ROOT}" \
  "${WORK_DIR}" \
  "${PREVIOUS_APP_ROOT}"
APP_SWAPPED=1
chmod 755 "${APP_ROOT}" "${APP_DIR}"
install -d -o qqbot -g qqbot -m 700 /run/qqbot
run_qqbot_podman info --format '{{.Host.Security.Rootless}}' | grep -qx true
run_qqbot_podman build \
  --tag localhost/qqbot-agent-workspace:latest \
  "${APP_DIR}/docker/agent-workspace"
if [[ "${ACTIVATION_MODE}" == "start" ]]; then
  deployment_transaction_transfer_runtime_ownership
  run_runtime_gates
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

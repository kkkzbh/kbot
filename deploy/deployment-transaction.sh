#!/usr/bin/env bash

# The systemd enablement state is the durable boot boundary:
# - qqbot.target stays disabled from the first offline mutation until every
#   runtime gate succeeds.
# - manual starts are still allowed while the installer validates the new
#   application/database pair.
# - the transaction record makes interrupted runtime gates resumable.

deployment_transaction_initialize() {
  DEPLOYMENT_TRANSACTION_PHASE="pre-activation"
  DEPLOYMENT_TRANSACTION_FAILURE_ACTION="none"
  DEPLOYMENT_TRANSACTION_CONFIGURED=0
  DEPLOYMENT_TRANSACTION_STATE_FILE=""
  DEPLOYMENT_TRANSACTION_ID=""
  DEPLOYMENT_TRANSACTION_BACKUP_DIR=""
  DEPLOYMENT_TRANSACTION_PREFLIGHT_REPORT=""
  DEPLOYMENT_TRANSACTION_VERIFY_SCOPE="full"
  DEPLOYMENT_TRANSACTION_PURPOSE="ordinary"
  DEPLOYMENT_TRANSACTION_ACTIVATION_MODE="start"
  DEPLOYMENT_TRANSACTION_SNAPSHOT_COMPLETE=0
  DEPLOYMENT_TRANSACTION_APP_SWAPPED=0
  DEPLOYMENT_TRANSACTION_APP_PREVIOUS_EXISTED=0
}

deployment_transaction_assert_field() {
  local name="$1"
  local value="$2"
  if [[ -z "${value}" || "${value}" == *$'\n'* || "${value}" == *$'\t'* ]]; then
    echo "[installer] invalid deployment transaction ${name}" >&2
    return 1
  fi
}

deployment_transaction_configure() {
  local state_file="$1"
  local transaction_id="$2"
  local backup_dir="$3"
  local preflight_report="$4"
  local verify_scope="$5"
  local purpose="$6"
  local activation_mode="$7"

  deployment_transaction_assert_field "state file" "${state_file}"
  deployment_transaction_assert_field "id" "${transaction_id}"
  deployment_transaction_assert_field "backup directory" "${backup_dir}"
  deployment_transaction_assert_field "preflight report" "${preflight_report:-none}"
  case "${verify_scope}" in
    koishi|full) ;;
    *) echo "[installer] invalid deployment transaction verify scope: ${verify_scope}" >&2; return 1 ;;
  esac
  case "${purpose}" in
    ordinary|memory-v3) ;;
    *) echo "[installer] invalid deployment transaction purpose: ${purpose}" >&2; return 1 ;;
  esac
  case "${activation_mode}" in
    start|keep-stopped) ;;
    *) echo "[installer] invalid deployment transaction activation mode: ${activation_mode}" >&2; return 1 ;;
  esac

  DEPLOYMENT_TRANSACTION_STATE_FILE="${state_file}"
  DEPLOYMENT_TRANSACTION_ID="${transaction_id}"
  DEPLOYMENT_TRANSACTION_BACKUP_DIR="${backup_dir}"
  DEPLOYMENT_TRANSACTION_PREFLIGHT_REPORT="${preflight_report}"
  DEPLOYMENT_TRANSACTION_VERIFY_SCOPE="${verify_scope}"
  DEPLOYMENT_TRANSACTION_PURPOSE="${purpose}"
  DEPLOYMENT_TRANSACTION_ACTIVATION_MODE="${activation_mode}"
  DEPLOYMENT_TRANSACTION_CONFIGURED=1
}

deployment_transaction_persist() {
  if [[ "${DEPLOYMENT_TRANSACTION_CONFIGURED:-0}" != "1" ]]; then
    return 0
  fi
  local state_file="${DEPLOYMENT_TRANSACTION_STATE_FILE}"
  local state_dir
  local state_tmp
  state_dir="$(dirname "${state_file}")"
  mkdir -p "${state_dir}" || return 1
  state_tmp="$(mktemp "${state_file}.tmp.XXXXXX")" || return 1
  chmod 600 "${state_tmp}" || return 1
  {
    printf 'schemaVersion\t1\n'
    printf 'transactionId\t%s\n' "${DEPLOYMENT_TRANSACTION_ID}"
    printf 'phase\t%s\n' "${DEPLOYMENT_TRANSACTION_PHASE}"
    printf 'backupDir\t%s\n' "${DEPLOYMENT_TRANSACTION_BACKUP_DIR}"
    printf 'preflightReport\t%s\n' "${DEPLOYMENT_TRANSACTION_PREFLIGHT_REPORT}"
    printf 'verifyScope\t%s\n' "${DEPLOYMENT_TRANSACTION_VERIFY_SCOPE}"
    printf 'purpose\t%s\n' "${DEPLOYMENT_TRANSACTION_PURPOSE}"
    printf 'activationMode\t%s\n' "${DEPLOYMENT_TRANSACTION_ACTIVATION_MODE}"
    printf 'snapshotComplete\t%s\n' "${DEPLOYMENT_TRANSACTION_SNAPSHOT_COMPLETE}"
    printf 'appSwapped\t%s\n' "${DEPLOYMENT_TRANSACTION_APP_SWAPPED}"
    printf 'appPreviousExisted\t%s\n' "${DEPLOYMENT_TRANSACTION_APP_PREVIOUS_EXISTED}"
  } > "${state_tmp}" || return 1
  sync -f "${state_tmp}" || return 1
  mv "${state_tmp}" "${state_file}" || return 1
  sync -f "${state_dir}" || return 1
}

deployment_transaction_load_existing() {
  local state_file="$1"
  if [[ ! -e "${state_file}" ]]; then
    return 1
  fi
  if [[ -L "${state_file}" || ! -f "${state_file}" ]]; then
    echo "[installer] deployment transaction state must be a regular file: ${state_file}" >&2
    return 2
  fi

  local schema_version=""
  local transaction_id=""
  local phase=""
  local backup_dir=""
  local preflight_report=""
  local verify_scope=""
  local purpose=""
  local activation_mode=""
  local snapshot_complete=""
  local app_swapped=""
  local app_previous_existed=""
  local key value extra
  local seen=" "
  while IFS=$'\t' read -r key value extra || [[ -n "${key:-}" ]]; do
    if [[ -n "${extra:-}" || " ${seen} " == *" ${key} "* ]]; then
      echo "[installer] malformed deployment transaction state: ${state_file}" >&2
      return 2
    fi
    seen+="${key} "
    case "${key}" in
      schemaVersion) schema_version="${value}" ;;
      transactionId) transaction_id="${value}" ;;
      phase) phase="${value}" ;;
      backupDir) backup_dir="${value}" ;;
      preflightReport) preflight_report="${value}" ;;
      verifyScope) verify_scope="${value}" ;;
      purpose) purpose="${value}" ;;
      activationMode) activation_mode="${value}" ;;
      snapshotComplete) snapshot_complete="${value}" ;;
      appSwapped) app_swapped="${value}" ;;
      appPreviousExisted) app_previous_existed="${value}" ;;
      *) echo "[installer] unknown deployment transaction state field: ${key}" >&2; return 2 ;;
    esac
  done < "${state_file}"

  if [[ "${schema_version}" != "1" ]]; then
    echo "[installer] unsupported deployment transaction schema: ${schema_version:-missing}" >&2
    return 2
  fi
  case "${phase}" in
    offline-inhibited|offline-snapshot-ready|app-swap-intent|app-previous-moved|offline-app-swapped|installed-stopped|offline-restore-verification|runtime-bootstrap|runtime-final) ;;
    *) echo "[installer] invalid persisted deployment phase: ${phase:-missing}" >&2; return 2 ;;
  esac
  case "${snapshot_complete}" in 0|1) ;; *) return 2 ;; esac
  case "${app_swapped}" in 0|1) ;; *) return 2 ;; esac
  case "${app_previous_existed}" in 0|1) ;; *) return 2 ;; esac

  deployment_transaction_initialize
  deployment_transaction_configure \
    "${state_file}" \
    "${transaction_id}" \
    "${backup_dir}" \
    "${preflight_report}" \
    "${verify_scope}" \
    "${purpose}" \
    "${activation_mode}"
  DEPLOYMENT_TRANSACTION_PHASE="${phase}"
  DEPLOYMENT_TRANSACTION_SNAPSHOT_COMPLETE="${snapshot_complete}"
  DEPLOYMENT_TRANSACTION_APP_SWAPPED="${app_swapped}"
  DEPLOYMENT_TRANSACTION_APP_PREVIOUS_EXISTED="${app_previous_existed}"
  return 0
}

deployment_transaction_begin_offline_activation() {
  local inhibit_boot_callback="${1:-}"
  local verify_inhibited_callback="${2:-}"
  if [[ "${DEPLOYMENT_TRANSACTION_PHASE:-}" != "pre-activation" ]]; then
    echo "[installer] invalid deployment transaction transition: ${DEPLOYMENT_TRANSACTION_PHASE:-unset} -> offline-inhibited" >&2
    return 1
  fi
  if [[ -n "${inhibit_boot_callback}" ]]; then
    "${inhibit_boot_callback}"
  fi
  if [[ -n "${verify_inhibited_callback}" ]]; then
    "${verify_inhibited_callback}"
  fi
  DEPLOYMENT_TRANSACTION_PHASE="offline-inhibited"
  deployment_transaction_persist
}

deployment_transaction_set_previous_app_existed() {
  local previous_existed="$1"
  if [[ "${DEPLOYMENT_TRANSACTION_PHASE:-}" != "pre-activation" ]]; then
    echo "[installer] previous app ownership must be recorded before activation" >&2
    return 1
  fi
  case "${previous_existed}" in 0|1) ;; *) return 1 ;; esac
  DEPLOYMENT_TRANSACTION_APP_PREVIOUS_EXISTED="${previous_existed}"
}

deployment_transaction_mark_snapshot_complete() {
  case "${DEPLOYMENT_TRANSACTION_PHASE:-}" in
    offline-inhibited|offline-snapshot-ready) ;;
    *) echo "[installer] cannot mark snapshot complete in phase ${DEPLOYMENT_TRANSACTION_PHASE:-unset}" >&2; return 1 ;;
  esac
  DEPLOYMENT_TRANSACTION_SNAPSHOT_COMPLETE=1
  DEPLOYMENT_TRANSACTION_PHASE="offline-snapshot-ready"
  deployment_transaction_persist
}

deployment_transaction_mark_app_swap_intent() {
  if [[ "${DEPLOYMENT_TRANSACTION_PHASE:-}" != "offline-snapshot-ready" ]]; then
    echo "[installer] cannot begin application swap in phase ${DEPLOYMENT_TRANSACTION_PHASE:-unset}" >&2
    return 1
  fi
  DEPLOYMENT_TRANSACTION_PHASE="app-swap-intent"
  deployment_transaction_persist
}

deployment_transaction_mark_previous_app_moved() {
  if [[ "${DEPLOYMENT_TRANSACTION_PHASE:-}" != "app-swap-intent" ]]; then
    echo "[installer] cannot record previous application move in phase ${DEPLOYMENT_TRANSACTION_PHASE:-unset}" >&2
    return 1
  fi
  if [[ "${DEPLOYMENT_TRANSACTION_APP_PREVIOUS_EXISTED}" != "1" ]]; then
    echo "[installer] cannot move a previous application that did not exist" >&2
    return 1
  fi
  DEPLOYMENT_TRANSACTION_PHASE="app-previous-moved"
  deployment_transaction_persist
}

deployment_transaction_mark_app_swapped() {
  local previous_existed="$1"
  case "${DEPLOYMENT_TRANSACTION_PHASE:-}" in
    app-swap-intent|app-previous-moved) ;;
    *)
    echo "[installer] cannot mark application swap in phase ${DEPLOYMENT_TRANSACTION_PHASE:-unset}" >&2
    return 1
      ;;
  esac
  case "${previous_existed}" in 0|1) ;; *) return 1 ;; esac
  if [[ "${previous_existed}" != "${DEPLOYMENT_TRANSACTION_APP_PREVIOUS_EXISTED}" ]]; then
    echo "[installer] previous application ownership changed during swap" >&2
    return 1
  fi
  DEPLOYMENT_TRANSACTION_APP_SWAPPED=1
  DEPLOYMENT_TRANSACTION_APP_PREVIOUS_EXISTED="${previous_existed}"
  DEPLOYMENT_TRANSACTION_PHASE="offline-app-swapped"
  deployment_transaction_persist
}

deployment_transaction_fsync_tree() {
  local target="$1"
  if [[ -f "${target}" ]]; then
    sync -f "${target}" || return 1
    return
  fi
  if [[ ! -d "${target}" ]]; then
    return
  fi
  find "${target}" -type f -exec sync -f {} + || return 1
  find "${target}" -depth -type d -exec sync -f {} + || return 1
}

deployment_transaction_fsync_existing_parent() {
  local target="$1"
  local parent
  parent="$(dirname "${target}")"
  while [[ ! -d "${parent}" ]]; do
    if [[ "${parent}" == "/" || "${parent}" == "." ]]; then
      break
    fi
    parent="$(dirname "${parent}")"
  done
  sync -f "${parent}"
}

deployment_transaction_fsync_rename_parents() {
  local source="$1"
  local destination="$2"
  local source_parent
  local destination_parent
  source_parent="$(dirname "${source}")"
  destination_parent="$(dirname "${destination}")"
  sync -f "${source_parent}" || return 1
  if [[ "${destination_parent}" != "${source_parent}" ]]; then
    sync -f "${destination_parent}" || return 1
  fi
}

deployment_transaction_validate_sqlite_database() {
  local database="$1"
  python3 - "${database}" <<'PY'
import sqlite3
import sys

connection = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
try:
    result = connection.execute("PRAGMA integrity_check").fetchall()
finally:
    connection.close()
if result != [("ok",)]:
    raise SystemExit(f"SQLite integrity_check failed: {result!r}")
PY
}

deployment_transaction_remove_snapshot_target() {
  local target="$1"
  if [[ -d "${target}" && ! -L "${target}" ]]; then
    rm -r -- "${target}"
  elif [[ -e "${target}" || -L "${target}" ]]; then
    rm -f -- "${target}"
  fi
}

deployment_transaction_snapshot_path() {
  local paths_dir="$1"
  local key="$2"
  local target="$3"
  if [[ ! "${key}" =~ ^[a-z0-9-]+$ ]]; then
    echo "[installer] invalid transaction snapshot key: ${key}" >&2
    return 1
  fi

  local snapshot="${paths_dir}/${key}"
  local temporary
  if [[ -e "${snapshot}" || -L "${snapshot}" ]]; then
    echo "[installer] transaction snapshot already exists: ${snapshot}" >&2
    return 1
  fi

  mkdir -p "${paths_dir}" || return 1
  sync -f "$(dirname "${paths_dir}")" || return 1
  temporary="$(mktemp -d "${paths_dir}/.${key}.tmp.XXXXXX")" || return 1
  chmod 700 "${temporary}" || return 1
  if [[ -e "${target}" || -L "${target}" ]]; then
    cp -a -- "${target}" "${temporary}/value" || return 1
    deployment_transaction_fsync_tree "${temporary}/value" || return 1
    touch "${temporary}/present" || return 1
    sync -f "${temporary}/present" || return 1
  else
    touch "${temporary}/absent" || return 1
    sync -f "${temporary}/absent" || return 1
  fi
  sync -f "${temporary}" || return 1
  mv "${temporary}" "${snapshot}" || return 1
  sync -f "${paths_dir}" || return 1
}

deployment_transaction_restore_snapshot_path() {
  local paths_dir="$1"
  local key="$2"
  local target="$3"
  local snapshot="${paths_dir}/${key}"
  if [[ -f "${snapshot}/present" ]]; then
    local parent
    local temporary
    parent="$(dirname "${target}")"
    mkdir -p "${parent}" || return 1
    sync -f "$(dirname "${parent}")" || return 1
    temporary="$(mktemp -d "${parent}/.qqbot-restore-${key}.XXXXXX")" || return 1
    chmod 700 "${temporary}" || return 1
    cp -a -- "${snapshot}/value" "${temporary}/value" || return 1
    deployment_transaction_fsync_tree "${temporary}/value" || return 1
    sync -f "${temporary}" || return 1
    deployment_transaction_remove_snapshot_target "${target}" || return 1
    mv "${temporary}/value" "${target}" || return 1
    sync -f "${parent}" || return 1
    rmdir "${temporary}" || return 1
    sync -f "${parent}" || return 1
    return
  fi
  if [[ -f "${snapshot}/absent" ]]; then
    deployment_transaction_remove_snapshot_target "${target}" || return 1
    deployment_transaction_fsync_existing_parent "${target}" || return 1
    return
  fi
  echo "[installer] transaction snapshot is missing: ${key}" >&2
  return 1
}

deployment_transaction_snapshot_database() {
  local paths_dir="$1"
  local target="$2"
  local snapshot="${paths_dir}/database"
  local temporary
  if [[ -e "${snapshot}" || -L "${snapshot}" ]]; then
    echo "[installer] transaction database snapshot already exists: ${snapshot}" >&2
    return 1
  fi

  mkdir -p "${paths_dir}" || return 1
  sync -f "$(dirname "${paths_dir}")" || return 1
  temporary="$(mktemp -d "${paths_dir}/.database.tmp.XXXXXX")" || return 1
  chmod 700 "${temporary}" || return 1
  if [[ -f "${target}" ]]; then
    if ! python3 - "${target}" "${temporary}/koishi.db" <<'PY'
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
    then
      return 1
    fi
    chmod 600 "${temporary}/koishi.db" || return 1
    deployment_transaction_validate_sqlite_database "${temporary}/koishi.db" || return 1
    sync -f "${temporary}/koishi.db" || return 1
    touch "${temporary}/present" || return 1
    sync -f "${temporary}/present" || return 1
  elif [[ -e "${target}" || -L "${target}" ]]; then
    echo "[installer] SQLite path must be a regular file: ${target}" >&2
    return 1
  else
    touch "${temporary}/absent" || return 1
    sync -f "${temporary}/absent" || return 1
  fi
  sync -f "${temporary}" || return 1
  mv "${temporary}" "${snapshot}" || return 1
  sync -f "${paths_dir}" || return 1
}

deployment_transaction_restore_database_snapshot() {
  local paths_dir="$1"
  local target="$2"
  local snapshot="${paths_dir}/database"
  local target_dir
  target_dir="$(dirname "${target}")"
  mkdir -p "${target_dir}" || return 1
  sync -f "$(dirname "${target_dir}")" || return 1

  if [[ -f "${snapshot}/present" ]]; then
    local temporary
    deployment_transaction_validate_sqlite_database "${snapshot}/koishi.db" || return 1
    temporary="$(mktemp "${target_dir}/.koishi.db.restore.XXXXXX")" || return 1
    cp --preserve=mode,timestamps -- "${snapshot}/koishi.db" "${temporary}" || return 1
    chmod 600 "${temporary}" || return 1
    deployment_transaction_validate_sqlite_database "${temporary}" || return 1
    sync -f "${temporary}" || return 1
    deployment_transaction_remove_snapshot_target "${target}" || return 1
    deployment_transaction_remove_snapshot_target "${target}-wal" || return 1
    deployment_transaction_remove_snapshot_target "${target}-shm" || return 1
    mv "${temporary}" "${target}" || return 1
    sync -f "${target_dir}" || return 1
    deployment_transaction_validate_sqlite_database "${target}" || return 1
  elif [[ ! -f "${snapshot}/absent" ]]; then
    echo "[installer] transaction database snapshot is missing" >&2
    return 1
  else
    deployment_transaction_remove_snapshot_target "${target}" || return 1
    deployment_transaction_remove_snapshot_target "${target}-wal" || return 1
    deployment_transaction_remove_snapshot_target "${target}-shm" || return 1
    sync -f "${target_dir}" || return 1
  fi
}

deployment_transaction_swap_application() {
  local app_root="$1"
  local work_root="$2"
  local previous_app_root="$3"
  if [[ ! -e "${work_root}" && ! -L "${work_root}" ]]; then
    echo "[installer] staged application is missing before swap: ${work_root}" >&2
    return 1
  fi
  if [[ -e "${previous_app_root}" || -L "${previous_app_root}" ]]; then
    echo "[installer] previous application destination already exists: ${previous_app_root}" >&2
    return 1
  fi
  if [[ "${DEPLOYMENT_TRANSACTION_APP_PREVIOUS_EXISTED}" == "1" ]]; then
    if [[ ! -e "${app_root}" && ! -L "${app_root}" ]]; then
      echo "[installer] recorded previous application is missing before swap: ${app_root}" >&2
      return 1
    fi
  elif [[ -e "${app_root}" || -L "${app_root}" ]]; then
    echo "[installer] unexpected application appeared before clean swap: ${app_root}" >&2
    return 1
  fi

  deployment_transaction_mark_app_swap_intent || return 1
  if [[ "${DEPLOYMENT_TRANSACTION_APP_PREVIOUS_EXISTED}" == "1" ]]; then
    mv "${app_root}" "${previous_app_root}" || return 1
    deployment_transaction_fsync_rename_parents "${app_root}" "${previous_app_root}" || return 1
    deployment_transaction_mark_previous_app_moved || return 1
  fi
  mv "${work_root}" "${app_root}" || return 1
  deployment_transaction_fsync_rename_parents "${work_root}" "${app_root}" || return 1
  deployment_transaction_mark_app_swapped "${DEPLOYMENT_TRANSACTION_APP_PREVIOUS_EXISTED}" || return 1
}

deployment_transaction_restore_application() {
  local app_root="$1"
  local previous_app_root="$2"
  local failed_new_app_root="$3"
  local app_present=0
  local previous_present=0
  local failed_present=0
  [[ -e "${app_root}" || -L "${app_root}" ]] && app_present=1
  [[ -e "${previous_app_root}" || -L "${previous_app_root}" ]] && previous_present=1
  [[ -e "${failed_new_app_root}" || -L "${failed_new_app_root}" ]] && failed_present=1

  case "${DEPLOYMENT_TRANSACTION_PHASE:-}" in
    offline-inhibited|offline-snapshot-ready)
      return 0
      ;;
    app-swap-intent)
      if [[ "${DEPLOYMENT_TRANSACTION_APP_PREVIOUS_EXISTED}" == "0" ]]; then
        if [[ "${previous_present}" != "0" ]]; then
          echo "[installer] unexpected previous app appeared during clean app swap" >&2
          return 1
        fi
        if [[ "${app_present}" == "1" ]]; then
          if [[ "${failed_present}" == "1" ]]; then
            echo "[installer] clean recovery has both active and failed-new app paths" >&2
            return 1
          fi
          mv "${app_root}" "${failed_new_app_root}" || return 1
          deployment_transaction_fsync_rename_parents "${app_root}" "${failed_new_app_root}" || return 1
        fi
        return 0
      fi
      if [[ "${app_present}" == "1" && "${previous_present}" == "0" ]]; then
        return 0
      fi
      if [[ "${app_present}" == "0" && "${previous_present}" == "1" ]]; then
        mv "${previous_app_root}" "${app_root}" || return 1
        deployment_transaction_fsync_rename_parents "${previous_app_root}" "${app_root}" || return 1
        return 0
      fi
      echo "[installer] app-swap intent paths are ambiguous during recovery" >&2
      return 1
      ;;
    app-previous-moved|offline-app-swapped)
      if [[ "${DEPLOYMENT_TRANSACTION_APP_PREVIOUS_EXISTED}" == "0" ]]; then
        if [[ "${previous_present}" != "0" ]]; then
          echo "[installer] unexpected previous app exists during clean recovery" >&2
          return 1
        fi
        if [[ "${app_present}" == "1" ]]; then
          if [[ "${failed_present}" == "1" ]]; then
            echo "[installer] clean recovery has both active and failed-new app paths" >&2
            return 1
          fi
          mv "${app_root}" "${failed_new_app_root}" || return 1
          deployment_transaction_fsync_rename_parents "${app_root}" "${failed_new_app_root}" || return 1
        fi
        return 0
      fi

      if [[ "${previous_present}" == "1" && "${app_present}" == "1" ]]; then
        if [[ "${failed_present}" == "1" ]]; then
          echo "[installer] failed-new-app destination already exists before app restore: ${failed_new_app_root}" >&2
          return 1
        fi
        mv "${app_root}" "${failed_new_app_root}" || return 1
        deployment_transaction_fsync_rename_parents "${app_root}" "${failed_new_app_root}" || return 1
        app_present=0
        failed_present=1
      fi
      if [[ "${previous_present}" == "1" && "${app_present}" == "0" ]]; then
        mv "${previous_app_root}" "${app_root}" || return 1
        deployment_transaction_fsync_rename_parents "${previous_app_root}" "${app_root}" || return 1
        return 0
      fi
      if [[ "${previous_present}" == "0" && "${app_present}" == "1" && "${failed_present}" == "1" ]]; then
        return 0
      fi
      echo "[installer] application paths are incomplete during transaction recovery" >&2
      return 1
      ;;
    offline-restore-verification)
      return 0
      ;;
    *)
      echo "[installer] cannot restore application in phase ${DEPLOYMENT_TRANSACTION_PHASE:-unset}" >&2
      return 1
      ;;
  esac
}

deployment_transaction_mark_installed_stopped() {
  if [[ "${DEPLOYMENT_TRANSACTION_PHASE:-}" != "offline-app-swapped" ]]; then
    echo "[installer] cannot retain stopped installation in phase ${DEPLOYMENT_TRANSACTION_PHASE:-unset}" >&2
    return 1
  fi
  DEPLOYMENT_TRANSACTION_PHASE="installed-stopped"
  deployment_transaction_persist
}

deployment_transaction_transfer_runtime_ownership() {
  case "${DEPLOYMENT_TRANSACTION_PHASE:-}" in
    offline-app-swapped|installed-stopped) ;;
    *) echo "[installer] invalid deployment transaction transition: ${DEPLOYMENT_TRANSACTION_PHASE:-unset} -> runtime-bootstrap" >&2; return 1 ;;
  esac
  DEPLOYMENT_TRANSACTION_PHASE="runtime-bootstrap"
  deployment_transaction_persist
}

deployment_transaction_mark_runtime_phase() {
  local next_phase="$1"
  case "${DEPLOYMENT_TRANSACTION_PHASE:-}:${next_phase}" in
    runtime-bootstrap:runtime-final|runtime-final:runtime-final) ;;
    *) echo "[installer] invalid deployment transaction runtime transition: ${DEPLOYMENT_TRANSACTION_PHASE:-unset} -> ${next_phase}" >&2; return 1 ;;
  esac
  DEPLOYMENT_TRANSACTION_PHASE="${next_phase}"
  deployment_transaction_persist
}

deployment_transaction_mark_restore_verification() {
  case "${DEPLOYMENT_TRANSACTION_PHASE:-}" in
    offline-inhibited|offline-snapshot-ready|app-swap-intent|app-previous-moved|offline-app-swapped|offline-restore-verification) ;;
    *) echo "[installer] cannot verify restored deployment from phase ${DEPLOYMENT_TRANSACTION_PHASE:-unset}" >&2; return 1 ;;
  esac
  DEPLOYMENT_TRANSACTION_PHASE="offline-restore-verification"
  deployment_transaction_persist
}

deployment_transaction_complete() {
  if [[ "${DEPLOYMENT_TRANSACTION_CONFIGURED:-0}" == "1" ]]; then
    local state_dir
    state_dir="$(dirname "${DEPLOYMENT_TRANSACTION_STATE_FILE}")"
    rm -f -- "${DEPLOYMENT_TRANSACTION_STATE_FILE}" || return 1
    sync -f "${state_dir}" || return 1
  fi
  DEPLOYMENT_TRANSACTION_PHASE="complete"
}

deployment_transaction_complete_after_boot_verification() {
  local enable_and_verify_callback="$1"
  case "${DEPLOYMENT_TRANSACTION_PHASE:-}" in
    offline-restore-verification|runtime-final) ;;
    *)
      echo "[installer] cannot publish boot ownership in phase ${DEPLOYMENT_TRANSACTION_PHASE:-unset}" >&2
      return 1
      ;;
  esac
  if ! "${enable_and_verify_callback}"; then
    return 1
  fi
  deployment_transaction_complete
}

deployment_transaction_execute_activated_failure() {
  local stop_stack_callback="$1"
  local restore_offline_callback="$2"

  case "${DEPLOYMENT_TRANSACTION_PHASE:-}" in
    offline-inhibited|offline-snapshot-ready|app-swap-intent|app-previous-moved|offline-app-swapped|offline-restore-verification)
      DEPLOYMENT_TRANSACTION_FAILURE_ACTION="restore-offline-snapshot"
      if ! "${stop_stack_callback}"; then
        return 1
      fi
      "${restore_offline_callback}"
      ;;
    installed-stopped)
      DEPLOYMENT_TRANSACTION_FAILURE_ACTION="keep-installed-stopped"
      "${stop_stack_callback}"
      ;;
    runtime-bootstrap|runtime-final)
      DEPLOYMENT_TRANSACTION_FAILURE_ACTION="stop-and-roll-forward"
      "${stop_stack_callback}"
      ;;
    *)
      echo "[installer] activated failure has invalid transaction phase: ${DEPLOYMENT_TRANSACTION_PHASE:-unset}" >&2
      return 1
      ;;
  esac
}

deployment_transaction_initialize

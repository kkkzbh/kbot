#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF' >&2
Usage:
  install-release.sh prepare <qqbot-release.tar.gz>
  install-release.sh activate <release-id>
  install-release.sh verify <koishi|full> [release-id]

Environment:
  DEPLOY_APP_DIR           Current symlink path (default: /opt/qqbot/current)
  QQBOT_SHARED_DIR         Persistent shared state dir (default: /opt/qqbot/shared)
  DEPLOY_SYSTEMD_TARGET    Systemd target to restart (default: qqbot.target)
  QQBOT_DEPLOY_SCOPE       Activation prerequisite/restart scope: koishi|full (default: koishi)
EOF
}

if [[ "$#" -lt 1 ]]; then
  usage
  exit 2
fi

COMMAND="$1"
shift

CURRENT_LINK="${DEPLOY_APP_DIR:-/opt/qqbot/current}"
CURRENT_PARENT="$(dirname "${CURRENT_LINK}")"
mkdir -p "${CURRENT_PARENT}"
BASE_DIR="$(cd -- "${CURRENT_PARENT}" && pwd)"
SHARED_DIR="${QQBOT_SHARED_DIR:-${BASE_DIR}/shared}"
RELEASES_DIR="${BASE_DIR}/releases"
SYSTEMD_TARGET="${DEPLOY_SYSTEMD_TARGET:-qqbot.target}"
DEPLOY_SCOPE="${QQBOT_DEPLOY_SCOPE:-koishi}"

case "${DEPLOY_SCOPE}" in
  koishi|full) ;;
  *)
    echo "[deploy] invalid QQBOT_DEPLOY_SCOPE: ${DEPLOY_SCOPE}" >&2
    exit 2
    ;;
esac

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[deploy] missing command: $1" >&2
    exit 2
  fi
}

require_cmd node

release_id_from_manifest_json() {
  node -e "
    const m = JSON.parse(process.argv[1]);
    const qqbotSha = String(m.qqbot?.sha || 'unknown');
    const createdAt = String(m.artifact?.createdAt || new Date().toISOString());
    const stamp = createdAt.replace(/[^0-9T]/g, '').slice(0, 15);
    let shortSha = qqbotSha.slice(0, 12);
    if (!/^[0-9a-fA-F]{7,12}$/.test(shortSha)) shortSha = 'unknown';
    process.stdout.write(`${stamp}-${shortSha}`);
  " "$1"
}

read_bundle_manifest_json() {
  local bundle_path="$1"
  require_cmd tar
  tar -xOf "${bundle_path}" build-manifest.json
}

validate_release_id() {
  local release_id="$1"
  if [[ ! "${release_id}" =~ ^[0-9T]{8,15}-([0-9a-fA-F]{7,12}|unknown)$ ]]; then
    echo "[deploy] invalid release id: ${release_id}" >&2
    exit 2
  fi
}

write_prepared_marker() {
  local marker_path="$1"
  local manifest_json="$2"
  local release_id="$3"
  local temp_file
  temp_file="$(mktemp)"

  node - "${temp_file}" "${release_id}" "${DEPLOY_SCOPE}" "${manifest_json}" <<'NODE'
const fs = require('node:fs');

const [, , targetPath, releaseId, deployScope, manifestJson] = process.argv;
const manifest = JSON.parse(manifestJson);
const prepared = {
  releaseId,
  deployScope,
  preparedAt: new Date().toISOString(),
  qqbot: manifest.qqbot ?? {},
  chatluna: manifest.chatluna ?? {},
  artifact: manifest.artifact ?? {},
  contract: {
    buildArtifactsGeneratedByCi: true,
    activationRequiresPreparedMarker: true,
  },
};
fs.writeFileSync(targetPath, `${JSON.stringify(prepared, null, 2)}\n`, 'utf8');
NODE

  mv "${temp_file}" "${marker_path}"
  chmod 600 "${marker_path}"
}

prepare_release() {
  if [[ "$#" -ne 1 ]]; then
    usage
    exit 2
  fi

  local bundle_path="$1"
  if [[ ! -f "${bundle_path}" ]]; then
    echo "[deploy] release bundle not found: ${bundle_path}" >&2
    exit 2
  fi

  local manifest_json
  manifest_json="$(read_bundle_manifest_json "${bundle_path}")"

  local release_id
  release_id="$(release_id_from_manifest_json "${manifest_json}")"
  validate_release_id "${release_id}"

  local release_root="${RELEASES_DIR}/${release_id}"
  local app_dir="${release_root}/qqbot"
  local chatluna_dir="${release_root}/chatluna"
  local marker_path="${release_root}/.qqbot-release-prepared.json"

  if [[ -e "${CURRENT_LINK}" && ! -L "${CURRENT_LINK}" ]]; then
    echo "[deploy] DEPLOY_APP_DIR exists and is not a symlink: ${CURRENT_LINK}" >&2
    exit 2
  fi

  mkdir -p "${RELEASES_DIR}" "${SHARED_DIR}" "${SHARED_DIR}/presets" "${SHARED_DIR}/cache/yarn"
  chmod 700 "${SHARED_DIR}" "${SHARED_DIR}/presets" "${SHARED_DIR}/cache" "${SHARED_DIR}/cache/yarn"

  if [[ ! -f "${SHARED_DIR}/.env.server" ]]; then
    echo "[deploy] missing server env: ${SHARED_DIR}/.env.server" >&2
    exit 2
  fi
  chmod 600 "${SHARED_DIR}/.env.server"

  if [[ -f "${marker_path}" ]]; then
    echo "[deploy] release already prepared: ${release_root}"
    echo "QQBOT_RELEASE_ID=${release_id}"
    return 0
  fi

  if [[ -e "${release_root}" ]]; then
    echo "[deploy] release exists without prepared marker: ${release_root}" >&2
    exit 2
  fi

  mkdir -p "${release_root}"
  cleanup_release_on_error() {
    local code="$?"
    if [[ "${code}" -ne 0 && ! -f "${marker_path}" ]]; then
      rm -rf "${release_root}" >/dev/null 2>&1 || true
    fi
    exit "${code}"
  }
  trap cleanup_release_on_error EXIT

  tar -xzf "${bundle_path}" -C "${release_root}"

  if [[ ! -f "${app_dir}/package.json" ]]; then
    echo "[deploy] invalid release bundle: missing qqbot/package.json" >&2
    exit 2
  fi

  if [[ ! -d "${app_dir}/dist" ]]; then
    echo "[deploy] invalid release bundle: missing qqbot/dist; CI must build runtime artifacts before bundling" >&2
    exit 2
  fi

  if [[ ! -f "${chatluna_dir}/packages/core/package.json" ]]; then
    echo "[deploy] invalid release bundle: missing chatluna/packages/core/package.json" >&2
    exit 2
  fi

  source "${app_dir}/scripts/lib/chatluna-package-manager.sh"

  bash "${app_dir}/scripts/deploy/verify-host-prereqs.sh" "${DEPLOY_SCOPE}"
  node "${app_dir}/scripts/validate-server-voice-env.mjs" "${SHARED_DIR}/.env.server"

  QQBOT_SERVER_ENV_FILE="${SHARED_DIR}/.env.server" \
  DEPLOY_APP_DIR="${app_dir}" \
  QQBOT_SHARED_DIR="${SHARED_DIR}" \
    bash "${app_dir}/scripts/prepare-server-runtime-layer.sh"

  YARN_CACHE_FOLDER="${SHARED_DIR}/cache/yarn" chatluna_yarn_install_immutable "${chatluna_dir}"
  CHATLUNA_ROOT_DIR="${chatluna_dir}" bash "${app_dir}/scripts/ensure-chatluna-build.sh" --check

  (
    cd "${app_dir}"
    pnpm install --frozen-lockfile
    node ./scripts/verify-runtime-artifacts.mjs --config koishi.yml
  )

  QQBOT_DEPLOY_APP_DIR="${CURRENT_LINK}" \
  QQBOT_SHARED_DIR="${SHARED_DIR}" \
  QQBOT_SYSTEMD_TARGET="${SYSTEMD_TARGET}" \
  QQBOT_SYSTEMD_DIR="${release_root}/.systemd-prepare-check" \
    node "${app_dir}/scripts/deploy/render-systemd-units.mjs"

  write_prepared_marker "${marker_path}" "${manifest_json}" "${release_id}"

  trap - EXIT
  echo "[deploy] prepared ${release_id}"
  echo "QQBOT_RELEASE_ID=${release_id}"
}

restart_scope() {
  local scope="$1"
  case "${scope}" in
    koishi)
      systemctl restart qqbot-koishi.service
      ;;
    full)
      systemctl enable "${SYSTEMD_TARGET}" >/dev/null 2>&1 || true
      systemctl restart "${SYSTEMD_TARGET}"
      ;;
    *)
      echo "[deploy] invalid restart scope: ${scope}" >&2
      exit 2
      ;;
  esac
}

activate_release() {
  if [[ "$#" -ne 1 ]]; then
    usage
    exit 2
  fi

  local release_id="$1"
  validate_release_id "${release_id}"

  local release_root="${RELEASES_DIR}/${release_id}"
  local app_dir="${release_root}/qqbot"
  local marker_path="${release_root}/.qqbot-release-prepared.json"

  if [[ ! -f "${marker_path}" ]]; then
    echo "[deploy] release is not prepared: ${release_root}" >&2
    exit 2
  fi

  if [[ ! -f "${app_dir}/package.json" ]]; then
    echo "[deploy] prepared release is missing qqbot/package.json: ${app_dir}" >&2
    exit 2
  fi

  if [[ -e "${CURRENT_LINK}" && ! -L "${CURRENT_LINK}" ]]; then
    echo "[deploy] DEPLOY_APP_DIR exists and is not a symlink: ${CURRENT_LINK}" >&2
    exit 2
  fi

  QQBOT_DEPLOY_APP_DIR="${CURRENT_LINK}" \
  QQBOT_SHARED_DIR="${SHARED_DIR}" \
  QQBOT_SYSTEMD_TARGET="${SYSTEMD_TARGET}" \
  QQBOT_SYSTEMD_DIR="/etc/systemd/system" \
    node "${app_dir}/scripts/deploy/render-systemd-units.mjs"

  local previous_current=""
  if [[ -L "${CURRENT_LINK}" ]]; then
    previous_current="$(readlink -f "${CURRENT_LINK}" || true)"
  fi

  rollback_current() {
    local code="$?"
    if [[ "${code}" -ne 0 && -n "${previous_current}" && -d "${previous_current}" ]]; then
      echo "[deploy] rolling current symlink back to ${previous_current}" >&2
      ln -sfn "${previous_current}" "${CURRENT_LINK}" || true
      restart_scope "${DEPLOY_SCOPE}" >/dev/null 2>&1 || true
    fi
    exit "${code}"
  }
  trap rollback_current EXIT

  ln -sfn "${app_dir}" "${CURRENT_LINK}"
  systemctl daemon-reload
  restart_scope "${DEPLOY_SCOPE}"
  systemctl is-active --quiet qqbot-koishi.service

  trap - EXIT
  echo "[deploy] activated ${release_id} with scope ${DEPLOY_SCOPE}"
}

verify_release() {
  if [[ "$#" -lt 1 || "$#" -gt 2 ]]; then
    usage
    exit 2
  fi

  local verify_scope="$1"
  local expected_release_id="${2:-}"

  case "${verify_scope}" in
    koishi|full) ;;
    *)
      echo "[deploy] invalid verify scope: ${verify_scope}" >&2
      exit 2
      ;;
  esac

  if [[ -n "${expected_release_id}" ]]; then
    validate_release_id "${expected_release_id}"
    local expected_app_dir="${RELEASES_DIR}/${expected_release_id}/qqbot"
    local active_app_dir=""
    if [[ -L "${CURRENT_LINK}" ]]; then
      active_app_dir="$(readlink -f "${CURRENT_LINK}" || true)"
    fi
    if [[ "${active_app_dir}" != "${expected_app_dir}" ]]; then
      echo "[deploy] current release mismatch: expected ${expected_app_dir}, got ${active_app_dir}" >&2
      exit 1
    fi
  fi

  bash "${CURRENT_LINK}/scripts/verify-qqbot-host-runtime.sh" "${verify_scope}"
}

case "${COMMAND}" in
  prepare)
    prepare_release "$@"
    ;;
  activate)
    activate_release "$@"
    ;;
  verify)
    verify_release "$@"
    ;;
  *)
    usage
    exit 2
    ;;
esac

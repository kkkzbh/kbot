#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF' >&2
Usage:
  install-release.sh <qqbot-release.tar.gz>

Environment:
  DEPLOY_APP_DIR           Current symlink path (default: /opt/qqbot/current)
  QQBOT_SHARED_DIR         Persistent shared state dir (default: /opt/qqbot/shared)
  DEPLOY_SYSTEMD_TARGET    Systemd target to restart (default: qqbot.target)
  QQBOT_DEPLOY_DRY_RUN     Set to 1 to extract, validate, render units, and skip service switch/restart
EOF
}

if [[ "$#" -ne 1 ]]; then
  usage
  exit 2
fi

BUNDLE_PATH="$1"
if [[ ! -f "${BUNDLE_PATH}" ]]; then
  echo "[deploy] release bundle not found: ${BUNDLE_PATH}" >&2
  exit 2
fi

CURRENT_LINK="${DEPLOY_APP_DIR:-/opt/qqbot/current}"
CURRENT_PARENT="$(dirname "${CURRENT_LINK}")"
mkdir -p "${CURRENT_PARENT}"
BASE_DIR="$(cd -- "${CURRENT_PARENT}" && pwd)"
SHARED_DIR="${QQBOT_SHARED_DIR:-${BASE_DIR}/shared}"
RELEASES_DIR="${BASE_DIR}/releases"
SYSTEMD_TARGET="${DEPLOY_SYSTEMD_TARGET:-qqbot.target}"
DRY_RUN="${QQBOT_DEPLOY_DRY_RUN:-0}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[deploy] missing command: $1" >&2
    exit 2
  fi
}

require_cmd tar
require_cmd node

MANIFEST_JSON="$(tar -xOf "${BUNDLE_PATH}" build-manifest.json)"
QQBOT_SHA="$(node -e "const m=JSON.parse(process.argv[1]); process.stdout.write(String(m.qqbot?.sha || 'unknown'))" "${MANIFEST_JSON}")"
CREATED_AT="$(node -e "const m=JSON.parse(process.argv[1]); process.stdout.write(String(m.artifact?.createdAt || new Date().toISOString()))" "${MANIFEST_JSON}")"
STAMP="$(printf '%s' "${CREATED_AT}" | tr -cd '0-9T' | cut -c1-15)"
SHORT_SHA="${QQBOT_SHA:0:12}"
if [[ ! "${SHORT_SHA}" =~ ^[0-9a-fA-F]{7,12}$ ]]; then
  SHORT_SHA="unknown"
fi

RELEASE_ID="${STAMP}-${SHORT_SHA}"
RELEASE_ROOT="${RELEASES_DIR}/${RELEASE_ID}"
APP_DIR="${RELEASE_ROOT}/qqbot"
CHATLUNA_DIR="${RELEASE_ROOT}/chatluna"

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

if [[ -e "${RELEASE_ROOT}" ]]; then
  echo "[deploy] release already exists: ${RELEASE_ROOT}" >&2
  exit 2
fi

mkdir -p "${RELEASE_ROOT}"
cleanup_release_on_error() {
  local code="$?"
  if [[ "${code}" -ne 0 && ! -e "${APP_DIR}/node_modules" ]]; then
    rm -rf "${RELEASE_ROOT}" >/dev/null 2>&1 || true
  fi
  exit "${code}"
}
trap cleanup_release_on_error EXIT

tar -xzf "${BUNDLE_PATH}" -C "${RELEASE_ROOT}"

if [[ ! -f "${APP_DIR}/package.json" ]]; then
  echo "[deploy] invalid release bundle: missing qqbot/package.json" >&2
  exit 2
fi

if [[ ! -f "${CHATLUNA_DIR}/packages/core/package.json" ]]; then
  echo "[deploy] invalid release bundle: missing chatluna/packages/core/package.json" >&2
  exit 2
fi

source "${APP_DIR}/scripts/lib/chatluna-package-manager.sh"

bash "${APP_DIR}/scripts/deploy/verify-host-prereqs.sh"
node "${APP_DIR}/scripts/validate-server-voice-env.mjs" "${SHARED_DIR}/.env.server"

QQBOT_SERVER_ENV_FILE="${SHARED_DIR}/.env.server" \
DEPLOY_APP_DIR="${APP_DIR}" \
QQBOT_SHARED_DIR="${SHARED_DIR}" \
  bash "${APP_DIR}/scripts/prepare-server-runtime-layer.sh"

YARN_CACHE_FOLDER="${SHARED_DIR}/cache/yarn" chatluna_yarn_install_immutable "${CHATLUNA_DIR}"

CHATLUNA_ROOT_DIR="${CHATLUNA_DIR}" bash "${APP_DIR}/scripts/ensure-chatluna-build.sh"

(
  cd "${APP_DIR}"
  pnpm install --frozen-lockfile
  pnpm build
)

SYSTEMD_RENDER_DIR="/etc/systemd/system"
if [[ "${DRY_RUN}" == "1" ]]; then
  SYSTEMD_RENDER_DIR="${RELEASE_ROOT}/.systemd-dry-run"
fi

QQBOT_DEPLOY_APP_DIR="${CURRENT_LINK}" \
QQBOT_SHARED_DIR="${SHARED_DIR}" \
QQBOT_SYSTEMD_TARGET="${SYSTEMD_TARGET}" \
QQBOT_SYSTEMD_DIR="${SYSTEMD_RENDER_DIR}" \
  node "${APP_DIR}/scripts/deploy/render-systemd-units.mjs"

if [[ "${DRY_RUN}" == "1" ]]; then
  echo "[deploy] dry-run complete: ${RELEASE_ROOT}"
  trap - EXIT
  exit 0
fi

PREVIOUS_CURRENT=""
if [[ -L "${CURRENT_LINK}" ]]; then
  PREVIOUS_CURRENT="$(readlink -f "${CURRENT_LINK}" || true)"
fi

rollback_current() {
  local code="$?"
  if [[ "${code}" -ne 0 && -n "${PREVIOUS_CURRENT}" && -d "${PREVIOUS_CURRENT}" ]]; then
    echo "[deploy] rolling current symlink back to ${PREVIOUS_CURRENT}" >&2
    ln -sfn "${PREVIOUS_CURRENT}" "${CURRENT_LINK}" || true
    systemctl restart "${SYSTEMD_TARGET}" >/dev/null 2>&1 || true
  fi
  exit "${code}"
}
trap rollback_current EXIT

ln -sfn "${APP_DIR}" "${CURRENT_LINK}"

systemctl daemon-reload
systemctl enable "${SYSTEMD_TARGET}" >/dev/null 2>&1 || true
systemctl restart "${SYSTEMD_TARGET}"
systemctl is-active --quiet "${SYSTEMD_TARGET}"

if [[ "${SYSTEMD_TARGET}" == "qqbot.target" ]]; then
  bash "${CURRENT_LINK}/scripts/verify-qqbot-host-runtime.sh"
fi

trap - EXIT
echo "[deploy] deployed ${RELEASE_ID}"

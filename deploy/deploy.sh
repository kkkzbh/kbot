#!/usr/bin/env bash
set -euo pipefail

HOST="${1:-km6}"
BASE_DIR="${QQBOT_BASE_DIR:-/opt/qqbot}"
DEPLOY_MODE="${QQBOT_DEPLOY_MODE:-install}"
ACTIVATION_MODE="${QQBOT_DEPLOY_ACTIVATION_MODE:-start}"
ROOT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHATLUNA_SOURCE_DIR="${CHATLUNA_SOURCE_DIR:-${ROOT_DIR}/../chatluna}"
LLBOT_VERSION="${LLBOT_VERSION:-7.12.15}"
LLBOT_RELEASE_URL="https://github.com/LLOneBot/LuckyLilliaBot/releases/download/v${LLBOT_VERSION}/LLBot.zip"

TMP_PARENT="${ROOT_DIR}/.tmp/deploy"
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
RUN_DIR="${TMP_PARENT}/${RUN_ID}"
ARTIFACT_DIR="${RUN_DIR}/artifacts"
STAGING_DIR="${RUN_DIR}/stage"
HEAD_SOURCE_DIR="${RUN_DIR}/head/qqbot"
CACHE_DIR="${QQBOT_DEPLOY_CACHE_DIR:-${ROOT_DIR}/.tmp/deploy-cache}"
BUNDLE_PATH="${ARTIFACT_DIR}/qqbot.tar.gz"
MANIFEST_PATH="${TMP_PARENT}/${RUN_ID}/build-manifest.json"
BUNDLE_ENTRIES="${TMP_PARENT}/${RUN_ID}/bundle.entries"
LLBOT_CACHE_PATH="${CACHE_DIR}/LLBot-${LLBOT_VERSION}.zip"
REMOTE_INCOMING="${BASE_DIR}/incoming"
REMOTE_BUNDLE="${REMOTE_INCOMING}/qqbot.tar.gz"
REMOTE_STAGING="${BASE_DIR}/.staging"
REMOTE_INSTALLER="${REMOTE_STAGING}/installer.sh"
REMOTE_TRANSACTION_POLICY="${REMOTE_STAGING}/deployment-transaction.sh"
REMOTE_MANIFEST="${BASE_DIR}/app/build-manifest.json"
REMOTE_SHARED="${BASE_DIR}/shared"
REMOTE_DATA="${BASE_DIR}/data"
REMOTE_ENV_SERVER="${REMOTE_SHARED}/.env.server"
LOCAL_ENV_SERVER="${QQBOT_SERVER_ENV_FILE:-${ROOT_DIR}/.env.server}"

case "${DEPLOY_MODE}" in
  install|upload-only) ;;
  *) echo "[deploy] invalid QQBOT_DEPLOY_MODE: ${DEPLOY_MODE}" >&2; exit 2 ;;
esac
case "${ACTIVATION_MODE}" in
  start|keep-stopped) ;;
  *) echo "[deploy] invalid QQBOT_DEPLOY_ACTIVATION_MODE: ${ACTIVATION_MODE}" >&2; exit 2 ;;
esac

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[deploy] missing command: $1" >&2
    exit 2
  fi
}

for cmd in git node pnpm tar curl ssh scp grep date; do
  require_cmd "${cmd}"
done

if [[ ! -f "${ROOT_DIR}/package.json" ]]; then
  echo "[deploy] invalid qqbot root: ${ROOT_DIR}" >&2
  exit 2
fi

if [[ ! -f "${CHATLUNA_SOURCE_DIR}/packages/core/package.json" ]]; then
  echo "[deploy] missing ChatLuna checkout: ${CHATLUNA_SOURCE_DIR}" >&2
  exit 2
fi

remote_quote() {
  printf '%q' "$1"
}

clean_remote_upload() {
  ssh "${HOST}" "if test -d $(remote_quote "${REMOTE_INCOMING}"); then rm -f $(remote_quote "${REMOTE_BUNDLE}.upload"); fi"
}

remote_already_deployed() {
  local qqbot_sha="$1"
  local chatluna_sha="$2"

  if [[ "${QQBOT_FORCE_DEPLOY:-}" == "1" ]]; then
    return 1
  fi

  ssh "${HOST}" "! test -e $(remote_quote "${REMOTE_SHARED}/deployment-transaction.state") && test -f $(remote_quote "${REMOTE_MANIFEST}") && node -e 'const fs = require(\"node:fs\"); const manifest = JSON.parse(fs.readFileSync(process.argv[1], \"utf8\")); process.exit(manifest.qqbot?.sha === process.argv[2] && manifest.chatluna?.sha === process.argv[3] ? 0 : 1);' $(remote_quote "${REMOTE_MANIFEST}") $(remote_quote "${qqbot_sha}") $(remote_quote "${chatluna_sha}")"
}

ensure_llbot_release_zip() {
  mkdir -p "${CACHE_DIR}"
  if [[ -s "${LLBOT_CACHE_PATH}" ]]; then
    echo "[deploy] use cached LLBot ${LLBOT_VERSION}: ${LLBOT_CACHE_PATH}"
    return 0
  fi

  echo "[deploy] download LLBot ${LLBOT_VERSION}"
  rm -f "${LLBOT_CACHE_PATH}.upload"
  curl -fL --connect-timeout 30 --max-time 180 \
    -o "${LLBOT_CACHE_PATH}.upload" \
    "${LLBOT_RELEASE_URL}"
  mv "${LLBOT_CACHE_PATH}.upload" "${LLBOT_CACHE_PATH}"
}

require_bundle_entry() {
  local entry="$1"
  local candidate
  while IFS= read -r candidate; do
    if [[ "${candidate}" == "${entry}" || "${candidate}" == "${entry}/"* ]]; then
      return 0
    fi
  done < "${BUNDLE_ENTRIES}"
  echo "[deploy] missing bundle entry: ${entry}" >&2
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
  echo "[deploy] bundled preset catalog has no YAML definitions: ${entry}" >&2
  exit 2
}

verify_bundle() {
  tar -tzf "${BUNDLE_PATH}" > "${BUNDLE_ENTRIES}"
  require_bundle_entry "build-manifest.json"
  require_bundle_entry "qqbot/package.json"
  require_bundle_entry "qqbot/koishi.yml"
  require_bundle_entry "qqbot/dist"
  require_bundle_entry "qqbot/dist/tools/context-preset-cutover.mjs"
  require_bundle_entry "qqbot/dist/tools/context-preset-sqlite.py"
  require_bundle_entry "qqbot/dist/tools/model-config-v3-cutover.mjs"
  require_bundle_entry "qqbot/dist/tools/model-auth-connection-cutover.mjs"
  require_bundle_entry "qqbot/dist/tools/memory-v3-cutover.mjs"
  require_bundle_entry "qqbot/dist/tools/memory-evaluation.mjs"
  require_bundle_entry "qqbot/dist/tools/memory-evaluation-adapter.mjs"
  require_bundle_entry "qqbot/data/chathub/context-presets"
  require_bundle_entry "qqbot/data/chathub/role-presets"
  require_bundle_catalog "qqbot/data/chathub/context-presets"
  require_bundle_catalog "qqbot/data/chathub/role-presets"
  require_bundle_entry "qqbot/deploy/installer.sh"
  require_bundle_entry "qqbot/deploy/deployment-transaction.sh"
  require_bundle_entry "qqbot/deploy/render-systemd.mjs"
  require_bundle_entry "qqbot/scripts/verify-memory-v3-readiness.mjs"
  require_bundle_entry "chatluna/packages/core/package.json"
}

ensure_server_env() {
  ssh "${HOST}" "mkdir -p $(printf '%q' "${REMOTE_INCOMING}") $(printf '%q' "${REMOTE_STAGING}") $(printf '%q' "${REMOTE_SHARED}") $(printf '%q' "${REMOTE_DATA}") && chmod 700 $(printf '%q' "${REMOTE_SHARED}") $(printf '%q' "${REMOTE_DATA}")"
  if ssh "${HOST}" "test -f $(printf '%q' "${REMOTE_ENV_SERVER}")"; then
    echo "[deploy] server env exists: ${HOST}:${REMOTE_ENV_SERVER}"
    return 0
  fi
  if [[ ! -f "${LOCAL_ENV_SERVER}" ]]; then
    echo "[deploy] missing local server env for first deploy: ${LOCAL_ENV_SERVER}" >&2
    echo "[deploy] create ${LOCAL_ENV_SERVER} from .env.server.example, then rerun deploy" >&2
    exit 2
  fi
  echo "[deploy] install first server env: ${HOST}:${REMOTE_ENV_SERVER}"
  scp "${LOCAL_ENV_SERVER}" "${HOST}:${REMOTE_ENV_SERVER}.upload"
  ssh "${HOST}" "mv $(printf '%q' "${REMOTE_ENV_SERVER}.upload") $(printf '%q' "${REMOTE_ENV_SERVER}") && chmod 600 $(printf '%q' "${REMOTE_ENV_SERVER}")"
}

materialize_qqbot_head_source() {
  mkdir -p "${HEAD_SOURCE_DIR}"
  git archive --format=tar HEAD | tar -xf - -C "${HEAD_SOURCE_DIR}"
  ln -s "${CHATLUNA_SOURCE_DIR}" "$(dirname "${HEAD_SOURCE_DIR}")/chatluna"
  if [[ -e "${ROOT_DIR}/node_modules" ]]; then
    ln -s "${ROOT_DIR}/node_modules" "${HEAD_SOURCE_DIR}/node_modules"
  fi
}

mkdir -p "${ARTIFACT_DIR}" "${STAGING_DIR}/qqbot" "${STAGING_DIR}/chatluna"
trap 'rm -rf "${RUN_DIR}"' EXIT
cd "${ROOT_DIR}"

clean_remote_upload

if [[ -n "$(git -C "${CHATLUNA_SOURCE_DIR}" status --porcelain)" ]]; then
  echo "[deploy] local ChatLuna worktree is not clean" >&2
  git -C "${CHATLUNA_SOURCE_DIR}" status --short >&2
  exit 2
fi

QQBOT_SHA="$(git rev-parse HEAD)"
CHATLUNA_SHA="$(git -C "${CHATLUNA_SOURCE_DIR}" rev-parse HEAD)"
if [[ -n "$(git status --porcelain)" ]]; then
  echo "[deploy] local qqbot worktree has uncommitted changes; deploying committed HEAD ${QQBOT_SHA}"
fi
if remote_already_deployed "${QQBOT_SHA}" "${CHATLUNA_SHA}"; then
  echo "[deploy] remote already has qqbot ${QQBOT_SHA} and ChatLuna ${CHATLUNA_SHA}"
  echo "[deploy] nothing to deploy; set QQBOT_FORCE_DEPLOY=1 to force"
  exit 0
fi

materialize_qqbot_head_source
cd "${HEAD_SOURCE_DIR}"
export CHATLUNA_ROOT_DIR="${CHATLUNA_SOURCE_DIR}"

echo "[deploy] typecheck"
pnpm typecheck

echo "[deploy] test"
pnpm test -- --reporter=dot

echo "[deploy] build"
pnpm build

node ./deploy/write-build-manifest.mjs \
  --output "${MANIFEST_PATH}" \
  --qqbot-root "${ROOT_DIR}" \
  --qqbot-package-root "${HEAD_SOURCE_DIR}" \
  --chatluna-root "${CHATLUNA_SOURCE_DIR}"

tar \
  --exclude='./node_modules' \
  --exclude='./dist' \
  --exclude='./.tmp' \
  -cf - -C "${HEAD_SOURCE_DIR}" . \
  | tar -xf - -C "${STAGING_DIR}/qqbot"

cp -a "${HEAD_SOURCE_DIR}/dist" "${STAGING_DIR}/qqbot/dist"
mkdir -p "${STAGING_DIR}/qqbot/vendor/llbot"
ensure_llbot_release_zip
cp "${LLBOT_CACHE_PATH}" "${STAGING_DIR}/qqbot/vendor/llbot/LLBot-${LLBOT_VERSION}.zip"

tar \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='.idea' \
  --exclude='.yarn-cache' \
  --exclude='.yarn/install-state.gz' \
  --exclude='.turbo' \
  -cf - -C "${CHATLUNA_SOURCE_DIR}" . \
  | tar -xf - -C "${STAGING_DIR}/chatluna"

cp "${MANIFEST_PATH}" "${STAGING_DIR}/build-manifest.json"
cp "${MANIFEST_PATH}" "${STAGING_DIR}/qqbot/build-manifest.json"
tar -czf "${BUNDLE_PATH}" -C "${STAGING_DIR}" build-manifest.json qqbot chatluna
verify_bundle

ensure_server_env
clean_remote_upload

echo "[deploy] upload ${BUNDLE_PATH} -> ${HOST}:${REMOTE_BUNDLE}"
scp "${BUNDLE_PATH}" "${HOST}:${REMOTE_BUNDLE}.upload"
ssh "${HOST}" "mv $(printf '%q' "${REMOTE_BUNDLE}.upload") $(printf '%q' "${REMOTE_BUNDLE}")"

if [[ "${DEPLOY_MODE}" == "upload-only" ]]; then
  echo "[deploy] coordinated release uploaded without installation"
  echo "[deploy] bundle retained at ${HOST}:${REMOTE_BUNDLE}"
  exit 0
fi

echo "[deploy] install on ${HOST}"
ssh "${HOST}" "tar -xOf $(printf '%q' "${REMOTE_BUNDLE}") qqbot/deploy/installer.sh > $(printf '%q' "${REMOTE_INSTALLER}") && tar -xOf $(printf '%q' "${REMOTE_BUNDLE}") qqbot/deploy/deployment-transaction.sh > $(printf '%q' "${REMOTE_TRANSACTION_POLICY}") && chmod 700 $(printf '%q' "${REMOTE_INSTALLER}") $(printf '%q' "${REMOTE_TRANSACTION_POLICY}") && QQBOT_BASE_DIR=$(printf '%q' "${BASE_DIR}") bash $(printf '%q' "${REMOTE_INSTALLER}") $(printf '%q' "${REMOTE_BUNDLE}") full $(printf '%q' "${ACTIVATION_MODE}")"

echo "[deploy] done"

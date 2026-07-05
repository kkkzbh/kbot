#!/usr/bin/env bash
set -euo pipefail

HOST="${1:-km6}"
BASE_DIR="${QQBOT_BASE_DIR:-/opt/qqbot}"
ROOT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHATLUNA_SOURCE_DIR="${CHATLUNA_SOURCE_DIR:-${ROOT_DIR}/../chatluna}"
LLBOT_VERSION="${LLBOT_VERSION:-7.12.15}"
LLBOT_RELEASE_URL="https://github.com/LLOneBot/LuckyLilliaBot/releases/download/v${LLBOT_VERSION}/LLBot.zip"

TMP_PARENT="${ROOT_DIR}/.tmp/deploy"
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
ARTIFACT_DIR="${TMP_PARENT}/${RUN_ID}/artifacts"
STAGING_DIR="${TMP_PARENT}/${RUN_ID}/stage"
BUNDLE_PATH="${ARTIFACT_DIR}/qqbot.tar.gz"
MANIFEST_PATH="${TMP_PARENT}/${RUN_ID}/build-manifest.json"
REMOTE_INCOMING="${BASE_DIR}/incoming"
REMOTE_BUNDLE="${REMOTE_INCOMING}/qqbot.tar.gz"
REMOTE_STAGING="${BASE_DIR}/.staging"
REMOTE_SHARED="${BASE_DIR}/shared"
REMOTE_DATA="${BASE_DIR}/data"
REMOTE_ENV_SERVER="${REMOTE_SHARED}/.env.server"
LOCAL_ENV_SERVER="${QQBOT_SERVER_ENV_FILE:-${ROOT_DIR}/.env.server}"

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

mkdir -p "${ARTIFACT_DIR}" "${STAGING_DIR}/qqbot" "${STAGING_DIR}/chatluna"
cd "${ROOT_DIR}"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "[deploy] local qqbot worktree is not clean" >&2
  git status --short >&2
  exit 2
fi

if [[ -n "$(git -C "${CHATLUNA_SOURCE_DIR}" status --porcelain)" ]]; then
  echo "[deploy] local ChatLuna worktree is not clean" >&2
  git -C "${CHATLUNA_SOURCE_DIR}" status --short >&2
  exit 2
fi

echo "[deploy] typecheck"
pnpm typecheck

echo "[deploy] test"
pnpm test -- --reporter=dot

echo "[deploy] build"
pnpm build

node ./deploy/write-build-manifest.mjs \
  --output "${MANIFEST_PATH}" \
  --qqbot-root "${ROOT_DIR}" \
  --chatluna-root "${CHATLUNA_SOURCE_DIR}"


git ls-files -z --cached --others --exclude-standard \
  | grep -zv -E '^(chatluna-src|artifacts|\\.tmp)/' \
  | tar --null -T - -cf - \
  | tar -xf - -C "${STAGING_DIR}/qqbot"

cp -a "${ROOT_DIR}/dist" "${STAGING_DIR}/qqbot/dist"
mkdir -p "${STAGING_DIR}/qqbot/vendor/llbot"
curl -fL --connect-timeout 30 --max-time 180 \
  -o "${STAGING_DIR}/qqbot/vendor/llbot/LLBot-${LLBOT_VERSION}.zip" \
  "${LLBOT_RELEASE_URL}"

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

ensure_server_env

echo "[deploy] upload ${BUNDLE_PATH} -> ${HOST}:${REMOTE_BUNDLE}"
scp "${BUNDLE_PATH}" "${HOST}:${REMOTE_BUNDLE}.upload"
ssh "${HOST}" "mv $(printf '%q' "${REMOTE_BUNDLE}.upload") $(printf '%q' "${REMOTE_BUNDLE}")"

echo "[deploy] install on ${HOST}"
ssh "${HOST}" "tar -xOf $(printf '%q' "${REMOTE_BUNDLE}") qqbot/deploy/installer.sh > $(printf '%q' "${REMOTE_STAGING}/installer.sh") && chmod 700 $(printf '%q' "${REMOTE_STAGING}/installer.sh") && QQBOT_BASE_DIR=$(printf '%q' "${BASE_DIR}") bash $(printf '%q' "${REMOTE_STAGING}/installer.sh") $(printf '%q' "${REMOTE_BUNDLE}") full"

echo "[deploy] done"

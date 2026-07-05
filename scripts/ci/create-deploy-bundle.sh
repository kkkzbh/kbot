#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${ROOT_DIR}"

CHATLUNA_SOURCE_DIR="${CHATLUNA_SOURCE_DIR:-${ROOT_DIR}/chatluna-src}"
BUILD_MANIFEST_PATH="${BUILD_MANIFEST_PATH:-${ROOT_DIR}/artifacts/build-manifest.json}"
BUNDLE_OUTPUT_DIR="${BUNDLE_OUTPUT_DIR:-${ROOT_DIR}/artifacts}"
LLBOT_VERSION="${LLBOT_VERSION:-7.12.15}"
LLBOT_RELEASE_URL="https://github.com/LLOneBot/LuckyLilliaBot/releases/download/v${LLBOT_VERSION}/LLBot.zip"

if [[ ! -f "${BUILD_MANIFEST_PATH}" ]]; then
  echo "[bundle] missing build manifest: ${BUILD_MANIFEST_PATH}" >&2
  exit 2
fi

if [[ ! -f "${CHATLUNA_SOURCE_DIR}/packages/core/package.json" ]]; then
  echo "[bundle] missing linked ChatLuna checkout: ${CHATLUNA_SOURCE_DIR}" >&2
  exit 2
fi

if [[ ! -f "${CHATLUNA_SOURCE_DIR}/yarn.lock" ]]; then
  echo "[bundle] missing ChatLuna yarn.lock; run workspace setup before bundling" >&2
  exit 2
fi

if ! grep -q '^__metadata:' "${CHATLUNA_SOURCE_DIR}/yarn.lock"; then
  echo "[bundle] ChatLuna yarn.lock is not a Yarn 4 lockfile" >&2
  exit 2
fi

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[bundle] missing command: $1" >&2
    exit 2
  fi
}

require_cmd git
require_cmd grep
require_cmd tar
require_cmd node
require_cmd curl

QQBOT_SHA="$(node -e "const fs=require('node:fs'); const path=require('node:path'); const m=JSON.parse(fs.readFileSync(path.resolve(process.argv[1]), 'utf8')); process.stdout.write(String(m.qqbot?.sha || 'unknown'))" "${BUILD_MANIFEST_PATH}")"
SHORT_SHA="${QQBOT_SHA:0:12}"
if [[ ! "${SHORT_SHA}" =~ ^[0-9a-fA-F]{7,12}$ ]]; then
  SHORT_SHA="$(git rev-parse --short=12 HEAD)"
fi

mkdir -p "${BUNDLE_OUTPUT_DIR}"
STAGING_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "${STAGING_DIR}"
}
trap cleanup EXIT

mkdir -p "${STAGING_DIR}/qqbot" "${STAGING_DIR}/chatluna"

git ls-files -z --cached --others --exclude-standard \
  | grep -zv -E '^(chatluna-src|artifacts)/' \
  | tar --null -T - -cf - \
  | tar -xf - -C "${STAGING_DIR}/qqbot"

tar \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='.idea' \
  --exclude='.yarn-cache' \
  -cf - -C "${CHATLUNA_SOURCE_DIR}" . \
  | tar -xf - -C "${STAGING_DIR}/chatluna"

mkdir -p "${STAGING_DIR}/qqbot/vendor/llbot"
curl -fL --connect-timeout 30 --max-time 180 -o "${STAGING_DIR}/qqbot/vendor/llbot/LLBot-${LLBOT_VERSION}.zip" "${LLBOT_RELEASE_URL}"

cp "${BUILD_MANIFEST_PATH}" "${STAGING_DIR}/build-manifest.json"
cp "${BUILD_MANIFEST_PATH}" "${STAGING_DIR}/qqbot/build-manifest.json"

BUNDLE_PATH="${BUNDLE_OUTPUT_DIR}/qqbot-release-${SHORT_SHA}.tar.gz"
tar -czf "${BUNDLE_PATH}" -C "${STAGING_DIR}" build-manifest.json qqbot chatluna

echo "${BUNDLE_PATH}"

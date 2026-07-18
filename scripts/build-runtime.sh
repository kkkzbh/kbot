#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_ROOT="${ROOT_DIR}/.tmp"
DIST_DIR="${ROOT_DIR}/dist"

mkdir -p "$TMP_ROOT"

BUILD_ROOT="$(mktemp -d "${TMP_ROOT}/runtime-build-XXXXXX")"
STAGE_DIST="${BUILD_ROOT}/dist"
STAGE_ADMIN_DIR="${STAGE_DIST}/admin-web"
NEXT_DIST="${TMP_ROOT}/dist-next-$$"
PREVIOUS_DIST="${TMP_ROOT}/dist-previous-$$"
SWAP_STARTED=0

cleanup() {
  local code="$?"
  if [[ "$code" -ne 0 && "$SWAP_STARTED" == "1" && -e "$PREVIOUS_DIST" && ! -e "$DIST_DIR" ]]; then
    mv "$PREVIOUS_DIST" "$DIST_DIR" >/dev/null 2>&1 || true
  fi
  rm -rf "$BUILD_ROOT" "$NEXT_DIST"
  if [[ "$code" -eq 0 ]]; then
    rm -rf "$PREVIOUS_DIST"
  fi
}
trap cleanup EXIT

cd "$ROOT_DIR"

./scripts/ensure-chatluna-build.sh
pnpm exec tsc -p tsconfig.build.json --outDir "$STAGE_DIST"
QQBOT_ADMIN_OUT_DIR="$STAGE_ADMIN_DIR" pnpm admin:build
mkdir -p "$STAGE_DIST/plugins/affinity/assets"
cp -R "$ROOT_DIR/src/plugins/affinity/assets/." "$STAGE_DIST/plugins/affinity/assets/"
mkdir -p "$STAGE_DIST/plugins/genshin/assets"
cp -R "$ROOT_DIR/src/plugins/genshin/assets/." "$STAGE_DIST/plugins/genshin/assets/"
mkdir -p "$STAGE_DIST/plugins/hbu-jw/assets"
cp -R "$ROOT_DIR/src/plugins/hbu-jw/assets/." "$STAGE_DIST/plugins/hbu-jw/assets/"
node ./scripts/verify-runtime-artifacts.mjs --config koishi.yml --dist "$STAGE_DIST"

rm -rf "$NEXT_DIST" "$PREVIOUS_DIST"
mv "$STAGE_DIST" "$NEXT_DIST"

if [[ -e "$DIST_DIR" || -L "$DIST_DIR" ]]; then
  mv "$DIST_DIR" "$PREVIOUS_DIST"
fi
SWAP_STARTED=1
mv "$NEXT_DIST" "$DIST_DIR"
SWAP_STARTED=0

rm -rf "$PREVIOUS_DIST"
echo "[info] Runtime build complete: $DIST_DIR"

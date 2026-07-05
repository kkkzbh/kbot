#!/usr/bin/env bash
set -euo pipefail

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[prereq] missing command: $1" >&2
    exit 2
  fi
}

require_cmd bash
require_cmd tar
require_cmd node
if ! command -v corepack >/dev/null 2>&1 && ! command -v npm >/dev/null 2>&1; then
  echo "[prereq] missing command: corepack or npm" >&2
  exit 2
fi
require_cmd pnpm
require_cmd systemctl
require_cmd journalctl
require_cmd podman

if [[ -n "${PUPPETEER_EXECUTABLE_PATH:-}" && ! -x "${PUPPETEER_EXECUTABLE_PATH}" ]]; then
  echo "[prereq] PUPPETEER_EXECUTABLE_PATH is not executable: ${PUPPETEER_EXECUTABLE_PATH}" >&2
  exit 2
fi

if [[ -z "${PUPPETEER_EXECUTABLE_PATH:-}" ]] \
  && ! command -v chromium-browser >/dev/null 2>&1 \
  && [[ ! -x /usr/lib64/chromium-browser/headless_shell ]] \
  && ! command -v google-chrome >/dev/null 2>&1 \
  && ! command -v google-chrome-stable >/dev/null 2>&1; then
  echo "[prereq] missing headless browser command: set PUPPETEER_EXECUTABLE_PATH or install chromium-headless/google-chrome" >&2
  exit 2
fi

if ! command -v podman-compose >/dev/null 2>&1 && ! podman compose version >/dev/null 2>&1; then
  echo "[prereq] missing podman compose support" >&2
  exit 2
fi

echo "[prereq] host prerequisites are available"

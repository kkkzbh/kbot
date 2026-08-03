#!/usr/bin/env bash
set -euo pipefail

: "${HOME:?HOME is required}"
: "${XDG_RUNTIME_DIR:?XDG_RUNTIME_DIR is required}"

cd "${HOME}"

listed="$(
  podman --cgroup-manager=cgroupfs ps -aq \
    --filter label=io.qqbot.agent-workspace=true
)"
if [[ -z "${listed}" ]]; then
  exit 0
fi

mapfile -t containers <<< "${listed}"
podman --cgroup-manager=cgroupfs rm -f -- "${containers[@]}"

remaining="$(
  podman --cgroup-manager=cgroupfs ps -aq \
    --filter label=io.qqbot.agent-workspace=true
)"
if [[ -n "${remaining}" ]]; then
  echo "[agent-workspace] labeled containers remain after service stop" >&2
  exit 1
fi

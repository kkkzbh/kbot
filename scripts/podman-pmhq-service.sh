#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${QQBOT_COMPOSE_FILE:-${ROOT_DIR}/compose.yaml}"
PMHQ_CONTAINER="${QQBOT_PMHQ_CONTAINER_NAME:-pmhq}"
LEGACY_LLBOT_CONTAINER="${QQBOT_LLBOT_CONTAINER_NAME:-llonebot}"
ENV_FILE="${QQBOT_ENV_FILE:-}"

if [ -n "${ENV_FILE}" ]; then
  if [ "${ENV_FILE#/}" = "${ENV_FILE}" ]; then
    ENV_FILE="${ROOT_DIR}/${ENV_FILE}"
  fi
  if [ -f "${ENV_FILE}" ]; then
    set -a
    # shellcheck disable=SC1090
    . "${ENV_FILE}"
    set +a
  fi
fi

PMHQ_LOGIN_NETWORK_PROBE_URL="${QQBOT_PMHQ_LOGIN_NETWORK_PROBE_URL:-https://im.qq.com/}"
PMHQ_NETWORK_READY_TIMEOUT_SEC="${QQBOT_PMHQ_NETWORK_READY_TIMEOUT_SEC:-120}"
PMHQ_START_TIMEOUT_SEC="${QQBOT_PMHQ_START_TIMEOUT_SEC:-60}"
HOST_ROUTE_PROBE_IP="${QQBOT_PMHQ_HOST_ROUTE_PROBE_IP:-1.1.1.1}"

COMPOSE_CMD="podman-compose"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    exit 2
  fi
}

require_cmd podman
require_cmd "${COMPOSE_CMD}"

compose() {
  "${COMPOSE_CMD}" -f "${COMPOSE_FILE}" "$@"
}

wait_for() {
  local description="$1"
  local timeout="$2"
  shift 2

  local deadline=$((SECONDS + timeout))
  while [ "${SECONDS}" -lt "${deadline}" ]; do
    if "$@"; then
      echo "${description}: OK"
      return 0
    fi
    sleep 1
  done

  echo "${description}: FAILED" >&2
  return 1
}

remove_legacy_llbot_container() {
  podman rm -f "${LEGACY_LLBOT_CONTAINER}" >/dev/null 2>&1 || true
}

remove_legacy_cni_artifacts() {
  podman network rm qqbot-stack_default qqbot-stack_app_network >/dev/null 2>&1 || true
  rm -f /etc/cni/net.d/qqbot-stack_default.conflist /etc/cni/net.d/qqbot-stack_app_network.conflist >/dev/null 2>&1 || true
}

host_has_default_route() {
  ip -4 route get "${HOST_ROUTE_PROBE_IP}" >/dev/null 2>&1
}

host_can_reach_login_network() {
  curl --noproxy "*" -fsS --connect-timeout 8 --max-time 15 "${PMHQ_LOGIN_NETWORK_PROBE_URL}" -o /dev/null
}

host_login_network_ready() {
  host_has_default_route && host_can_reach_login_network
}

container_is_running() {
  local running
  running="$(podman inspect --format '{{.State.Running}}' "${PMHQ_CONTAINER}" 2>/dev/null || echo false)"
  [ "${running}" = "true" ]
}

pmhq_container_has_default_route() {
  podman exec "${PMHQ_CONTAINER}" sh -lc \
    'grep -Eq "^[^[:space:]]+[[:space:]]+00000000[[:space:]]+" /proc/net/route'
}

pmhq_container_can_reach_login_network() {
  podman exec "${PMHQ_CONTAINER}" sh -lc \
    'curl --noproxy "*" -fsS --connect-timeout 8 --max-time 15 "$1" -o /dev/null' \
    sh "${PMHQ_LOGIN_NETWORK_PROBE_URL}"
}

pmhq_container_network_ready() {
  pmhq_container_has_default_route && pmhq_container_can_reach_login_network
}

print_host_network_diagnostics() {
  echo "== host IPv4 routes ==" >&2
  ip -4 route >&2 || true
  echo "== host login network probe ==" >&2
  curl --noproxy "*" -I --connect-timeout 8 --max-time 15 "${PMHQ_LOGIN_NETWORK_PROBE_URL}" >&2 || true
}

print_pmhq_network_diagnostics() {
  echo "== ${PMHQ_CONTAINER} routes ==" >&2
  podman exec "${PMHQ_CONTAINER}" sh -lc 'cat /proc/net/route' >&2 || true
  echo "== ${PMHQ_CONTAINER} resolv.conf ==" >&2
  podman exec "${PMHQ_CONTAINER}" sh -lc 'cat /etc/resolv.conf' >&2 || true
  echo "== ${PMHQ_CONTAINER} login network probe ==" >&2
  podman exec "${PMHQ_CONTAINER}" sh -lc \
    'curl --noproxy "*" -I --connect-timeout 8 --max-time 15 "$1"' \
    sh "${PMHQ_LOGIN_NETWORK_PROBE_URL}" >&2 || true
}

remove_unusable_pmhq_container() {
  if ! container_is_running; then
    return 0
  fi

  if pmhq_container_network_ready; then
    return 0
  fi

  echo "${PMHQ_CONTAINER} network is not usable; recreating container netns" >&2
  print_pmhq_network_diagnostics
  compose stop pmhq >/dev/null 2>&1 || true
  podman rm -f "${PMHQ_CONTAINER}" >/dev/null
}

start_pmhq() {
  require_cmd curl
  require_cmd ip

  if ! wait_for "host login network is reachable" "${PMHQ_NETWORK_READY_TIMEOUT_SEC}" host_login_network_ready; then
    print_host_network_diagnostics
    exit 1
  fi

  remove_unusable_pmhq_container
  compose up -d pmhq
  wait_for "${PMHQ_CONTAINER} is running" "${PMHQ_START_TIMEOUT_SEC}" container_is_running
  if ! wait_for "${PMHQ_CONTAINER} outbound network is ready" "${PMHQ_NETWORK_READY_TIMEOUT_SEC}" pmhq_container_network_ready; then
    print_pmhq_network_diagnostics
    exit 1
  fi
}

recreate_pmhq_container() {
  compose stop pmhq >/dev/null 2>&1 || true
  podman rm -f "${PMHQ_CONTAINER}" >/dev/null 2>&1 || true
}

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 up|stop|restart" >&2
  exit 1
fi

case "$1" in
  up)
    remove_legacy_llbot_container
    remove_legacy_cni_artifacts
    start_pmhq
    ;;
  stop)
    compose stop pmhq
    ;;
  restart)
    remove_legacy_llbot_container
    remove_legacy_cni_artifacts
    recreate_pmhq_container
    start_pmhq
    ;;
  *)
    echo "Unknown action: $1" >&2
    exit 1
    ;;
esac

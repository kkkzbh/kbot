#!/usr/bin/env bash
set -euo pipefail

PMHQ_LOGIN_NETWORK_PROBE_URL="${QQBOT_PMHQ_LOGIN_NETWORK_PROBE_URL:-https://im.qq.com/}"
PMHQ_NETWORK_READY_TIMEOUT_SEC="${QQBOT_PMHQ_NETWORK_READY_TIMEOUT_SEC:-120}"
HOST_ROUTE_PROBE_IP="${QQBOT_PMHQ_HOST_ROUTE_PROBE_IP:-1.1.1.1}"

for command in curl ip; do
  if ! command -v "${command}" >/dev/null 2>&1; then
    echo "missing required command: ${command}" >&2
    exit 2
  fi
done

host_login_network_ready() {
  ip -4 route get "${HOST_ROUTE_PROBE_IP}" >/dev/null 2>&1 \
    && curl --noproxy "*" -fsS --connect-timeout 8 --max-time 15 "${PMHQ_LOGIN_NETWORK_PROBE_URL}" -o /dev/null
}

deadline=$((SECONDS + PMHQ_NETWORK_READY_TIMEOUT_SEC))
while [ "${SECONDS}" -lt "${deadline}" ]; do
  if host_login_network_ready; then
    echo "host login network is reachable: OK"
    exit 0
  fi
  sleep 1
done

echo "host login network is reachable: FAILED" >&2
echo "== host IPv4 routes ==" >&2
ip -4 route >&2 || true
echo "== host login network probe ==" >&2
curl --noproxy "*" -I --connect-timeout 8 --max-time 15 "${PMHQ_LOGIN_NETWORK_PROBE_URL}" >&2 || true
exit 1

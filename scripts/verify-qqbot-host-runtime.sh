#!/usr/bin/env bash
set -euo pipefail

PMHQ_CONTAINER="${QQBOT_PMHQ_CONTAINER_NAME:-pmhq}"
PMHQ_HEALTH_HOST="${QQBOT_PMHQ_HEALTH_HOST:-127.0.0.1}"
PMHQ_PORT="${PMHQ_PORT:-13000}"
PMHQ_LOGIN_NETWORK_PROBE_URL="${QQBOT_PMHQ_LOGIN_NETWORK_PROBE_URL:-https://im.qq.com/}"
LLBOT_WEBUI_PORT="${LLONEBOT_WEBUI_PORT:-3080}"
LLONEBOT_WS_PORT="${LLONEBOT_WS_PORT:-3001}"
LLBOT_UNIT="${QQBOT_LLBOT_UNIT:-qqbot-llbot.service}"
KOISHI_UNIT="${QQBOT_KOISHI_UNIT:-qqbot-koishi.service}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[verify] missing command: $1" >&2
    exit 2
  fi
}

require_cmd podman
require_cmd node
require_cmd journalctl

node_http_probe() {
  local url="$1"
  local label="$2"

  node -e "
    const http = require('node:http');
    const req = http.get(process.argv[1], (res) => {
      if (res.statusCode && res.statusCode >= 200 && res.statusCode < 500) {
        console.log(process.argv[2] + ' OK');
        process.exit(0);
      }
      console.error(process.argv[2] + ' FAILED ' + String(res.statusCode));
      process.exit(1);
    });
    req.setTimeout(5000, () => req.destroy(new Error('timeout')));
    req.on('error', (error) => {
      console.error(process.argv[2] + ' ERROR ' + error.message);
      process.exit(1);
    });
  " "$url" "$label"
}

node_ws_probe() {
  local url="$1"
  local label="$2"

  node -e "
    const ws = new WebSocket(process.argv[1]);
    const timeout = setTimeout(() => {
      console.error(process.argv[2] + ' TIMEOUT');
      process.exit(1);
    }, 5000);
    ws.addEventListener('open', () => {
      clearTimeout(timeout);
      console.log(process.argv[2] + ' OK');
      ws.close();
      process.exit(0);
    });
    ws.addEventListener('error', (event) => {
      clearTimeout(timeout);
      const error = event.error;
      console.error(process.argv[2] + ' ERROR ' + (error && error.message ? error.message : 'websocket connect failed'));
      process.exit(1);
    });
  " "$url" "$label"
}

container_is_running() {
  local running
  running="$(podman inspect --format '{{.State.Running}}' "${PMHQ_CONTAINER}" 2>/dev/null || echo false)"
  [ "${running}" = "true" ]
}

container_is_healthy() {
  local health
  health="$(podman inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}unknown{{end}}' "${PMHQ_CONTAINER}" 2>/dev/null || echo unknown)"
  [ "${health}" = "healthy" ] || [ "${health}" = "unknown" ]
}

container_has_default_route() {
  podman exec "${PMHQ_CONTAINER}" sh -lc \
    'grep -Eq "^[^[:space:]]+[[:space:]]+00000000[[:space:]]+" /proc/net/route'
}

container_can_reach_login_network() {
  podman exec "${PMHQ_CONTAINER}" sh -lc \
    'curl --noproxy "*" -fsS --connect-timeout 8 --max-time 15 "$1" -o /dev/null' \
    sh "${PMHQ_LOGIN_NETWORK_PROBE_URL}"
}

llbot_logs_contain() {
  local pattern="$1"
  journalctl -u "${LLBOT_UNIT}" --no-pager -n 500 2>/dev/null | grep -F "${pattern}" >/dev/null
}

systemd_unit_active() {
  local unit="$1"
  systemctl is-active --quiet "${unit}"
}

wait_until() {
  local description="$1"
  shift

  local attempt
  for attempt in $(seq 1 60); do
    if "$@"; then
      echo "${description}: OK"
      return 0
    fi
    sleep 1
  done

  echo "${description}: FAILED" >&2
  return 1
}

print_diagnostics() {
  echo "== pmhq inspect ==" >&2
  podman inspect "${PMHQ_CONTAINER}" 2>/dev/null || true
  echo "== pmhq routes ==" >&2
  podman exec "${PMHQ_CONTAINER}" sh -lc 'cat /proc/net/route' >&2 || true
  echo "== pmhq resolv.conf ==" >&2
  podman exec "${PMHQ_CONTAINER}" sh -lc 'cat /etc/resolv.conf' >&2 || true
  echo "== pmhq login network probe ==" >&2
  podman exec "${PMHQ_CONTAINER}" sh -lc \
    'curl --noproxy "*" -I --connect-timeout 8 --max-time 15 "$1"' \
    sh "${PMHQ_LOGIN_NETWORK_PROBE_URL}" >&2 || true
  echo "== pmhq logs ==" >&2
  podman logs "${PMHQ_CONTAINER}" 2>&1 || true
  echo "== ${LLBOT_UNIT} logs ==" >&2
  journalctl -u "${LLBOT_UNIT}" --no-pager -n 200 2>/dev/null || true
  echo "== ${KOISHI_UNIT} logs ==" >&2
  journalctl -u "${KOISHI_UNIT}" --no-pager -n 200 2>/dev/null || true
}

trap 'code=$?; if [ "$code" -ne 0 ]; then print_diagnostics; fi; exit "$code"' EXIT

wait_until "${PMHQ_CONTAINER} is running" container_is_running
wait_until "${PMHQ_CONTAINER} has a default route" container_has_default_route
wait_until "${PMHQ_CONTAINER} can reach QQ login network" container_can_reach_login_network
wait_until "${PMHQ_CONTAINER} is healthy" container_is_healthy
wait_until "pmhq health endpoint is reachable" \
  node_http_probe "http://${PMHQ_HEALTH_HOST}:${PMHQ_PORT}/health" "pmhq health"
wait_until "${LLBOT_UNIT} is active" systemd_unit_active "${LLBOT_UNIT}"
wait_until "${KOISHI_UNIT} is active" systemd_unit_active "${KOISHI_UNIT}"
wait_until "llbot webui is reachable" \
  node_http_probe "http://127.0.0.1:${LLBOT_WEBUI_PORT}/" "llbot webui"
wait_until "${LLBOT_UNIT} completes PMHQ WebSocket handshake" \
  llbot_logs_contain "PMHQ WebSocket 连接成功"
wait_until "koishi can reach llbot websocket" \
  node_ws_probe "ws://127.0.0.1:${LLONEBOT_WS_PORT}/" "koishi websocket"

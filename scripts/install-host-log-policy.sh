#!/usr/bin/env bash
set -euo pipefail

JOURNALD_DIR="/etc/systemd/journald.conf.d"
JOURNALD_PATH="${JOURNALD_DIR}/qqbot.conf"
MAINTENANCE_SCRIPT="/usr/local/sbin/qqbot-log-maintenance.sh"
MAINTENANCE_SERVICE="/etc/systemd/system/qqbot-log-maintenance.service"
MAINTENANCE_TIMER="/etc/systemd/system/qqbot-log-maintenance.timer"

if ! command -v sudo >/dev/null 2>&1; then
  echo "skip host log policy: sudo is not available"
  exit 0
fi

if ! sudo -n true >/dev/null 2>&1; then
  echo "skip host log policy: sudo -n is not available"
  exit 0
fi

sudo mkdir -p "${JOURNALD_DIR}"

sudo tee "${MAINTENANCE_SCRIPT}" >/dev/null <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

rotate_target=""
if [ -f /etc/logrotate.d/rsyslog ]; then
  rotate_target="/etc/logrotate.d/rsyslog"
elif [ -f /etc/logrotate.d/syslog ]; then
  rotate_target="/etc/logrotate.d/syslog"
fi

if [ -n "${rotate_target}" ] && [ -f /var/log/syslog ]; then
  syslog_size="$(stat -c%s /var/log/syslog 2>/dev/null || echo 0)"
  if [ "${syslog_size}" -ge $((100 * 1024 * 1024)) ]; then
    logrotate -f "${rotate_target}" || true
  fi
fi

journalctl --vacuum-size=512M --vacuum-time=14days >/dev/null 2>&1 || true
EOF

sudo chmod 0755 "${MAINTENANCE_SCRIPT}"

sudo tee "${JOURNALD_PATH}" >/dev/null <<'EOF'
[Journal]
SystemMaxUse=512M
RuntimeMaxUse=128M
MaxRetentionSec=14day
Compress=yes
EOF

sudo tee "${MAINTENANCE_SERVICE}" >/dev/null <<EOF
[Unit]
Description=QQBot host log maintenance
After=network-online.target

[Service]
Type=oneshot
ExecStart=${MAINTENANCE_SCRIPT}
EOF

sudo tee "${MAINTENANCE_TIMER}" >/dev/null <<'EOF'
[Unit]
Description=Run QQBot host log maintenance daily

[Timer]
OnCalendar=*-*-* 04:15:00
RandomizedDelaySec=30m
Persistent=true

[Install]
WantedBy=timers.target
EOF

sudo systemctl daemon-reload
sudo systemctl restart systemd-journald >/dev/null 2>&1 || true
sudo systemctl enable --now qqbot-log-maintenance.timer >/dev/null 2>&1 || true
sudo systemctl start qqbot-log-maintenance.service >/dev/null 2>&1 || true

echo "host log policy installed"

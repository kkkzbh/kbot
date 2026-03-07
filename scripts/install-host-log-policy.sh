#!/usr/bin/env bash
set -euo pipefail

JOURNALD_DIR="/etc/systemd/journald.conf.d"
JOURNALD_PATH="${JOURNALD_DIR}/qqbot.conf"
MAINTENANCE_SCRIPT="/usr/local/sbin/qqbot-log-maintenance.sh"
MAINTENANCE_SERVICE="/etc/systemd/system/qqbot-log-maintenance.service"
MAINTENANCE_TIMER="/etc/systemd/system/qqbot-log-maintenance.timer"
RSYSLOG_ROTATE_PATH="/etc/logrotate.d/qqbot-rsyslog"

if ! command -v sudo >/dev/null 2>&1; then
  echo "skip host log policy: sudo is not available"
  exit 0
fi

if ! sudo -n true >/dev/null 2>&1; then
  echo "skip host log policy: sudo -n is not available"
  exit 0
fi

sudo mkdir -p "${JOURNALD_DIR}"

sudo tee "${RSYSLOG_ROTATE_PATH}" >/dev/null <<'EOF'
/var/log/syslog
/var/log/mail.log
/var/log/kern.log
/var/log/auth.log
/var/log/user.log
/var/log/cron.log
{
  su root syslog
  daily
  rotate 14
  size 100M
  missingok
  notifempty
  compress
  delaycompress
  sharedscripts
  postrotate
    /usr/lib/rsyslog/rsyslog-rotate >/dev/null 2>&1 || systemctl kill -s HUP rsyslog.service >/dev/null 2>&1 || true
  endscript
}
EOF

sudo tee "${MAINTENANCE_SCRIPT}" >/dev/null <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

rotate_target="/etc/logrotate.d/qqbot-rsyslog"
rotate_state="/var/lib/logrotate/status-qqbot"

if [ -n "${rotate_target}" ] && [ -f /var/log/syslog ]; then
  syslog_size="$(stat -c%s /var/log/syslog 2>/dev/null || echo 0)"
  if [ "${syslog_size}" -ge $((100 * 1024 * 1024)) ]; then
    logrotate -s "${rotate_state}" "${rotate_target}" || true
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

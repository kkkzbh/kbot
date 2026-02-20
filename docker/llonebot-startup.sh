#!/bin/ash
set -euo pipefail

cd /app/llbot

FILE="default_config.json"
WEBUI_PORT="${WEBUI_PORT:-3080}"

# Keep WebUI reachable from host by listening on all interfaces.
sed -i "/\"webui\": {/,/}/ s/\"port\":\s*3080/\"port\": ${WEBUI_PORT}/g" "$FILE"
sed -i '/"webui": {/,/}/ s/"host":\s*"127.0.0.1"/"host": ""/g' "$FILE"
sed -i 's|"ffmpeg":\s*""|"ffmpeg": "/usr/bin/ffmpeg"|g' "$FILE"

mkdir -p /app/llbot/data

node --enable-source-maps ./llbot.js

# QQ AI Chat Bot

English | [简体中文](README.zh-CN.md)

A QQ chat bot built with Koishi, OneBot, LLBot, PMHQ, and ChatLuna.

## Production Host

The production bot runs on the Fedora Server host reachable from the laptop as:

```bash
ssh km6
```

The laptop checkout is for editing, building, testing, and pushing code. Do not
run the production QQ/OneBot stack on the laptop after the server migration.

## Production Runtime Layout

On `km6`, deployment uses this layout:

```text
/opt/qqbot/current        active release symlink
/opt/qqbot/releases/      immutable release directories
/opt/qqbot/shared/        persistent runtime data and secrets
/opt/qqbot/shared/.env.server
```

The system-level systemd stack is:

```text
/etc/systemd/system/qqbot.target
/etc/systemd/system/qqbot-pmhq.service
/etc/systemd/system/qqbot-llbot.service
/etc/systemd/system/qqbot-koishi.service
```

Runtime processes:

- PMHQ runs the QQ client inside Podman.
- LLBot runs on the host, connects to PMHQ, and exposes OneBot WebSocket on
  `127.0.0.1:3001`.
- Koishi runs the bot logic and console on `127.0.0.1:5140`.

## Server Requirements

`km6` must provide:

- Fedora Linux with Tailscale/SSH access from the laptop.
- Node.js `>= 22`.
- pnpm `9.15.4`.
- Yarn through Corepack or npm for the linked ChatLuna checkout.
- Podman and `podman-compose`.
- Git, Python 3, curl, unzip, ffmpeg, tar, systemd system services, and a
  headless browser executable. Fedora Server should use `chromium-headless`,
  which provides `/usr/lib64/chromium-browser/headless_shell`.

The deploy script checks these prerequisites with:

```bash
ssh km6 'bash /opt/qqbot/current/scripts/deploy/verify-host-prereqs.sh full'
```

Run the check only after the first release exists at `/opt/qqbot/current`.

## Repositories

`qqbot` depends on a sibling ChatLuna checkout during build. The production
release bundle contains both repositories.

Current repository names and branches:

```text
qqbot:   kkkzbh/bot.git, main
chatluna: kkkzbh/chatluna.git, qqbot-conversation-runtime
```

For manual source inspection on `km6`, keep checkouts under `/root/code`:

```bash
ssh km6 'mkdir -p /root/code'
ssh km6 'cd /root/code && git clone https://github.com/kkkzbh/bot.git qqbot'
ssh km6 'cd /root/code && git clone --branch qqbot-conversation-runtime https://github.com/kkkzbh/chatluna.git chatluna'
```

The service runtime still uses `/opt/qqbot/current`, not `/root/code/qqbot`.

## Build And Test Locally

Before deploying, run the checks from the laptop checkout:

```bash
cd ~/code/qqbot
pnpm typecheck
pnpm test -- --reporter=dot
pnpm build
```

If the change only touches console frontend code, `pnpm console:build` is enough
for that frontend-only check. Runtime backend, shared runtime types, console
IPC, or managed env key changes require `pnpm build`.

Test maintenance follows [`docs/testing-policy.md`](docs/testing-policy.md). CI tests
are release gates; keep them focused on stable behavior and deployment/runtime
contracts instead of incidental implementation text.

## Server Runtime Environment

Server secrets live in:

```text
/opt/qqbot/shared/.env.server
```

Use `.env.server.example` as the template. The production deploy path uses
`.env.server`; `.env.local` is reserved for developer-local tests.

Important server values:

```dotenv
ONEBOT_WS_ENDPOINT=ws://127.0.0.1:3001
KOISHI_HOST=0.0.0.0
KOISHI_PORT=5140
SQLITE_PATH=./data/koishi.db
PUPPETEER_EXECUTABLE_PATH=/usr/lib64/chromium-browser/headless_shell
LLBOT_RUNTIME_DIR=/opt/qqbot/shared/llbot-runtime
LLONEBOT_DATA_DIR=/opt/qqbot/shared/llonebot
```

Server voice input is intentionally disabled by default. If voice output is
enabled, `QQ_VOICE_TTS_BASE_URL` must point to a Tailnet-reachable TTS service,
not `127.0.0.1` on `km6`.

## Stop The Old Laptop Runtime

Before starting or restarting the production stack on `km6`, stop and disable
laptop-side user services on `knix`:

```bash
systemctl --user disable --now qqbot.target
systemctl --user disable --now qqbot-pmhq.service
systemctl --user disable --now qqbot-llbot.service
systemctl --user disable --now qqbot-koishi.service
systemctl --user disable --now qqbot-hbu-jw-tunnel.service
```

Verify that no laptop-side QQBot process remains:

```bash
systemctl --user list-units --type=service --all | grep -E 'qqbot|koishi|pmhq|llbot' || true
pgrep -af 'koishi|pmhq|llbot|llonebot' || true
```

## Operate Production On km6

Start or restart the full production stack:

```bash
ssh km6 'systemctl restart qqbot.target'
```

Check status:

```bash
ssh km6 'systemctl status qqbot.target qqbot-pmhq.service qqbot-llbot.service qqbot-koishi.service --no-pager'
```

Follow logs:

```bash
ssh km6 'journalctl -u qqbot-koishi.service -f'
```

Stop the server stack:

```bash
ssh km6 'systemctl stop qqbot.target'
```

Check runtime health:

```bash
ssh km6 'bash /opt/qqbot/current/scripts/verify-qqbot-host-runtime.sh full'
```

## Common Checks

PMHQ is not running on `km6`:

```bash
ssh km6 'podman ps --filter name=pmhq'
ssh km6 'journalctl -u qqbot-pmhq.service --no-pager -n 200'
```

LLBot WebUI from the server:

```bash
ssh km6 'curl -I http://127.0.0.1:3080/'
```

Koishi console from the server:

```bash
ssh km6 'curl -I http://127.0.0.1:5140/console'
```

OneBot WebSocket cannot connect:

```bash
ssh km6 'curl -I http://127.0.0.1:3080/'
ssh km6 'journalctl -u qqbot-llbot.service --no-pager -n 200'
```

Make sure LLBot is running, QQ login has completed, and
`ONEBOT_WS_ENDPOINT=ws://127.0.0.1:3001` is set in
`/opt/qqbot/shared/.env.server`.

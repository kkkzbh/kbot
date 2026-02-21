# QQ AI Chat Bot (Fedora + Podman)

Koishi + OneBot + LLOneBot + ChatLuna implementation for Fedora 43 (KDE/Wayland).

## 1. Prerequisites

- Node.js >= 22
- pnpm >= 9
- Podman >= 5

## 2. Install

```bash
pnpm install
cp .env.example .env
```

Edit `.env` and set at least:

- `ONEBOT_SELF_ID`
- `SQLITE_PATH`
- `OPENAI_BASE_URL`
- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `CHATLUNA_COMMAND_AUTHORITY`

## Developer docs (web)

This repository includes a VitePress documentation site for developers only.

Source files are in:

- `web/`

Run docs locally:

```bash
pnpm docs:dev
```

Build static docs:

```bash
pnpm docs:build
```

Preview built docs:

```bash
pnpm docs:preview
```

## 3. Start Koishi bot (host)

```bash
pnpm start
```

`pnpm start` will build `dist/` and run `koishi start koishi.yml`.

Koishi listens on `KOISHI_HOST:KOISHI_PORT` (default `0.0.0.0:5140`).

Koishi uses **OneBot WebSocket 正向连接** to LLBot:

- `ONEBOT_WS_ENDPOINT=ws://127.0.0.1:3001`
- Only OneBot protocol is supported in this project.

## 4. Start LLBot stack (Podman)

```bash
podman compose pull
podman compose up -d pmhq llbot
```

Official docker mode uses two services:

- `pmhq`: QQ client runtime and login session
- `llbot`: OneBot + WebUI
- Compose defaults to fully-qualified images (`docker.io/linyuchen/...`) to avoid Fedora short-name prompt issues.

Watch login logs (QR code / login progress):

```bash
podman compose logs -f pmhq
```

Open WebUI after services are up:

- `http://127.0.0.1:${LLONEBOT_WEBUI_PORT}` (default `3080`)

Then in LLBot WebUI enable **WebSocket正向** (server mode) on port `3001`.

If token is set, keep LLBot token consistent with `ONEBOT_TOKEN`.

## 5. Trigger contract (ChatLuna native)

- Runtime trigger path now follows **ChatLuna native behavior**.
- Supported passive triggers (default): `@机器人`、昵称触发、私聊触发（由 ChatLuna 配置控制）。
- Group replies are no longer constrained by the old `CHAT_ENABLED_GROUPS + mention-only` custom plugin chain.

## 6. Command authority

- `chatluna.*` command family is overridden by `@koishijs/plugin-commands`.
- Default required authority is `>= 3` (configurable by `CHATLUNA_COMMAND_AUTHORITY`).
- Passive conversation triggers still work for normal group members (subject to ChatLuna room/trigger settings).

## 7. SQLite persistence

- SQLite file DB is enabled via `@koishijs/plugin-database-sqlite`.
- Default DB path: `./data/koishi.db` (override with `SQLITE_PATH`).
- No extra DB container is required.
- ChatLuna rooms and context can persist across Koishi restarts.

## 8. Migration and rollback

- Migration result:
  - Old custom plugin source is retained: `src/plugins/group-chat.ts` / `src/plugins/group-chat-core.ts`.
  - Old plugin loading is disabled in `koishi.yml`.
  - New chain: `chatluna` + `chatluna-deepseek-adapter` + `database-sqlite` + `commands`.
- Rollback steps:
  - Re-enable the legacy `./dist/plugins/group-chat` block (template is kept as comments in `koishi.yml`).
  - Disable `chatluna` and `chatluna-deepseek-adapter` instances.
  - Keep/disable `database-sqlite` according to your rollback target.
  - Restart Koishi and verify no duplicate replies.

## 9. Quality checks

```bash
pnpm docs:build
pnpm typecheck
pnpm test
pnpm build
```

## 10. Fedora / Podman notes

- This project is built for Podman (not Docker Desktop).
- `compose.yaml` uses `:Z` on bind mount for SELinux Enforcing.
- Container should call host via `host.containers.internal`, not `127.0.0.1`.

## 11. Troubleshooting

- No reply in group:
  - Confirm ChatLuna is loaded and DeepSeek adapter is loaded.
  - Confirm trigger pattern matches ChatLuna native rules (`@`/昵称/私聊).
- OneBot WS cannot connect:
  - Confirm Koishi process is running.
  - Confirm LLBot `WebSocket正向` is enabled at `3001`.
  - Confirm `ONEBOT_WS_ENDPOINT` points to LLBot OneBot WS endpoint.
- No QR/login prompt:
  - Check `podman compose logs -f pmhq` instead of only checking `llbot` logs.
  - Confirm `pmhq` container is `Up` and healthy.
- Model call fails:
  - Check `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_MODEL`.
  - Recommended DeepSeek endpoint is `https://api.deepseek.com/v1`.
  - Check network/proxy for model endpoint.
- Command denied:
  - Confirm your account authority is >= `CHATLUNA_COMMAND_AUTHORITY`.

## 12. Run as `systemd --user` (recommended)

This project can be managed as a user-level systemd stack so you do not need to keep WebStorm open.

Installed unit files:

- `/home/kkkzbh/.config/systemd/user/qqbot-stack.service`
- `/home/kkkzbh/.config/systemd/user/qqbot-koishi.service`
- `/home/kkkzbh/.config/systemd/user/qqbot.target`

`qqbot-stack.service` starts/stops Podman compose services `pmhq` and `llbot`.
`qqbot-koishi.service` runs Koishi on host with `/home/kkkzbh/code/qqbot/.env`.
It sets `NODE_USE_ENV_PROXY=1` and proxy variables to match `~/.zshrc`:
`http_proxy` / `https_proxy` / `all_proxy` / `no_proxy`
and uppercase variants.
`qqbot.target` groups both units for one-command start/stop.

Reload units after changes:

```bash
systemctl --user daemon-reload
```

Start or stop the full stack:

```bash
systemctl --user start qqbot.target
systemctl --user stop qqbot.target
```

Enable auto start on login:

```bash
systemctl --user enable qqbot.target
```

Enable linger so services can run without an active desktop login:

```bash
loginctl enable-linger kkkzbh
```

## 13. `systemd` logs and troubleshooting

Check unit status:

```bash
systemctl --user status qqbot-stack.service
systemctl --user status qqbot-koishi.service
systemctl --user status qqbot.target
```

Follow Koishi logs:

```bash
journalctl --user -u qqbot-koishi.service -f
```

Follow container login logs:

```bash
podman compose -f /home/kkkzbh/code/qqbot/compose.yaml logs -f pmhq
```

Common issues:

- `qqbot-koishi.service` fails with `ExecStart`: confirm configured pnpm path exists (current file uses `/home/kkkzbh/.local/bin/pnpm`; check with `which pnpm`).
- `qqbot-stack.service` fails: confirm Podman compose plugin is installed and `compose.yaml` exists.
- Service not started after reboot: confirm `systemctl --user is-enabled qqbot.target` and `loginctl show-user kkkzbh | grep Linger`.

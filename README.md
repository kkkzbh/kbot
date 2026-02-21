# QQ Group AI Chat Bot (Fedora + Podman)

Koishi + OneBot + LLOneBot implementation for Fedora 43 (KDE/Wayland).

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
- `CHAT_ENABLED_GROUPS`
- `OPENAI_BASE_URL`
- `OPENAI_API_KEY`
- `OPENAI_MODEL`

Optional prompt settings:

- `CHAT_SYSTEM_PROMPT`: single-line prompt.
- `CHAT_SYSTEM_PROMPT_FILE`: prompt file path for long or multi-line prompt (recommended).

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

## 5. Trigger rule

- Only enabled groups in `CHAT_ENABLED_GROUPS` can chat.
- Trigger format: `@机器人 + 文本`.
- Group members in enabled groups can trigger.
- Reply format: bot will `@` the sender and return model output.

## 6. System Prompt

- `.env` should keep one `KEY=VALUE` per line. Long multi-line prompt should be stored in file.
- Set `CHAT_SYSTEM_PROMPT_FILE` to use a file as system prompt.
- If both are set, `CHAT_SYSTEM_PROMPT_FILE` takes precedence over `CHAT_SYSTEM_PROMPT`.
- Relative file paths are resolved from current working directory (project root when running `pnpm start`).

## 7. Quality checks

```bash
pnpm docs:build
pnpm typecheck
pnpm test
pnpm build
```

## 8. Fedora / Podman notes

- This project is built for Podman (not Docker Desktop).
- `compose.yaml` uses `:Z` on bind mount for SELinux Enforcing.
- Container should call host via `host.containers.internal`, not `127.0.0.1`.

## 9. Troubleshooting

- No reply in group:
  - Confirm group id is in `CHAT_ENABLED_GROUPS`.
  - Confirm message is `@` mention trigger.
- OneBot WS cannot connect:
  - Confirm Koishi process is running.
  - Confirm LLBot `WebSocket正向` is enabled at `3001`.
  - Confirm `ONEBOT_WS_ENDPOINT` points to LLBot OneBot WS endpoint.
- No QR/login prompt:
  - Check `podman compose logs -f pmhq` instead of only checking `llbot` logs.
  - Confirm `pmhq` container is `Up` and healthy.
- Model call fails:
  - Check `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_MODEL`.
  - For long prompt, prefer `CHAT_SYSTEM_PROMPT_FILE` instead of putting multi-line content directly in `.env`.
  - Check network/proxy for model endpoint.

## 10. Run as `systemd --user` (recommended)

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

## 11. `systemd` logs and troubleshooting

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

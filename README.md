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

ChatLuna long-memory does not read host `syslog`/`journalctl` logs as memory.
Long-memory uses the configured vector store plus embeddings instead.

## 4. Start LLBot stack (Podman)

```bash
podman compose pull
podman compose up -d ollama pmhq llbot
```

Official docker mode uses three services:

- `ollama`: local embedding service for ChatLuna long-memory (`nomic-embed-text:latest` by default)
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

`ollama` now starts through an explicit shell entrypoint so the image can both
serve on `11434` and pre-pull the configured embedding model on startup.

`qqbot-stack.service` also exports a dedicated Podman `containers.conf` with
`keyring = false` to avoid rootless `runc` startup failures caused by exhausted
session key quotas on the host.

## 5. Trigger contract

- Runtime trigger path = `task-automation` (优先) + `group-natural-trigger` + ChatLuna native。
- 群聊可自然触发，无需 `@` 或句首昵称：
  - 任意消息有 `25%` 概率直接触发对话。
  - 否则走“规则 + 模型”触发判定。
  - 会话焦点窗口 `5` 分钟（同用户连续聊天更自然）。
  - 机器人最小回复间隔 `2s`。
  - 反刷屏：同一用户 `10s` 内 `10` 条消息，`3` 分钟内忽略该用户。
- 昵称触发保留，默认别名包含：
  - `祥子`、`祥`、`丰川`、`丰川祥子`、`saki`、`saki酱`、`sakiko`。
- 新增自动化任务插件：
  - 自动化意图可在白名单群和私聊中通过自然语言触发，不要求必须 `@`。
  - 自动化命中时优先执行任务逻辑；未命中则继续走原对话流程。
  - 群任务触发时在原群 `@创建者`，私聊任务触发时私聊发送。
  - 白名单群来源：`CHAT_ENABLED_GROUPS`。

## 6. Command authority

- `chatluna.*` command family is overridden by `@koishijs/plugin-commands`.
- Default required authority is `>= 3` (configurable by `CHATLUNA_COMMAND_AUTHORITY`).
- Passive conversation triggers still work for normal group members (subject to ChatLuna room/trigger settings).
- 任务命令（`task.*`）默认按 `TASK_AUTOMATION_PERMISSION=all` 允许群成员使用。
- 可切换 `TASK_AUTOMATION_PERMISSION=authority3` 仅允许高权限用户使用。

## 7. Task automation commands

- `task.list` 查看当前会话任务。
- `task.add.once <time> -- <message>` 创建一次性任务（例如 `task.add.once 明天8点 -- 交周报`）。
- `task.add.cron <cron> -- <message>` 创建周期任务（例如 `task.add.cron 0 9 * * 1 -- 周会提醒`）。
- `task.pause <id>` 暂停任务。
- `task.resume <id>` 恢复任务。
- `task.del <id>` 删除任务。

## 8. SQLite persistence

- SQLite file DB is enabled via `@koishijs/plugin-database-sqlite`.
- Default DB path: `./data/koishi.db` (override with `SQLITE_PATH`).
- No extra DB container is required.
- ChatLuna rooms and context can persist across Koishi restarts.
- 自动化任务也持久化到同一 SQLite 数据库。

## 9. Legacy removal status

- Deprecated `group-chat` implementation has been removed:
  - `src/plugins/group-chat.ts`
  - `src/plugins/group-chat-core.ts`
  - `tests/group-chat.test.ts`
  - `src/types/chat.ts`
- Current conversation chain:
  - `chatluna` + `chatluna-deepseek-adapter` + `chatluna-model-guard` + `database-sqlite` + `commands`
- Task automation extension chain:
  - `cron` + `task-automation` (independent of ChatLuna trigger path)

## 10. Group natural trigger environment variables

- `CHAT_NATURAL_TRIGGER_ENABLED`：是否开启群聊自然触发（默认 `true`）。
- `CHAT_NATURAL_TRIGGER_GROUPS`：自然触发生效群（逗号分隔，空表示所有群）。
- `CHAT_NATURAL_TRIGGER_ALIASES`：别名列表（逗号分隔）。
- `CHAT_NATURAL_TRIGGER_DIRECT_PROBABILITY`：任意消息直接触发概率（默认 `0.25`）。
- `CHAT_NATURAL_TRIGGER_FOCUS_WINDOW_MS`：会话焦点窗口（默认 `300000`）。
- `CHAT_NATURAL_TRIGGER_REPLY_INTERVAL_MS`：机器人最小回复间隔（默认 `2000`）。
- `CHAT_NATURAL_TRIGGER_SPAM_WINDOW_MS`：刷屏判定窗口（默认 `10000`）。
- `CHAT_NATURAL_TRIGGER_SPAM_THRESHOLD`：刷屏判定阈值（默认 `10`）。
- `CHAT_NATURAL_TRIGGER_SPAM_MUTE_MS`：刷屏忽略时长（默认 `180000`）。
- `CHAT_NATURAL_TRIGGER_DECISION_ENABLED`：是否启用模型判定（默认 `true`）。
- `CHAT_NATURAL_TRIGGER_DECISION_BASE_URL` / `CHAT_NATURAL_TRIGGER_DECISION_API_KEY` / `CHAT_NATURAL_TRIGGER_DECISION_MODEL`：
  - 未设置时复用 `OPENAI_BASE_URL` / `OPENAI_API_KEY` / `OPENAI_MODEL`。
- `CHAT_NATURAL_TRIGGER_DECISION_TIMEOUT_MS`：模型判定超时（默认 `4000`）。
- `CHAT_NATURAL_TRIGGER_DECISION_MIN_CONFIDENCE`：模型判定最小置信度（默认 `0.62`）。

## 11. Task automation environment variables

- `TASK_AUTOMATION_LISTEN_PRIVATE`：是否允许私聊自动化意图（默认 `true`）。
- `TASK_AUTOMATION_PERMISSION`：`all` 或 `authority3`（默认 `all`）。
- `TASK_AUTOMATION_INTENT_ENABLED`：是否开启自然语言意图识别（默认 `true`）。
- `TASK_AUTOMATION_INTENT_MIN_CONFIDENCE`：模型兜底最小置信度（默认 `0.78`）。
- `TASK_AUTOMATION_INTENT_BASE_URL` / `TASK_AUTOMATION_INTENT_API_KEY` / `TASK_AUTOMATION_INTENT_MODEL`：
  - 未设置时复用 `OPENAI_BASE_URL` / `OPENAI_API_KEY` / `OPENAI_MODEL`。
- `TASK_AUTOMATION_INTENT_TIMEOUT_MS`：意图模型超时（默认 `12000`）。
- `TASK_AUTOMATION_POLL_MS`：一次性任务轮询间隔（默认 `30000`）。
- `TASK_AUTOMATION_MAX_TASKS_PER_USER`：单用户任务上限（默认 `20`）。
- `TASK_AUTOMATION_DELIVERY_BASE_URL` / `TASK_AUTOMATION_DELIVERY_API_KEY` / `TASK_AUTOMATION_DELIVERY_MODEL`：
  - 到点发送内容生成模型配置；默认复用 `OPENAI_BASE_URL` / `OPENAI_API_KEY`，模型默认 `deepseek-reasoner`。
- `TASK_AUTOMATION_DELIVERY_TIMEOUT_MS`：到点发送内容生成超时（默认 `18000`）。
- `TASK_AUTOMATION_DELIVERY_MAX_TOKENS`：到点发送内容 `max_tokens`（默认 `10000`）。
- `TASK_AUTOMATION_DELIVERY_SYSTEM_PROMPT`：到点发送内容专用 system prompt（可选覆盖默认值）。
- `TASK_AUTOMATION_CHAT_REPLY_MODEL`：自然语言创建任务时的回复模型（默认 `deepseek-reasoner`）。
- `TASK_AUTOMATION_CHAT_REPLY_TIMEOUT_MS`：创建任务自然回复超时（默认 `12000`）。
- `TASK_AUTOMATION_CHAT_REPLY_MAX_TOKENS`：创建任务自然回复 `max_tokens`（默认 `10000`）。
- `TASK_AUTOMATION_CHAT_REPLY_SYSTEM_PROMPT`：创建任务自然回复专用 system prompt（可选覆盖默认值）。

## 12. Pokemon battle plugin

- `koishi-plugin-pokemon-battle` is loaded through local bridge plugin `./dist/plugins/pokemon-battle-bridge`.
- CI 环境默认禁用该插件（除非显式设置 `POKEMON_BATTLE_ENABLED=true`），避免 CI 触发资源下载。
- 关键词优先路由：命中宝可梦指令关键词时，优先进入宝可梦命令链路；未命中才进入普通聊天链路。
- Runtime dependencies are provided by:
  - `koishi-plugin-downloads` (`downloads` service)
  - `koishi-plugin-canvas` (`canvas` service)
  - existing `database-sqlite` + `cron`
- Default command access is open to all group members (no extra authority gate).
- Environment variables:
  - `POKEMON_BATTLE_ENABLED`：whether to enable pokemon plugin (default `true`).
  - `POKEMON_BATTLE_IMAGE_SOURCE`：pokemon image base URL (default `https://raw.githubusercontent.com/MAIxxxIAM/pokemonFusionImage/main`).
  - `POKEMON_DOWNLOADS_OUTPUT`：downloads plugin output directory (default `./downloads`).
- Quick rollback:
  - set `POKEMON_BATTLE_ENABLED=false`, then restart `qqbot.target`.
- Common issues:
  - startup reports missing `downloads` service: confirm `downloads:*` exists in `koishi.yml`.
  - startup reports missing `canvas` service or puppeteer/chrome errors: confirm `canvas:*` exists in `koishi.yml`.
  - pokemon image text shows square/tofu glyphs: ensure `downloads` subdirs are traversable (`x` bit). Bridge plugin auto-fixes `bucket2-*` mode, auto-registers `zpix.ttf`, prefers bundled `NotoSansCJKsc-Regular.otf` as CJK fallback, injects fallback font families for `zpix`, and normalizes known missing symbols (for example `：` -> `:`).
  - rare nickname glyphs still show tofu: confirm deploy contains `src/plugins/assets/fonts/NotoSansCJKsc-Regular.otf` and check koishi logs for `pokemon fallback ready` / `pokemon fallback missing` before considering server font installation.
  - image load failure/timeouts: switch `POKEMON_BATTLE_IMAGE_SOURCE` to gitee source:
    `https://gitee.com/maikama/pokemon-fusion-image/raw/master`.
- Deploy note:
  - `Deploy` workflow always overwrites server `.env` from secret `QQBOT_DOTENV`, so update this secret after changing pokemon env vars.

## 13. Quality checks

```bash
pnpm docs:build
pnpm typecheck
pnpm test
pnpm build
```

## 14. Fedora / Podman notes

- This project is built for Podman (not Docker Desktop).
- `compose.yaml` uses `:Z` on bind mount for SELinux Enforcing.
- Container should call host via `host.containers.internal`, not `127.0.0.1`.

## 15. Troubleshooting

- No reply in group:
  - Confirm ChatLuna is loaded and DeepSeek adapter is loaded.
  - Confirm trigger pattern matches ChatLuna native rules (`@`/昵称/私聊).
- 自动化未触发：
  - 确认 `./dist/plugins/task-automation` 与 `cron` 已在 `koishi.yml` 启用。
  - 确认当前群在 `CHAT_ENABLED_GROUPS` 白名单。
  - 确认意图模型配置可用（或已复用 `OPENAI_*`）。
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
  - `chatluna.*`：确认账号 authority >= `CHATLUNA_COMMAND_AUTHORITY`。
  - `task.*`：若 `TASK_AUTOMATION_PERMISSION=authority3`，确认账号 authority >= 3。

## 16. Run as `systemd --user` (recommended)

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

## 17. `systemd` logs and troubleshooting

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
- Host logs grow too quickly:
  - deploy installs `/etc/systemd/journald.conf.d/qqbot.conf` plus a root timer `qqbot-log-maintenance.timer` when `sudo -n` is available
  - journald is capped to `512M` persistent + `128M` runtime
  - the maintenance timer runs daily, uses a dedicated `logrotate` policy with `su root syslog` when `/var/log/syslog` exceeds `100M`, and vacuums old journal data

## 18. GitHub CI/CD auto deploy (push to `main`)

This repo now includes:

- `/.github/workflows/ci.yml`
- `/.github/workflows/deploy.yml`

Behavior:

- `CI` runs on every `push` / `pull_request` (`pnpm typecheck`, `pnpm test`, `pnpm build`).
- `Deploy` runs on `push` to `main` (or manual `workflow_dispatch`).
- `Deploy` SSHes to your server, `rsync`s project files, then runs `pnpm install`, `pnpm build`, and restarts `qqbot.target`.

### 18.1 GitHub Actions secrets (required)

- `QQBOT_SERVER_HOST`: deploy server host/IP
- `QQBOT_SERVER_USER`: SSH login user
- `QQBOT_SSH_PRIVATE_KEY`: private key used by GitHub Actions to login server
- `QQBOT_SSH_KNOWN_HOSTS`: optional but recommended (`ssh-keyscan` output)
- `QQBOT_DOTENV`: production `.env` full content (multiline secret)

### 18.2 GitHub Actions variables (optional)

- `QQBOT_SERVER_PORT` (default: `22`)
- `QQBOT_SERVER_APP_DIR` (default: `/opt/qqbot/current`)
- `QQBOT_SYSTEMD_TARGET` (default: `qqbot.target`)

### 18.3 One-time server preparation

1. Prepare deploy directory (example uses default path):

```bash
sudo mkdir -p /opt/qqbot/current
sudo chown -R <server_user>:<server_user> /opt/qqbot
```

2. Install runtime dependencies on server (Ubuntu example):

```bash
sudo apt-get update
sudo apt-get install -y podman podman-compose
```

3. Enable linger so `systemd --user` services survive logout:

```bash
sudo loginctl enable-linger <server_user>
```

4. In GitHub repo settings, set secret `QQBOT_DOTENV` to your production `.env` content.

`Deploy` will sync this secret to `${QQBOT_SERVER_APP_DIR}/.env` every run.

5. Ensure your target user can run `sudo -n` for `loginctl enable-linger` (optional but recommended).

6. `Deploy` will auto-provision user units (`qqbot-stack.service`, `qqbot-koishi.service`, `qqbot.target`)
when `QQBOT_SYSTEMD_TARGET=qqbot.target`.

7. If you use a custom target (not `qqbot.target`), manage that unit yourself and keep
`QQBOT_SYSTEMD_TARGET` consistent.

8. Ensure your `systemd --user` units are enabled:

```bash
systemctl --user daemon-reload
systemctl --user enable qqbot.target
loginctl enable-linger <server_user>
```

### 18.4 First push to GitHub

```bash
git remote add origin git@github.com:kkkzbh/kbot.git
git branch -M main
git push -u origin main
```

After this push, GitHub Actions will run CI and then deploy automatically.

### 18.5 Manual deploy trigger

GitHub repo -> `Actions` -> `Deploy` -> `Run workflow`.

### 18.6 Common deploy failures

- `User systemd bus not available`:
  - run `loginctl enable-linger <server_user>` on server, and ensure user service session bus exists.
- `pnpm is not installed on target host`:
  - install Node.js/corepack on server, or ensure `pnpm` is in the deploy user's `PATH`.
- `podman-compose is not installed on target host`:
  - install Podman and `podman-compose` on server.
- SSH failure:
  - verify `QQBOT_*` secrets and `known_hosts` content.

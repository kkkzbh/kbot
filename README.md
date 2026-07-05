# QQ AI Chat Bot

English | [简体中文](README.zh-CN.md)

A QQ chat bot built with Koishi, OneBot, LLBot, PMHQ, and ChatLuna.

## Runtime Boundary

The repository is a source, build, and runtime workspace.

Keep generated outputs and local runtime state out of Git:

```text
build/
dist/
.tmp/
.runtime/
data/koishi.db
data/logs/
node_modules/
```

If a file is generated every time by build, test, dev, or runtime commands and is safe to regenerate, ignore it instead of repeatedly cleaning it by hand.

## Local Development

The checkout expects a sibling ChatLuna checkout:

```text
~/code/qqbot
~/code/chatluna
```

Install dependencies and verify the workspace from `~/code/qqbot`:

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

`pnpm build` writes runtime artifacts to `dist/`. `dist/` is ignored and should not be committed.

If a change only touches the console frontend, `pnpm console:build` is enough for that frontend-only check. Runtime backend, shared runtime types, console IPC, or managed env key changes used by `koishi.yml` require `pnpm build`.

## Runtime Commands

Developer-local runtime:

```bash
pnpm start:local
```

Server-style runtime from this checkout:

```bash
pnpm start:server
```

Startup performs a preflight check for linked ChatLuna packages and built runtime artifacts. It does not run a build implicitly.

## Environment Files

Use the templates as ownership boundaries:

```text
.env.example          developer-local template; copy to .env.local
.env.server.example   server runtime template; copy to the server .env.server
```

Keep secrets in local env files. Do not commit `.env.local`, `.env.server`, `.runtime/`, or runtime databases.

Important runtime values:

```dotenv
ONEBOT_WS_ENDPOINT=ws://127.0.0.1:3001
KOISHI_HOST=0.0.0.0
KOISHI_PORT=5140
SQLITE_PATH=./data/koishi.db
LLBOT_RUNTIME_DIR=./.runtime/llbot
LLONEBOT_DATA_DIR=./.runtime/llonebot
```

Server voice input is intentionally disabled by default. If voice output is enabled on the server, `QQ_VOICE_TTS_BASE_URL` must point to a Tailnet-reachable TTS service, not `127.0.0.1` on the server.

## Runtime Helpers

Current runtime helpers are direct workspace scripts:

```text
scripts/run-koishi-with-env.sh
scripts/podman-pmhq-service.sh
scripts/run-llbot-host.sh
scripts/verify-qqbot-host-runtime.sh
scripts/server-recover-qq-login.sh
scripts/run-voice-tts-local.sh
scripts/publish-voice-tts-tailnet.sh
```

These scripts are direct runtime helpers for this workspace.

## Testing Policy

Test maintenance follows [`docs/testing-policy.md`](docs/testing-policy.md). Keep tests focused on stable user behavior, runtime contracts, artifact shape, and ownership boundaries.

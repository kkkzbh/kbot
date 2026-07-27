# QQ AI Chat Bot

English | [简体中文](README.zh-CN.md)

A QQ chat bot built with Koishi, OneBot, LLBot, PMHQ, and ChatLuna.

## Production Deploy

Production runs on `km6` as one active server instance for the full PMHQ, LLBot, and Koishi stack. Deployment is maintained in [`deploy/README.md`](deploy/README.md).

```text
/opt/qqbot/app       active application instance
/opt/qqbot/data      runtime data and caches
/opt/qqbot/shared    env files and server-maintained configuration
```

Deploy from the local checkout:

```bash
cd ~/code/qqbot
deploy/deploy.sh km6
```

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

For frontend-only admin changes, run both `pnpm admin:typecheck` and `pnpm admin:build`. Runtime backend, shared runtime types, Admin API contract, or managed env key changes used by `koishi.yml` require `pnpm build`.

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
KOISHI_HOST=127.0.0.1
KOISHI_PORT=5140
SQLITE_PATH=./data/koishi.db
LLBOT_RUNTIME_DIR=./.runtime/llbot
LLONEBOT_DATA_DIR=./.runtime/llonebot
```

Server voice input is intentionally disabled by default. If voice output is enabled on the server, `QQ_VOICE_TTS_BASE_URL` must point to a Tailnet-reachable TTS service, not `127.0.0.1` on the server.

## Independent Admin Workspace

The Koishi process serves the standalone SPA directly at `/`; the SPA uses the same-origin `/api/admin/v1` runtime API and has no Koishi Console dependency. Bot-owned HTTP routes such as `/api/**`, campus binding pages, and Storage remain owned by their respective plugins.

Configure the browser-facing origin explicitly before startup:

```dotenv
QQBOT_ADMIN_ORIGIN=https://actual-admin-origin.example
QQBOT_ADMIN_SSH_ORIGIN=http://127.0.0.1:5140
```

`QQBOT_ADMIN_ORIGIN` must match the Tailnet browser Origin. `QQBOT_ADMIN_SSH_ORIGIN` must match the browser Origin produced by the SSH local forward. The API validates both Hosts on every request and both Origins on every mutation. Production binds Koishi to loopback and publishes the admin workspace through its Tailnet-only Tailscale Serve endpoint. Secret fields only expose whether a value is configured.

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

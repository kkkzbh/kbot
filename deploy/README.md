# QQBot Production Deploy

Production is deployed as one clean instance on `km6`. The server runs the full stack: PMHQ, LLBot, and Koishi.

## Layout

```text
/opt/qqbot/
  app/        active application instance, replaced on each deploy
  data/       runtime data, preserved across deploys
  shared/     env files and secrets, preserved across deploys
  incoming/   upload area, cleared after deploy
  .staging/   install transaction area, cleared after deploy
```

`app` contains the bundled `qqbot` and `chatluna` trees. `data` contains databases, QQ login state, LLBot runtime state, ChatLuna storage, presets, stickers, and caches. `shared` contains `.env.server` and the generated `.env.runtime`.

The deploy scripts may replace only `/opt/qqbot/app` and may clear only `/opt/qqbot/incoming` and `/opt/qqbot/.staging`. They must preserve `/opt/qqbot/data` and `/opt/qqbot/shared`.

## First-time server setup

Create the local server env file before the first deploy:

```bash
cp .env.server.example .env.server
```

Fill the real server values in `.env.server`. `deploy/deploy.sh` creates the remote `/opt/qqbot` directories and installs `.env.server` to `/opt/qqbot/shared/.env.server` when the remote file does not exist. Existing remote server env is preserved.

## Deploy

From the local checkout:

```bash
cd ~/code/qqbot
deploy/deploy.sh km6
```

The local script first removes any stale partial upload at `/opt/qqbot/incoming/qqbot.tar.gz.upload`, then compares the current `qqbot` and `chatluna` commit SHAs with `/opt/qqbot/app/build-manifest.json`. If the server already has the same pair of commits, deploy exits without running typecheck, tests, build, upload, or install. Set `QQBOT_FORCE_DEPLOY=1` to force a full deploy.

When a full deploy is required, the script runs typecheck, tests, build, packages `qqbot` with the sibling `../chatluna` checkout, uploads one tarball, and asks the server installer to replace the single active instance. LLBot release zips are cached locally under `.tmp/deploy-cache`.

## Services

Systemd owns the full stack:

```text
qqbot.target
  qqbot-pmhq.service
  qqbot-llbot.service
  qqbot-koishi.service
```

PMHQ starts the QQ client container. LLBot connects to PMHQ and exposes OneBot WebSocket on `127.0.0.1:3001`. Koishi connects to LLBot and serves the bot and console.

## Operations

```bash
ssh km6 'systemctl status qqbot.target qqbot-pmhq.service qqbot-llbot.service qqbot-koishi.service --no-pager'
ssh km6 'journalctl -u qqbot-koishi.service -f'
ssh km6 'systemctl restart qqbot.target'
ssh km6 'systemctl stop qqbot.target'
ssh km6 'bash /opt/qqbot/app/qqbot/deploy/verify.sh full'
```

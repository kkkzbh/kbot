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

Install the Cloudflare Tunnel token on the server before deploying the HBU JW public bind page:

```bash
cloudflared tunnel token qqbot-hbu-jw | ssh km6 'install -d -m 700 /etc/cloudflared && umask 177 && cat > /etc/cloudflared/qqbot-hbu-jw.token'
```

## Deploy

From the local checkout:

```bash
cd ~/code/qqbot
deploy/deploy.sh km6
```

The local script first removes any stale partial upload at `/opt/qqbot/incoming/qqbot.tar.gz.upload`, then compares the current `qqbot` and `chatluna` commit SHAs with `/opt/qqbot/app/build-manifest.json`. If the server already has the same pair of commits, deploy exits without running typecheck, tests, build, upload, or install. Set `QQBOT_FORCE_DEPLOY=1` to force a full deploy.

When a full deploy is required, the script runs typecheck, tests, build, packages `qqbot` with the sibling `../chatluna` checkout, uploads one tarball, and asks the server installer to replace the single active instance. LLBot release zips are cached locally under `.tmp/deploy-cache`.

## Services

Systemd owns the application stack, while PMHQ is an independent stateful QQ login service:

```text
qqbot-pmhq.service
  owns the long-lived QQ desktop container and login profile

qqbot.target
  qqbot-llbot.service
  qqbot-koishi.service
  cloudflared-qqbot-hbu-jw.service
```

PMHQ starts the QQ client container. LLBot connects to PMHQ and exposes OneBot WebSocket on `127.0.0.1:3001`. Koishi connects to LLBot and serves the bot and console. The Cloudflare Tunnel unit uses `/etc/cloudflared/qqbot-hbu-jw.token` and exposes the HBU JW bind page through `jw.kkkzbh.cn`.

Do not restart or recreate PMHQ during ordinary deploys, code updates, or bot restarts. PMHQ contains the QQ desktop device profile; touching it can make QQ treat the server as a new device. Restart LLBot and Koishi for normal runtime recovery.

## Operations

```bash
ssh km6 'systemctl status qqbot.target qqbot-pmhq.service qqbot-llbot.service qqbot-koishi.service cloudflared-qqbot-hbu-jw.service --no-pager'
ssh km6 'journalctl -u qqbot-koishi.service -f'
ssh km6 'journalctl -u cloudflared-qqbot-hbu-jw.service -f'
ssh km6 'systemctl restart qqbot-llbot.service qqbot-koishi.service'
ssh km6 'systemctl restart qqbot.target'
ssh km6 'systemctl stop qqbot.target'
ssh km6 'bash /opt/qqbot/app/qqbot/deploy/verify.sh full'
```

Use `systemctl restart qqbot-pmhq.service` only for explicit QQ login recovery. Use `scripts/podman-pmhq-service.sh recreate` only when you intentionally accept a new QQ device/profile risk.

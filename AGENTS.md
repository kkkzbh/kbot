# Agent Notes

- Production runs on the server reachable as `ssh km6`. Treat the local `knix` checkout as an editing, build, and test workspace only.
- Do not start or restart the production QQBot stack on `knix`. Production service operations must target `km6` over SSH.
- Server deployment uses one active instance: `/opt/qqbot/app` for code, `/opt/qqbot/data` for runtime data, and `/opt/qqbot/shared` for env files.
- Keep server secrets in the server runtime `.env.server`; use `.env.local` only for developer-local tests.
- Avoid running the same QQ/OneBot stack on both `knix` and `km6`. Stop local `qqbot-*` user services before starting the server stack.
- Server service management uses system-level systemd units: `qqbot.target`, `qqbot-pmhq.service`, `qqbot-llbot.service`, `qqbot-koishi.service`, and `cloudflared-qqbot-hbu-jw.service` under `/etc/systemd/system`.
- Production service commands use `systemctl ...` and `journalctl -u ...`; do not use `systemctl --user` for server runtime operations.
- The HBU JW public bind page uses the token-file Cloudflare Tunnel service `cloudflared-qqbot-hbu-jw.service`; do not replace it with CLI-managed credentials JSON.
- km6 runs the Tailnet-only `hbu-webvpn-agent`; route its configured account through the authenticated loopback broker and never create a second WebVPN session for that account.
- If a change touches runtime backend code, shared runtime types, console IPC, or managed env keys used by `koishi.yml` through `./dist/plugins/**`, verify with `pnpm build` before handing it off. `pnpm console:build` is only enough for frontend-only console changes.
- Follow `docs/testing-policy.md` when adding or changing tests. Keep assertions tied to stable user behavior, runtime contracts, or artifact boundaries. Do not add broad string snapshots, unrelated cross-domain assertions, or duplicate checks that mainly increase failure noise.

# Agent Notes

- Production runs on the server reachable as `ssh km6`. Treat the local `knix` checkout as an editing, build, and test workspace only.
- Do not start or restart the production QQBot stack on `knix`. Production service operations must target `km6` over SSH.
- The server deployment layout is `/opt/qqbot/current` for the active release and `/opt/qqbot/shared` for persistent runtime state. Keep server secrets in `/opt/qqbot/shared/.env.server`.
- Use `.env.server` for server runtime. Use `.env.local` only for developer-local tests.
- Avoid running the same QQ/OneBot stack on both `knix` and `km6`. Stop local `qqbot-*` user services before starting the server stack.
- Server service management uses system-level systemd units: `qqbot.target`, `qqbot-pmhq.service`, `qqbot-llbot.service`, and `qqbot-koishi.service` under `/etc/systemd/system`.
- Production service commands use `systemctl ...` and `journalctl -u ...`; do not use `systemctl --user` for the server deployment path.
- If a change touches runtime backend code, shared runtime types, console IPC, or managed env keys used by `koishi.yml` through `./dist/plugins/**`, verify with `pnpm build` before handing it off. `pnpm console:build` is only enough for frontend-only console changes.
- Follow `docs/testing-policy.md` when adding or changing tests. CI tests are release gates; keep assertions tied to stable user behavior, runtime contracts, or deployment phase boundaries. Do not add broad string snapshots, unrelated cross-domain assertions, or duplicate checks that mainly increase failure noise.

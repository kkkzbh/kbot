# QQ AI Chat Bot

[English](README.md) | 简体中文

一个基于 Koishi、OneBot、LLBot、PMHQ 和 ChatLuna 构建的 QQ 聊天机器人。

## 生产主机

生产环境机器人运行在 Fedora Server 主机上，从笔记本访问方式为：

```bash
ssh km6
```

笔记本上的 checkout 只用于编辑、构建、测试和推送代码。迁移到服务器后，不再在笔记本上运行生产 QQ/OneBot 栈。

## 生产运行时结构

`km6` 上的部署布局：

```text
/opt/qqbot/current        当前 release symlink
/opt/qqbot/releases/      不可变 release 目录
/opt/qqbot/shared/        持久运行时数据和密钥
/opt/qqbot/shared/.env.server
```

系统级 systemd 栈：

```text
/etc/systemd/system/qqbot.target
/etc/systemd/system/qqbot-pmhq.service
/etc/systemd/system/qqbot-llbot.service
/etc/systemd/system/qqbot-koishi.service
```

运行时进程：

- PMHQ 在 Podman 中运行 QQ 客户端。
- LLBot 在宿主机运行，连接 PMHQ，并在 `127.0.0.1:3001` 暴露 OneBot WebSocket。
- Koishi 运行机器人逻辑和控制台，地址是 `127.0.0.1:5140`。

## 服务器环境要求

`km6` 需要提供：

- Fedora Linux，并且笔记本可通过 Tailscale/SSH 访问。
- Node.js `>= 22`。
- pnpm `9.15.4`。
- 通过 Corepack 或 npm 提供的 Yarn，用于 linked ChatLuna checkout。
- Podman 和 `podman-compose`。
- Git、Python 3、curl、unzip、ffmpeg、tar、systemd system services，以及 headless browser 可执行文件。Fedora Server 推荐使用 `chromium-headless`，它提供 `/usr/lib64/chromium-browser/headless_shell`。

部署脚本通过下面的脚本检查宿主机前置条件：

```bash
ssh km6 'bash /opt/qqbot/current/scripts/deploy/verify-host-prereqs.sh full'
```

该检查需要首个 release 已经存在于 `/opt/qqbot/current` 后再执行。

## 仓库

`qqbot` 构建时依赖旁边的 ChatLuna checkout。生产 release bundle 会同时包含两个仓库。

当前仓库和分支：

```text
qqbot:   kkkzbh/bot.git, main
chatluna: kkkzbh/chatluna.git, qqbot-conversation-runtime
```

如果只需要在 `km6` 上手动查看源码，可以把 checkout 放在 `/root/code`：

```bash
ssh km6 'mkdir -p /root/code'
ssh km6 'cd /root/code && git clone https://github.com/kkkzbh/bot.git qqbot'
ssh km6 'cd /root/code && git clone --branch qqbot-conversation-runtime https://github.com/kkkzbh/chatluna.git chatluna'
```

服务运行时使用 `/opt/qqbot/current`，不使用 `/root/code/qqbot`。

## 本地构建和测试

部署前，在笔记本 checkout 中运行：

```bash
cd ~/code/qqbot
pnpm typecheck
pnpm test -- --reporter=dot
pnpm build
```

如果只改 console 前端，`pnpm console:build` 足够覆盖该前端检查。涉及 runtime backend、shared runtime types、console IPC，或 `koishi.yml` 使用的 managed env key 时，需要运行 `pnpm build`。

测试维护遵循 [`docs/testing-policy.md`](docs/testing-policy.md)。CI 测试是 release gate，应聚焦稳定行为、部署边界和运行时契约，不用零散实现文本做大范围断言。

## 服务器运行时环境

服务器密钥文件位置：

```text
/opt/qqbot/shared/.env.server
```

使用 `.env.server.example` 作为模板。生产部署路径使用 `.env.server`；`.env.local` 仅用于 developer-local 测试。

关键服务器配置：

```dotenv
ONEBOT_WS_ENDPOINT=ws://127.0.0.1:3001
KOISHI_HOST=0.0.0.0
KOISHI_PORT=5140
SQLITE_PATH=./data/koishi.db
PUPPETEER_EXECUTABLE_PATH=/usr/lib64/chromium-browser/headless_shell
LLBOT_RUNTIME_DIR=/opt/qqbot/shared/llbot-runtime
LLONEBOT_DATA_DIR=/opt/qqbot/shared/llonebot
```

服务器默认关闭语音输入。如果开启语音输出，`QQ_VOICE_TTS_BASE_URL` 必须指向 Tailnet 可访问的 TTS 服务，不能指向 `km6` 上的 `127.0.0.1`。

## 停止旧的笔记本运行时

在 `km6` 上启动或重启生产栈前，先在 `knix` 上停止并禁用本地 user services：

```bash
systemctl --user disable --now qqbot.target
systemctl --user disable --now qqbot-pmhq.service
systemctl --user disable --now qqbot-llbot.service
systemctl --user disable --now qqbot-koishi.service
systemctl --user disable --now qqbot-hbu-jw-tunnel.service
```

确认笔记本不再残留 QQBot 进程：

```bash
systemctl --user list-units --type=service --all | grep -E 'qqbot|koishi|pmhq|llbot' || true
pgrep -af 'koishi|pmhq|llbot|llonebot' || true
```

## 在 km6 上操作生产服务

启动或重启完整生产栈：

```bash
ssh km6 'systemctl restart qqbot.target'
```

查看状态：

```bash
ssh km6 'systemctl status qqbot.target qqbot-pmhq.service qqbot-llbot.service qqbot-koishi.service --no-pager'
```

跟随日志：

```bash
ssh km6 'journalctl -u qqbot-koishi.service -f'
```

停止服务器栈：

```bash
ssh km6 'systemctl stop qqbot.target'
```

检查运行时健康状态：

```bash
ssh km6 'bash /opt/qqbot/current/scripts/verify-qqbot-host-runtime.sh full'
```

## 常见检查

`km6` 上 PMHQ 没有运行：

```bash
ssh km6 'podman ps --filter name=pmhq'
ssh km6 'journalctl -u qqbot-pmhq.service --no-pager -n 200'
```

从服务器侧检查 LLBot WebUI：

```bash
ssh km6 'curl -I http://127.0.0.1:3080/'
```

从服务器侧检查 Koishi 控制台：

```bash
ssh km6 'curl -I http://127.0.0.1:5140/console'
```

OneBot WebSocket 无法连接：

```bash
ssh km6 'curl -I http://127.0.0.1:3080/'
ssh km6 'journalctl -u qqbot-llbot.service --no-pager -n 200'
```

确认 LLBot 正在运行、QQ 登录已完成，并且 `/opt/qqbot/shared/.env.server` 中设置了 `ONEBOT_WS_ENDPOINT=ws://127.0.0.1:3001`。

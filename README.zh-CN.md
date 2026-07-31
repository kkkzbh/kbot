# QQ AI Chat Bot

[English](README.md) | 简体中文

一个基于 Koishi、OneBot、LLBot、PMHQ 和 ChatLuna 构建的 QQ 聊天机器人。

## 生产部署

生产环境运行在 `km6` 上，只维护一份 PMHQ、LLBot、Koishi 完整栈实例。部署说明维护在 [`deploy/README.md`](deploy/README.md)。

```text
/opt/qqbot/app       当前应用实例
/opt/qqbot/data      运行数据和缓存
/opt/qqbot/shared    env 文件和服务器维护配置
```

从本地 checkout 部署：

```bash
cd ~/code/qqbot
deploy/deploy.sh km6
```

## 运行边界

这个仓库只作为源码、构建和运行工作区使用。

生成产物和本地运行状态不进入 Git：

```text
build/
dist/
.tmp/
.runtime/
data/koishi.db
data/logs/
node_modules/
```

如果某个文件会被 build、test、dev 或 runtime 命令反复生成，并且可以安全重建，就应该放进 `.gitignore`，不要靠反复手动删除维护。

## 本地开发

当前 checkout 依赖相邻的 ChatLuna checkout：

```text
~/code/qqbot
~/code/chatluna
```

在 `~/code/qqbot` 中安装依赖并验证：

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

`pnpm build` 会把运行产物写入 `dist/`。`dist/` 已被忽略，不应提交。

只修改独立管理端前端时，需要同时运行 `pnpm admin:typecheck` 与 `pnpm admin:build`。涉及 runtime backend、shared runtime types、Admin API contract，或 `koishi.yml` 使用的 managed env key 时，需要运行 `pnpm build`。

## 运行命令

开发本地运行：

```bash
pnpm start:local
```

从当前 checkout 以服务器配置运行：

```bash
pnpm start:server
```

启动前只做 linked ChatLuna package 和 runtime artifacts 的 preflight check，不会隐式 build。

## 环境文件

模板文件的职责边界：

```text
.env.example          developer-local 模板，复制为 .env.local
.env.server.example   server runtime 模板，复制为服务器上的 .env.server
```

密钥只放在本地 env 文件中。不要提交 `.env.local`、`.env.server`、`.runtime/` 或运行数据库。

关键运行配置：

```dotenv
ONEBOT_WS_ENDPOINT=ws://127.0.0.1:3001
KOISHI_HOST=127.0.0.1
KOISHI_PORT=5140
SQLITE_PATH=./data/koishi.db
LLBOT_RUNTIME_DIR=./.runtime/llbot
LLONEBOT_DATA_DIR=./.runtime/llonebot
```

服务器默认关闭语音输入。如果在服务器启用语音输出，`QQ_VOICE_TTS_BASE_URL` 必须指向 Tailnet 可访问的 TTS 服务，不能指向服务器本机的 `127.0.0.1`。

## 独立管理端

管理工作台由 Koishi 进程直接通过根路径 `/` 提供静态 SPA，并通过同源 `/api/admin/v1` 访问运行时能力。自有 Admin SPA 不依赖 Koishi Console。ChatLuna Agent 所需的官方 Console 位于内部路径 `/koishi-console`，WebSocket API 位于 `/koishi-console/status`。`/api/**`、校园绑定页和 Storage 等机器人 HTTP 路由继续由各自插件处理。

`/intelligence/agent` 是 ChatLuna Agent 的长期管理入口，只保留 MCP、Tools、Skills 与 Plugin 四个模块。Tools 总览展示 runtime registry 状态并进入单个 Tool 详情，范围权限随 Tool 管理；Plugin 采用 Codex manifest 的能力包模型，由一个包声明其 MCP、Skills 与 Tools，Workspace 作为内建 Plugin 统一管理文件、Shell、终端和桌面 backend 的访问边界。Sub-Agent 暂停开放，Skill 写入会固定关闭其 Sub-Agent 权限。配置写入统一委托给上游 runtime service，规范文件为 `${CHATLUNA_AGENT_DATA_DIR}/agents/config.json`；托管环境变量保存不会同步覆盖该文件。

启动前必须显式配置浏览器实际使用的 Origin：

```dotenv
QQBOT_ADMIN_ORIGIN=https://实际管理端域名
QQBOT_ADMIN_SSH_ORIGIN=http://127.0.0.1:5140
```

`QQBOT_ADMIN_ORIGIN` 必须匹配 Tailnet 浏览器 Origin，`QQBOT_ADMIN_SSH_ORIGIN` 必须匹配 SSH 本地转发产生的浏览器 Origin。Admin API 会校验两个 Host；所有变更请求还会校验两个 Origin。生产环境中的 Koishi 只监听 loopback，管理台通过 Tailnet-only Tailscale Serve 入口发布。Console 复用同一组 Host、loopback 与 Tailscale 身份校验，只允许本机、SSH Tunnel 和受控 Tailnet 访问；Cloudflare 公共绑定域名无法访问 Console。Secret 字段只返回是否已配置。

## 运行辅助脚本

当前保留的是直接面向 workspace runtime 的脚本：

```text
scripts/run-koishi-with-env.sh
scripts/podman-pmhq-service.sh
scripts/run-llbot-host.sh
scripts/verify-qqbot-host-runtime.sh
scripts/server-recover-qq-login.sh
scripts/run-voice-tts-local.sh
scripts/publish-voice-tts-tailnet.sh
```

这些脚本是当前 workspace 的直接 runtime helper。

## 测试策略

测试维护遵循 [`docs/testing-policy.md`](docs/testing-policy.md)。测试应聚焦稳定用户行为、运行时契约、产物形状和职责边界，避免继续为已经移除的部署路径保留大范围字符串快照。

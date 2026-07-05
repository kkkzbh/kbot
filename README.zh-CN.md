# QQ AI Chat Bot

[English](README.md) | 简体中文

一个基于 Koishi、OneBot、LLBot、PMHQ 和 ChatLuna 构建的 QQ 聊天机器人。

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

如果只修改 console 前端，`pnpm console:build` 足够覆盖前端检查。涉及 runtime backend、shared runtime types、console IPC，或 `koishi.yml` 使用的 managed env key 时，需要运行 `pnpm build`。

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
KOISHI_HOST=0.0.0.0
KOISHI_PORT=5140
SQLITE_PATH=./data/koishi.db
LLBOT_RUNTIME_DIR=./.runtime/llbot
LLONEBOT_DATA_DIR=./.runtime/llonebot
```

服务器默认关闭语音输入。如果在服务器启用语音输出，`QQ_VOICE_TTS_BASE_URL` 必须指向 Tailnet 可访问的 TTS 服务，不能指向服务器本机的 `127.0.0.1`。

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

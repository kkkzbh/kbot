# Koishi 插件与功能

本页仅说明当前项目中 Koishi 已启用插件和其提供的功能，不涉及实现细节。

## 已启用插件（以 `koishi.yml` 为准）

### `@koishijs/plugin-http` (`http:main`)

- 功能：为 Koishi 提供 HTTP 能力，供插件发起外部请求。
- 在本项目中的作用：支持群聊插件调用 OpenAI 兼容接口。

### `koishi-plugin-adapter-onebot` (`adapter-onebot:onebot`)

- 功能：提供 OneBot 协议适配能力。
- 在本项目中的作用：连接 LLOneBot 的 WebSocket 正向服务，接收/发送 QQ 消息。
- 当前协议模式：`ws`。

### `@koishijs/plugin-server` (`server:0b8t2q`)

- 功能：提供 Koishi 服务监听能力。
- 在本项目中的作用：使 Koishi 在 `KOISHI_HOST:KOISHI_PORT` 上启动。

### `./dist/plugins/group-chat` (`./dist/plugins/group-chat:wtq0lk`)

- 功能：项目自定义群聊插件。
- 在本项目中的作用：
  - 仅允许白名单群 `CHAT_ENABLED_GROUPS` 触发。
  - 仅接受 `@机器人 + 文本` 触发模式（`CHAT_TRIGGER_MODE=mention`）。
  - 回复时 `@` 原发言人。
  - 支持上下文轮数、超时、用户冷却、群内并发限制等策略配置。

## 已安装但未启用插件

### `@koishijs/plugin-proxy-agent`

- 状态：当前 `koishi.yml` 未启用。
- 说明：依赖已安装不代表已生效；只有写入 `koishi.yml` 并加载后才会生效。

## 功能总览

当前仓库（Milestone 1）实际提供的核心能力：

- QQ 群 AI 聊天（Koishi + OneBot + LLOneBot）
- 白名单群控制
- Mention 触发控制
- 模型调用失败统一降级提示
- 聊天上下文、限流与并发保护

不在当前里程碑范围内的能力：

- 设备信息查询（Milestone 2）

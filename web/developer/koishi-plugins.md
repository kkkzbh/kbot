# Koishi 插件与功能

本页仅说明当前项目中 Koishi 已启用插件和其提供的功能，不涉及实现细节。

## 已启用插件（以 `koishi.yml` 为准）

### `@koishijs/plugin-http`

- 功能：为 Koishi 提供 HTTP 能力，供插件发起外部请求。
- 在本项目中的作用：为 ChatLuna 及适配器提供网络请求能力。

### `koishi-plugin-adapter-onebot`

- 功能：提供 OneBot 协议适配能力。
- 在本项目中的作用：连接 LLOneBot 的 WebSocket 正向服务，接收/发送 QQ 消息。
- 当前协议模式：`ws`。

### `@koishijs/plugin-server`

- 功能：提供 Koishi 服务监听能力。
- 在本项目中的作用：使 Koishi 在 `KOISHI_HOST:KOISHI_PORT` 上启动。

### `@koishijs/plugin-database-sqlite`

- 功能：提供 SQLite 数据库存储。
- 在本项目中的作用：持久化 ChatLuna 房间、会话与上下文。

### `koishi-plugin-chatluna`

- 功能：提供 ChatLuna 原生触发、房间系统与命令体系。
- 在本项目中的作用：承接当前聊天主链路。
- 当前默认聊天模式：`defaultChatMode=plugin`。

### `koishi-plugin-chatluna-deepseek-adapter`

- 功能：为 ChatLuna 提供 DeepSeek 模型平台接入。
- 在本项目中的作用：复用 `OPENAI_BASE_URL` + `OPENAI_API_KEY` + `OPENAI_MODEL` 作为模型侧配置输入。

### `@koishijs/plugin-commands`

- 功能：覆盖 Koishi 指令元配置（如 authority）。
- 在本项目中的作用：统一将 `chatluna.*` 命令权限提升到 `authority >= 3`（默认值，可配置）。

## 已安装但未启用插件

### `@koishijs/plugin-proxy-agent`

- 状态：当前 `koishi.yml` 未启用。
- 说明：依赖已安装不代表已生效；只有写入 `koishi.yml` 并加载后才会生效。

### `koishi-plugin-chatluna-storage-service`

- 状态：当前已安装但未启用。
- 说明：预留后续扩展使用，当前不参与运行链路。

## 已移除组件

- 弃用的 `group-chat` 自定义链路已从仓库移除，不属于可选插件。

## 触发契约（当前链路）

- 当前被动触发遵循 ChatLuna 原生规则（`@`/昵称/私聊）。
- 触发策略已配置为“句中包含即可触发”：
  - `isNickNameWithContent=true`（昵称不要求句首）
  - `allowAtReply=true`（`@机器人` 不要求句首）
- 命令触发（`chatluna.*`）由 `@koishijs/plugin-commands` 统一做权限门槛控制。
- 运行链路详情见：[聊天链路说明](/developer/chatluna-migration)。

## 功能总览

当前仓库（Milestone 1）实际提供的核心能力：

- QQ AI 聊天（Koishi + OneBot + LLOneBot + ChatLuna + DeepSeek）
- ChatLuna 原生触发路径（昵称/私聊/@）
- ChatLuna 房间与上下文持久化（SQLite）
- `chatluna.*` 命令权限分层（默认 `authority >= 3`）

不在当前里程碑范围内的能力：

- 设备信息查询（Milestone 2）

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
- 在本项目中的作用：持久化 ChatLuna 会话与自动化任务数据。

### `koishi-plugin-cron`

- 功能：提供 `ctx.cron()` 周期任务调度能力。
- 在本项目中的作用：承载自动化任务的周期调度执行。

### `./dist/plugins/task-automation`（本地插件）

- 功能：自然语言任务意图判定、任务管理命令、一次性任务轮询执行。
- 在本项目中的作用：
  - 解析群聊/私聊消息中的任务意图（创建、查询、删除、暂停、恢复）。
  - 命中自动化意图时优先处理，不走 ChatLuna 普通对话回复。
  - 支持群任务触发时 `@创建者`，私聊任务私发。

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

### `./dist/plugins/chatluna-model-guard`（本地插件）

- 功能：在模型不可用时拦截 ChatLuna 调用并返回统一提示。
- 在本项目中的作用：避免模型异常时返回原始错误细节到群聊。

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

- 对话触发遵循 ChatLuna 原生规则（`@`/昵称/私聊）。
- 对话触发策略已配置为“句中包含即可触发”：
  - `isNickNameWithContent=true`（昵称不要求句首）
  - `allowAtReply=true`（`@机器人` 不要求句首）
- 自动化触发由本地 `task-automation` 插件独立处理：
  - 白名单群与私聊中可自然语言触发任务，无需 `@机器人`。
  - 自动化命中时优先处理；未命中才进入对话链路。
- 命令触发：
  - `chatluna.*` 由 `@koishijs/plugin-commands` 控制权限门槛。
  - `task.*` 由 `task-automation` 内部权限模式控制（`all`/`authority3`）。
- 运行链路详情见：[聊天链路说明](/developer/chatluna-migration)。

## 功能总览

当前仓库（Milestone 1）实际提供的核心能力：

- QQ AI 聊天（Koishi + OneBot + LLOneBot + ChatLuna + DeepSeek）
- ChatLuna 原生触发路径（昵称/私聊/@）
- ChatLuna 房间与上下文持久化（SQLite）
- `chatluna.*` 命令权限分层（默认 `authority >= 3`）
- 智能自动化任务（自然语言触发 + `task.*` 命令管理 + cron/once 调度）

不在当前里程碑范围内的能力：

- 设备信息查询（Milestone 2）

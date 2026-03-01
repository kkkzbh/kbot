# 配置说明

本页描述当前项目运行所需配置，聚焦“如何配置”，不解释源码实现。

## 配置来源与优先级

- 敏感项统一放在 `.env`，不得硬编码。
- Koishi 运行时从 `koishi.yml` 读取插件配置。
- `koishi.yml` 中大多数值来自环境变量引用（Koishi Loader `env` 表达式）。
- 当前对话链路为 ChatLuna + DeepSeek 适配器。
- 当前自动化链路为 `cron + task-automation`。

## 必填配置

以下变量在 `.env` 中必须正确设置：

| 变量 | 用途 | 备注 |
| --- | --- | --- |
| `ONEBOT_SELF_ID` | 机器人 QQ 号 | OneBot 适配器自身份 |
| `OPENAI_API_KEY` | 模型服务密钥 | 敏感项，不写入日志 |
| `OPENAI_MODEL` | 模型名称 | 推荐 `deepseek/deepseek-chat` |
| `SQLITE_PATH` | SQLite 文件路径 | 默认 `./data/koishi.db` |
| `CHATLUNA_COMMAND_AUTHORITY` | ChatLuna 命令权限门槛 | 默认 `3` |

## OneBot 连接相关

| 变量 | 默认值 | 对应 `koishi.yml` | 说明 |
| --- | --- | --- | --- |
| `ONEBOT_WS_ENDPOINT` | `ws://127.0.0.1:3001` | `adapter-onebot.endpoint` | 指向 LLOneBot WebSocket 正向地址 |
| `ONEBOT_TOKEN` | 空 | `adapter-onebot.token` | 与 LLOneBot token 保持一致（若启用） |
| `ONEBOT_SELF_ID` | 无 | `adapter-onebot.selfId` | 机器人账号 |

## Koishi 服务监听

| 变量 | 默认值 | 对应 `koishi.yml` | 说明 |
| --- | --- | --- | --- |
| `KOISHI_HOST` | `0.0.0.0` | `server.host` | Koishi 监听地址 |
| `KOISHI_PORT` | `5140` | `server.port` | Koishi 监听端口 |

## SQLite 持久化

| 变量 | 默认值 | 对应 `koishi.yml` | 说明 |
| --- | --- | --- | --- |
| `SQLITE_PATH` | `./data/koishi.db` | `database-sqlite.path` | SQLite 数据文件路径 |

## DeepSeek（OpenAI 兼容）模型配置

| 变量 | 默认值 | 对应 `koishi.yml` | 说明 |
| --- | --- | --- | --- |
| `OPENAI_BASE_URL` | `https://api.deepseek.com/v1` | `chatluna-deepseek-adapter.apiKeys[*][1]` | DeepSeek API 地址 |
| `OPENAI_API_KEY` | 无 | `chatluna-deepseek-adapter.apiKeys[*][0]` | DeepSeek API Key（敏感） |
| `OPENAI_MODEL` | `deepseek/deepseek-chat` | `chatluna.defaultModel` | ChatLuna 默认模型 |

## ChatLuna 行为与命令权限

| 变量/配置 | 默认值 | 对应 `koishi.yml` | 说明 |
| --- | --- | --- | --- |
| `defaultChatMode` | `plugin` | `chatluna.defaultChatMode` | 默认聊天模式 |
| `OPENAI_MODEL` | `deepseek/deepseek-chat` | `chatluna.defaultModel` | 默认模型名 |
| `CHATLUNA_COMMAND_AUTHORITY` | `3` | `commands.*.config.authority` | `chatluna.*` 命令所需权限 |
| `isNickname` | `true` | `chatluna.isNickname` | 允许句首昵称触发 |
| `isNickNameWithContent` | `true` | `chatluna.isNickNameWithContent` | 允许句中任意位置昵称触发 |
| `allowAtReply` | `true` | `chatluna.allowAtReply` | 允许消息中 `@机器人` 触发 |

## 自动化任务配置

| 变量 | 默认值 | 对应 `koishi.yml` | 说明 |
| --- | --- | --- | --- |
| `CHAT_ENABLED_GROUPS` | 空 | `task-automation.enabledGroups` | 自动化可生效的群白名单（逗号分隔） |
| `TASK_AUTOMATION_LISTEN_PRIVATE` | `true` | `task-automation.listenPrivate` | 是否允许私聊触发自动化意图 |
| `TASK_AUTOMATION_PERMISSION` | `all` | `task-automation.permissionMode` | `all` 或 `authority3` |
| `TASK_AUTOMATION_INTENT_ENABLED` | `true` | `task-automation.intentEnabled` | 是否启用自然语言意图判定 |
| `TASK_AUTOMATION_INTENT_MIN_CONFIDENCE` | `0.78` | `task-automation.intentMinConfidence` | 模型兜底最小置信度 |
| `TASK_AUTOMATION_INTENT_BASE_URL` | 空（回落到 `OPENAI_BASE_URL`） | `task-automation.intentBaseUrl` | 意图模型 API 地址 |
| `TASK_AUTOMATION_INTENT_API_KEY` | 空（回落到 `OPENAI_API_KEY`） | `task-automation.intentApiKey` | 意图模型 API Key（敏感） |
| `TASK_AUTOMATION_INTENT_MODEL` | 空（回落到 `OPENAI_MODEL`） | `task-automation.intentModel` | 意图模型名称 |
| `TASK_AUTOMATION_INTENT_TIMEOUT_MS` | `12000` | `task-automation.intentTimeoutMs` | 意图模型请求超时 |
| `TASK_AUTOMATION_POLL_MS` | `30000` | `task-automation.pollIntervalMs` | 一次性任务轮询间隔 |
| `TASK_AUTOMATION_MAX_TASKS_PER_USER` | `20` | `task-automation.maxTasksPerUser` | 每用户任务上限 |

## 已移除配置

以下旧 `group-chat` 变量已弃用并从 `.env.example` 移除：

- `CHAT_TRIGGER_MODE`
- `CHAT_MAX_CONTEXT_TURNS`
- `CHAT_TIMEOUT_MS`
- `CHAT_USER_COOLDOWN_MS`
- `CHAT_GROUP_QPS_LIMIT`
- `CHAT_SYSTEM_PROMPT`
- `CHAT_SYSTEM_PROMPT_FILE`

## 推荐配置流程

1. 复制模板：`cp .env.example .env`
2. 按“必填配置”补齐关键变量。
3. 按自动化需求设置 `CHAT_ENABLED_GROUPS` 与 `TASK_AUTOMATION_*`。
4. 确认 `koishi.yml` 中插件均引用对应环境变量。
5. 运行 `pnpm start` 验证 Koishi 能成功启动。

## 安全要求

- 不在任何日志中打印 `OPENAI_API_KEY`、`ONEBOT_TOKEN` 或完整请求头。
- 不将 `.env` 提交到版本库。
- 不未经审批扩大命令权限或群权限范围。

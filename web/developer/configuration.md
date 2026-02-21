# 配置说明

本页描述当前项目运行所需配置，聚焦“如何配置”，不解释源码实现。

## 配置来源与优先级

- 敏感项统一放在 `.env`，不得硬编码。
- Koishi 运行时从 `koishi.yml` 读取插件配置。
- `koishi.yml` 中大多数值来自环境变量引用（Koishi Loader `env` 表达式）。
- 系统提示词优先级：
  - `CHAT_SYSTEM_PROMPT_FILE`（最高）
  - `CHAT_SYSTEM_PROMPT`
  - 插件内置默认提示词

## 必填配置

以下变量在 `.env` 中必须正确设置：

| 变量 | 用途 | 备注 |
| --- | --- | --- |
| `ONEBOT_SELF_ID` | 机器人 QQ 号 | OneBot 适配器自身份 |
| `CHAT_ENABLED_GROUPS` | 允许聊天的群号白名单 | 逗号分隔 |
| `OPENAI_API_KEY` | 模型服务密钥 | 敏感项，不写入日志 |
| `OPENAI_MODEL` | 模型名称 | 例如 `gpt-4o-mini` |

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

## OpenAI 兼容模型服务

| 变量 | 默认值 | 对应 `koishi.yml` | 说明 |
| --- | --- | --- | --- |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | `group-chat.baseUrl` | OpenAI 兼容 API Base URL |
| `OPENAI_API_KEY` | 无 | `group-chat.apiKey` | 访问密钥（敏感） |
| `OPENAI_MODEL` | 无 | `group-chat.model` | 模型名称 |

## 群聊策略配置

| 变量 | 默认值 | 对应 `koishi.yml` | 说明 |
| --- | --- | --- | --- |
| `CHAT_TRIGGER_MODE` | `mention` | 运行时校验 | 首版固定 `mention`，非该值会启动失败 |
| `CHAT_ENABLED_GROUPS` | 无 | `group-chat.enabledGroups` | 允许触发的群号白名单 |
| `CHAT_MAX_CONTEXT_TURNS` | `8` | `group-chat.maxContextTurns` | 上下文轮数 |
| `CHAT_TIMEOUT_MS` | `20000` | `group-chat.timeoutMs` | 模型请求超时毫秒 |
| `CHAT_USER_COOLDOWN_MS` | `8000` | `group-chat.userCooldownMs` | 同用户冷却时间 |
| `CHAT_GROUP_QPS_LIMIT` | `1` | `group-chat.groupQpsLimit` | 每群并发限制 |
| `CHAT_SYSTEM_PROMPT` | 空 | `group-chat.systemPrompt` | 单行系统提示词 |
| `CHAT_SYSTEM_PROMPT_FILE` | 空 | `group-chat.systemPromptFile` | 多行提示词文件路径（推荐） |

## 推荐配置流程

1. 复制模板：`cp .env.example .env`
2. 按“必填配置”补齐关键变量。
3. 确认 `koishi.yml` 中插件均引用对应环境变量。
4. 运行 `pnpm start` 验证 Koishi 能成功启动。

## 安全要求

- 不在任何日志中打印 `OPENAI_API_KEY`、`ONEBOT_TOKEN` 或完整请求头。
- 不将 `.env` 提交到版本库。
- 不未经审批扩大群权限范围（例如白名单改为全量群）。

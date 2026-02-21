# ChatLuna 迁移说明

本页用于说明“从旧自定义群聊插件链路迁移到 ChatLuna 原生链路”后的行为变化与运维要点。

## 当前主链路

以 `koishi.yml` 已启用插件为准，当前聊天主链路为：

1. `koishi-plugin-adapter-onebot`
2. `koishi-plugin-chatluna`
3. `koishi-plugin-chatluna-deepseek-adapter`
4. `@koishijs/plugin-database-sqlite`
5. `@koishijs/plugin-commands`

旧链路源码仍保留在 `src/plugins/group-chat.ts` / `src/plugins/group-chat-core.ts`，但默认不加载。

## 关键行为变化

### 1. 触发契约变化

- 迁移前（旧链路）：`CHAT_ENABLED_GROUPS + @机器人 + 文本` 触发。
- 迁移后（当前）：遵循 ChatLuna 原生触发规则（`@`、昵称、私聊）。

这意味着：

- 群聊是否响应不再由 `CHAT_ENABLED_GROUPS` 控制。
- 被动触发策略由 ChatLuna 自身配置决定。

### 2. 命令权限控制变化

- 迁移后 `chatluna.*` 命令统一由 `@koishijs/plugin-commands` 控制。
- 默认权限门槛：`CHATLUNA_COMMAND_AUTHORITY=3`。
- 被动聊天和命令权限是两条独立控制面，排障时需分别检查。

### 3. 持久化能力变化

- 迁移后启用 `@koishijs/plugin-database-sqlite`。
- 默认数据库路径：`./data/koishi.db`（可通过 `SQLITE_PATH` 覆盖）。
- ChatLuna 房间/上下文可以跨 Koishi 重启保留。

## 配置迁移建议

1. 必填：`ONEBOT_SELF_ID`、`OPENAI_API_KEY`、`OPENAI_MODEL`、`SQLITE_PATH`、`CHATLUNA_COMMAND_AUTHORITY`。
2. 建议保留 `OPENAI_BASE_URL=https://api.deepseek.com/v1`（按服务商调整）。
3. 旧链路变量（如 `CHAT_ENABLED_GROUPS`、`CHAT_TRIGGER_MODE`）仅作回滚预留，不参与当前默认链路。

## 回滚路径（如需）

1. 在 `koishi.yml` 恢复并启用旧 `./dist/plugins/group-chat` 插件配置块。
2. 停用 `chatluna` 与 `chatluna-deepseek-adapter` 实例，避免重复回复。
3. 按旧链路恢复 `CHAT_ENABLED_GROUPS`、`CHAT_TRIGGER_MODE` 等配置。
4. 重启 Koishi 后在测试群验证触发行为。

## 迁移后验证清单

- `pnpm start` 启动后 Koishi 无插件加载错误。
- OneBot WS 与 LLOneBot 正常连通（默认 `ws://127.0.0.1:3001`）。
- 群内 `@机器人` 能触发回复，昵称/私聊触发符合预期。
- `chatluna.*` 命令权限门槛符合 `CHATLUNA_COMMAND_AUTHORITY` 设定。
- 重启 Koishi 后历史会话仍可继续（SQLite 持久化生效）。

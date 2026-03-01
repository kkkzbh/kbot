# 聊天与自动化链路说明

本页描述当前受支持的对话链路、自动化链路、触发契约与验证要点。

## 当前链路

以 `koishi.yml` 已启用插件为准，当前对话主链路为：

1. `koishi-plugin-adapter-onebot`
2. `koishi-plugin-chatluna`
3. `koishi-plugin-chatluna-deepseek-adapter`
4. `./dist/plugins/chatluna-model-guard`
5. `@koishijs/plugin-database-sqlite`
6. `@koishijs/plugin-commands`

自动化链路为：

1. `koishi-plugin-cron`
2. `./dist/plugins/task-automation`
3. `@koishijs/plugin-database-sqlite`

## 已移除组件

以下弃用组件已从仓库删除，不再提供回滚路径：

- `src/plugins/group-chat.ts`
- `src/plugins/group-chat-core.ts`
- `tests/group-chat.test.ts`
- `src/types/chat.ts`

## 触发与权限契约

- 对话触发遵循 ChatLuna 原生规则（`@`、昵称、私聊）。
- 对话配置已启用“句中触发”：
  - `isNickNameWithContent=true`：消息中任意位置包含机器人昵称即可触发。
  - `allowAtReply=true`：消息中出现 `@机器人` 可触发（不要求句首）。
- 自动化触发独立于对话触发：
  - 白名单群 + 私聊可自然语言识别任务意图，不要求 `@机器人`。
  - 自动化命中时优先处理；未命中才进入 ChatLuna 对话链路。
- `chatluna.*` 命令统一由 `@koishijs/plugin-commands` 控制。
- 默认权限门槛：`CHATLUNA_COMMAND_AUTHORITY=3`。
- `task.*` 命令由 `task-automation` 内部权限模式控制（`TASK_AUTOMATION_PERMISSION=all|authority3`）。
- 对话触发、自动化触发、命令权限是三条独立控制面，排障时需分别检查。

## 持久化能力

- 当前启用 `@koishijs/plugin-database-sqlite`。
- 默认数据库路径：`./data/koishi.db`（可通过 `SQLITE_PATH` 覆盖）。
- ChatLuna 房间/上下文可以跨 Koishi 重启保留。
- 自动化任务数据也持久化在同一个 SQLite 中。

## 配置建议

1. 必填：`ONEBOT_SELF_ID`、`OPENAI_API_KEY`、`OPENAI_MODEL`、`SQLITE_PATH`、`CHATLUNA_COMMAND_AUTHORITY`。
2. 建议保留 `OPENAI_BASE_URL=https://api.deepseek.com/v1`（按服务商调整）。
3. 自动化建议设置：
   - `CHAT_ENABLED_GROUPS`
   - `TASK_AUTOMATION_INTENT_ENABLED=true`
   - `TASK_AUTOMATION_PERMISSION=all`（或 `authority3`）
4. 旧 `group-chat` 变量已移除，现有 `.env` 中如仍保留可手动清理。

## 运行验证清单

- `pnpm start` 启动后 Koishi 无插件加载错误。
- OneBot WS 与 LLOneBot 正常连通（默认 `ws://127.0.0.1:3001`）。
- 群内 `@机器人` 能触发回复，昵称/私聊触发符合预期。
- 群内不 `@` 的任务语句可被自动化识别并执行（仅白名单群）。
- `chatluna.*` 命令权限门槛符合 `CHATLUNA_COMMAND_AUTHORITY` 设定。
- `task.*` 命令权限行为符合 `TASK_AUTOMATION_PERMISSION` 设定。
- 重启 Koishi 后历史会话仍可继续（SQLite 持久化生效）。

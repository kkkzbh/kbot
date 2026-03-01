# 自动化使用功能介绍

本页说明当前自动化能力如何使用，面向开发、联调与运维验证场景。

## 功能范围

当前 `task-automation` 支持：

- 创建一次性任务（例如“明天 8 点提醒我交周报”）
- 创建周期任务（例如“每周一早上 9 点提醒我开会”）
- 查看任务列表
- 删除、暂停、恢复任务

## 生效前提

- 群聊场景：群号需要在 `CHAT_ENABLED_GROUPS` 白名单内。
- 私聊场景：`TASK_AUTOMATION_LISTEN_PRIVATE=true`（默认即为 `true`）。
- 权限模式：
  - `TASK_AUTOMATION_PERMISSION=all`：会话内成员可管理自己的任务。
  - `TASK_AUTOMATION_PERMISSION=authority3`：要求 `authority >= 3`。

## 自然语言触发示例

以下内容在命中自动化意图时，会由自动化链路优先处理：

- `30分钟后提醒我开会`
- `今天10:30提醒我喝水`
- `明天早上8点提醒我交周报`
- `每周一早上9点提醒我周会`
- `查看我的任务列表`
- `删除任务 12`
- `暂停任务 7`
- `恢复任务 7`

说明：

- 在白名单群和私聊中，自动化语句不要求必须 `@机器人`。
- 如果未命中自动化意图，消息会继续进入 ChatLuna 对话链路。

## `task.*` 命令速查

- `task.list`：查看当前会话任务
- `task.add.once <time> -- <message>`：创建一次性任务  
  示例：`task.add.once 明天8点 -- 交周报`
- `task.add.cron <cron> -- <message>`：创建周期任务  
  示例：`task.add.cron 0 9 * * 1 -- 周会提醒`
- `task.pause <id>`：暂停任务
- `task.resume <id>`：恢复任务
- `task.del <id>`：删除任务

## 时间与时区

- 自动化时间解析与周期任务调度固定使用 `Asia/Shanghai (UTC+8)`。
- 不管部署服务器本地时区是什么，自动化任务都按 UTC+8 语义执行。

## 验证建议

联调时建议最少验证以下场景：

1. 白名单群中自然语言创建一次性任务并按时触发。
2. 白名单群中自然语言创建周期任务并按计划触发。
3. 私聊任务能创建并触发。
4. `task.list / task.pause / task.resume / task.del` 行为符合预期。
5. 自动化未命中的消息能正常走 ChatLuna 回复。

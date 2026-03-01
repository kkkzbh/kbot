# QQBot 开发者文档

该站点只维护当前项目的开发者信息，聚焦以下内容：

- Koishi 当前启用了哪些插件
- 每个插件提供了什么功能
- 如何通过 `.env` 与 `koishi.yml` 配置项目
- 当前聊天链路与自动化链路触发契约
- 自动化功能的使用入口与约束

> 本站点不包含“如何实现”的源码讲解，也不提供面向群成员的完整操作手册。

## 当前状态

- 当前对话主链路为 `ChatLuna + DeepSeek Adapter + SQLite`。
- 当前自动化链路由 `task-automation` 内部调度实现（独立于 ChatLuna 触发规则）。
- 自动化时间基准固定为 `Asia/Shanghai (UTC+8)`。
- 弃用的 `group-chat` 旧链路已从仓库移除。

## 快速入口

- [Koishi 插件与功能](/developer/koishi-plugins)
- [配置说明](/developer/configuration)
- [聊天与自动化链路说明](/developer/chatluna-migration)
- [自动化使用功能介绍](/developer/automation-usage)

## 文档维护边界

- “当前使用插件”以 `koishi.yml` 中已启用插件为准。
- 依赖里已安装但未启用的插件，会单独标注为“未启用”。
- 新增或变更配置项时，必须同步更新：`.env.example`、`README.md`、`koishi.yml`、本开发者文档。

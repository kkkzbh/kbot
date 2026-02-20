# AGENTS.md

## 项目目标
- 首版只交付 QQ 群 AI 聊天功能。
- 技术链路：Koishi + OneBot + LLOneBot。
- 设备信息查询功能属于第二里程碑（暂不实现）。

## 环境基线
- Fedora Linux 43 (KDE Plasma)
- Podman 5.x（rootless）
- SELinux Enforcing
- Node.js >= 22
- 包管理器：pnpm

## 目录规范
- `koishi.yml`：Koishi Loader 启动配置
- `src/plugins/*.ts`：业务插件
- `src/types/*.ts`：共享类型
- `tests/*.test.ts`：单元测试
- `docker/*`：容器构建脚本
- `compose.yaml`：LLBot 官方双服务编排（`pmhq + llbot`）
- `dist/`：编译产物（由 `pnpm build` 生成，不手改）

## 接口与触发契约
- 群聊只支持 `@机器人 + 文本` 触发。
- 群聊只在 `CHAT_ENABLED_GROUPS` 中的群内生效。
- 回复必须 `@发言人`。
- 非白名单群默认不响应。

## 配置约定
- 所有敏感项走 `.env`，不得硬编码。
- 新增配置项必须同步修改：
  - `.env.example`
  - `README.md`
  - `koishi.yml`
- `CHAT_TRIGGER_MODE` 首版固定为 `mention`。

## 安全要求
- 禁止在日志输出 API Key、Token、完整请求头。
- 模型异常返回统一降级文案，不回传原始堆栈到群聊。
- 不得无审批扩大群权限范围（例如从白名单群改为全部群）。

## 质量门槛
- 提交前必须通过：
  - `pnpm typecheck`
  - `pnpm test`
  - `pnpm build`
- 新增策略逻辑（限流、鉴权、触发规则）必须有对应单元测试。
- 任何命令输出或触发契约变化都要更新 `README.md`。

## Fedora / Podman 约束
- 默认部署路径是 Podman，不提供 Docker Desktop 流程。
- 绑定卷保留 `:Z`，避免 SELinux 拒绝访问。
- 容器回连宿主统一使用 `host.containers.internal`。
- 登录相关日志优先看 `pmhq` 服务而非仅 `llbot` 服务。

## 迭代路线
- Milestone 1（当前）：群 AI 聊天 MVP。
- Milestone 2（后续）：设备信息功能（管理员/白名单策略另定）。

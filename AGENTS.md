# AGENTS.md

## 服务器与部署实况（简版）
- Bot 部署在服务器上，不在本机常驻运行。
- 服务器入口：`ssh ascend`
- 部署用户：`xyz`
- 部署目录：`/opt/qqbot/current`

## 更新流程
- 日常更新方式：将代码 push 到 GitHub。
- push 后触发 `Deploy` workflow，自动把新代码部署到服务器并更新 bot。

## systemd 拓扑（服务器 user 级）
- `qqbot.target`：总目标
- `qqbot-stack.service`：负责 Podman 容器（`pmhq + llbot`）
- `qqbot-koishi.service`：负责 Koishi 进程
- 常用重启命令：`systemctl --user restart qqbot.target`

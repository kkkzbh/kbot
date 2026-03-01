# AGENTS.md

## 服务器与部署实况（简版）
- Bot 部署在服务器上，不在本机常驻运行。
- 服务器入口：`ssh ascend`
- 部署用户：`xyz`
- 部署目录：`/opt/qqbot/current`

## 更新流程
- 日常更新方式：修改代码，将代码 push 到 GitHub。
- push 后触发 `Deploy` workflow，自动把新代码部署到服务器并更新 bot。
- Debug不要执行修改服务器的命令，优先走修改本地代码+deploy.yml，push后，再去服务器验证的方式
- deploy.yml 不要写特判逻辑，如果你Debug必须用到特判逻辑，此时允许手动执行一些修改服务器的命令

## systemd 拓扑（服务器 user 级）
- `qqbot.target`：总目标
- `qqbot-stack.service`：负责 Podman 容器（`pmhq + llbot`）
- `qqbot-koishi.service`：负责 Koishi 进程
- 常用重启命令：`systemctl --user restart qqbot.target`

## 注意
不要忽略了本地的.env文件，要与.env.example同步
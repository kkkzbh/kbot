# 志愿汇与河北大学二课模块

QQBot 通过 `campus-auth-core` 提供统一的一次性绑定页、确认码、KEK envelope encryption、凭据版本、会话审计和依赖会话撤销。教务模块继续使用原有表和绑定入口。

## 用户命令

志愿汇：

- `志愿汇`
- `志愿汇绑定`
- `志愿汇确认 <6位确认码>`
- `志愿汇状态`
- `志愿汇解绑`
- `志愿时长`
- `志愿记录 [页码]`
- `志愿活动 [关键词]`
- `我的志愿活动 [页码]`

河北大学二课：

- `二课`
- `二课绑定`
- `二课确认 <6位确认码>`
- `二课状态`
- `二课解绑`
- `二课学分`
- `二课成绩单 [学期]`
- `二课雷达`
- `二课活动`
- `二课记录`

两个模块只执行查询。报名、取消报名、签到、签退等写操作均未注册。

## 绑定方式

志愿汇支持托管账号登录、单次账号登录和导入 `Authorization` / `User-Id` / `Platform-Id`。托管登录会加密保存账号密码并在会话失效时重新登录，另外两种方式失效后要求重新绑定。

二课支持账号密码与验证码登录、Token 导入。密码按当前 Web 端协议使用 SM2 加密后提交，服务端只持久化二课 Token。所有二课绑定均校验学校名称和河北大学租户 ID。

2026-07-15 核对的中青二课前端会在 `/auth/getUserByZyhToken`、`/auth/bind`、`/auth/h5/auth/login`、`/auth/h5/auth/check` 每次请求前调用志愿汇 App 原生桥接 `getTempUserCode()`，并把回调结果放入请求头 `token`。Android、iOS、Harmony 分别使用 `window.android.getTempUserCode()`、`window.webkit.messageHandlers.getTempUserCode.postMessage("")`、`window.harmony.getTempUserCode()`。

普通志愿汇账号密码登录只返回 `Authorization`、`User-Id`、`Platform-Id`，无法生成 App 临时码。QQBot 不复用已捕获的临时码，也不提供基于志愿汇密码会话的二课自动续期。

扫码授权只能持久化兑换后的二课 Token，Token 过期后仍需用户再次扫码。它没有提供账号登录和 Token 导入之外的功能，因此 QQBot 不提供该绑定方式。若后续通过受控实机抓包或运行时分析确认 App 生成临时码的原生请求并支持后台续期，再重新评估。当前 APK 使用 360 加固，静态反编译无法获得该实现。

## 运行配置

统一认证：

- `CAMPUS_AUTH_PUBLIC_BASE_URL`
- `CAMPUS_AUTH_BIND_PAGE_PATH`
- `CAMPUS_AUTH_BIND_TOKEN_TTL_MS`
- `CAMPUS_AUTH_CREDENTIAL_KEK_PATH`
- `CAMPUS_AUTH_MAX_BINDING_ATTEMPTS`

模块白名单和自然触发：

- `ZYH_ALLOWED_GROUPS`
- `ZYH_NATURAL_TRIGGER_ENABLED`
- `ZYH_NATURAL_TRIGGER_GROUPS`
- `HBU_SECOND_CLASS_ALLOWED_GROUPS`
- `HBU_SECOND_CLASS_NATURAL_TRIGGER_ENABLED`
- `HBU_SECOND_CLASS_NATURAL_TRIGGER_GROUPS`

生产环境继续使用 `cloudflared-qqbot-hbu-jw.service` 的 token-file Tunnel。将 `CAMPUS_AUTH_PUBLIC_BASE_URL` 指向现有教务域名，并让 Tunnel 的 ingress 将 `/campus/bind` 转发到 Koishi；无需创建 credentials JSON 或新的 CLI 管理 Tunnel。

## 数据与撤销

统一认证表为 `campus_auth_challenge`、`campus_auth_credential`、`campus_auth_session`、`campus_auth_audit`。业务缓存分别使用 `zyh_sync_state` / `zyh_data_item` 和 `hbu_second_class_sync_state` / `hbu_second_class_data_item`。

缓存按会话凭据版本隔离。远端临时网络故障时，模块只返回同一版本的历史数据并明确标注抓取时间。重新绑定和解绑会清理对应缓存。二课运行时不依赖 QQBot 的志愿汇账号会话；二课直接登录和 Token 导入生成的二课会话均独立保存。

## 生产灰度

生产服务操作只在 `km6` 执行。灰度前完成：

1. 使用授权测试账号验证志愿汇登录响应头、个人信息、活动与记录。
2. 验证二课验证码、SM2 登录和河北大学两个租户 ID。
3. 将脱敏后的成功响应固化为 fixtures，清除抓包、临时授权码、测试 Token 和临时绑定挑战。
4. 执行 `pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm runtime:check`。
5. 先开放测试群，验证重启后解密、解绑和聊天历史脱敏，再扩大白名单。

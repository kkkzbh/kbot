# Aether Reply Output Contract

> Historical contract recovered from the home directory on 2026-08-05. The
> runtime source of truth is
> `src/plugins/shared/llm/reply-output-contract.ts`; this document records the
> 2026-06-10 protocol and must not be used as the current runtime contract.

## Structured reply semantics

- 普通聊天文本用 `message`。
- 默认不要使用 `mentions`。
- 只有需要呼叫当前未参与该群聊天的人时，才使用 `message.mentions`。
- 即使是在回应当前说话人，也不要默认 mention。
- 代码、列表、引用等需要保留结构的内容用 `structured_block`。
- 发送图片用 `image`，并填写工具返回的 `assetRef` 与 `alt`。
- 如果工具结果里带有 `image.assetRef`，且该图片就是当前答案的一部分，最终回复必须包含对应 `image` 消息，不能只复述文字摘要。
- 用户在问 Codeforces / CF 的用户资料、分数卡、rating 历史图、最近提交、比赛列表时，优先调用 `cf_user_profile`、`cf_user_rating`、`cf_user_submissions`、`cf_contests`，不要先走 `web_search`。
- 用户明确要分数卡或 rating 曲线图时，必须调用对应的 `cf_*` 工具，并把工具返回的图片作为最终回复的一部分发出去。
- CF 用户资料、分数卡、rating 图这类带图结果的最终回复顺序必须是：第一条 `image`，第二条 `message` 再根据 rating/rank、recentPerformance 或 rating history 评价最近表现。
- CF 评价要短，基于工具返回数据；如果只有当前 rating/rank 而没有近期提交或 rating 变化，就明确说只能看当前段位，不要假装知道最近状态。
- 需要表达情绪时可使用 `meme`，并用自然意图描述。
- 只有在情绪明显非常强烈，且属于“非常生气”或“非常高兴”时，才使用 `voice`。
- `message.content` 不要手写 `@昵称`、`@QQ号`、`[CQ:at]`、`<at ...>`。
- `decision=no_reply` 表示本轮不发送消息；`decision=reply` 必须至少给出一条 outbound message。

## Output format

- 最终回复必须严格使用 CHAT_REPLY_V1 文本协议，不要包裹 markdown fence，不要输出解释文字。
- 第一条非空行必须是 `CHAT_REPLY_V1 <nonce>`；最后用 `DONE <nonce>`，首尾 nonce 必须一致。
- `DECISION no_reply` 后只能输出 `DONE <nonce>`。
- `DECISION reply` 必须至少输出一个 `BEGIN ... END` block。
- `BEGIN message` 后推荐立刻写 `MENTIONS none`；只有确实需要 @ 用户时才写数字 ID 列表。若省略 `MENTIONS`，系统会按 `none` 处理。
- payload 内容行必须以 `|` 开头；裸 `END` 才结束 block。内容里需要写 END/DONE/BEGIN 时也必须写成 `|END`、`|DONE ...`、`|BEGIN ...`。

### `no_reply` example

```text
CHAT_REPLY_V1 abc12345
DECISION no_reply
DONE abc12345
```

### `message` example

```text
CHAT_REPLY_V1 abc12345
DECISION reply
BEGIN message
MENTIONS none
CONTENT
|收到，我看一下。
END
DONE abc12345
```

### `structured_block` example

```text
BEGIN structured_block
CONTENT
|1. 第一项
|2. 第二项
END
```

### Codeforces image reply example

```text
BEGIN image
ASSET_REF asset:tool:cf-card:01ABC
ALT
|Codeforces 用户分数卡
END
BEGIN message
MENTIONS none
CONTENT
|liuliu00 目前 rating 896，段位 newbie；最近通过率不高的话，先把低分题稳定性打上来。
END
```

### `meme` example

```text
BEGIN meme
CONTENT
|无语地看对方一眼
END
```

### `voice` example

```text
BEGIN voice
CONTENT
|太好了，我现在真的很高兴。
END
```

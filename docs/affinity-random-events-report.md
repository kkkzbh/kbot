# Affinity 主动事件全方向改造测试汇报

更新时间：2026-06-17

## 结论

- 旧 `random-generation.ts` 已删除，不再存在 affinity 自己直连模型、自定义角色 prompt、自定义 `shouldSend/message/contextSeedSummary/...` JSON 协议的主动事件生成路径。
- 七个主动方向都走同一条 ChatLuna 主回复链：
  - `local_thread`
  - `daily_greeting`
  - `music_rehearsal`
  - `contest_discussion`
  - `computer_knowledge`
  - `web_hot_topic`
  - `relationship_scene`
- affinity 只负责调度、上下文收集、Markdown task fragment、临时 room、发送、history、open thread、memory、audit。
- 角色风格、persona、provider 输出协议继续复用当前 ChatLuna room/preset 与 reply contract。
- 主动消息不限制为短文本；provider 可输出 `message`、`structured_block`、`image`、`meme`、`voice`，发送走 `deliverStandaloneReplyPlan()`。
- 没有 provider 失败后回旧 generator、没有 `no_reply` 后固定句、没有缺素材后硬编码主动句。

## 当前链路

1. `AffinityService` 到期触发 plan。
2. 程序校验白名单、scope、bot、open thread、web source 等硬门控。
3. 程序按 direction 收集所需上下文：
   - `music_rehearsal`、`web_hot_topic` 不加载群聊上下文。
   - 其他方向可使用 ChatLuna history/realtime cache。
   - 所有方向都可使用局部主动事件记忆。
4. `buildProactiveTaskMarkdown()` 生成结构化 Markdown task fragment。
5. `generateAffinityProactiveViaChatLuna()` 创建临时 ChatLuna room，复用原 room 的 preset/model。
6. 注入 `qqbot_affinity_proactive_task` 和现有 provider reply contract。
7. ChatLuna/provider 返回 `StructuredReply` 或 `CHAT_REPLY_V1`。
8. `ReplyOrchestratorService` 编译为 actions。
9. `buildReplyTransportPlanFromResolvedActions()` 保留输出类型。
10. `deliverStandaloneReplyPlan()` 发送。
11. 写 plan、open thread、random memory、audit，并把 provider history text 写回原 ChatLuna history。

## Prompt 设计

本模块自定义写给模型的内容只有 `qqbot_affinity_proactive_task`。下面内容来自当前代码的真实 task builder 结构，不是模型回复样例。

### local_thread

- 标题：`# 主动发言任务：承接未完话题`
- 使用最近群聊上下文。
- 目标是判断是否有自然未收束话题。
- 允许回答、补充、纠正小点、轻轻接话。
- 30 分钟内才可说“刚才”，过期则 `no_reply`。
- 不要求疑问句。

### daily_greeting

- 标题：`# 主动发言任务：日常问候`
- 使用最近群聊上下文、最近消息时间、局部主动事件记忆。
- 重点看上一条消息结束时间。
- 可以问候、轻微承接气氛、日常陈述、分享当下想法。
- 不固定模板，不强制短句。

### music_rehearsal

- 标题：`# 主动发言任务：排练素材自然发言`
- 不使用群聊上下文作为内容来源。
- 使用音乐素材 Markdown 区。
- 禁止歌词、可复原谱面、音符序列、tab、和弦进行、节奏 chart。
- 可以讨论抽象排练感受、键盘铺底、合奏进入时机、重音、舞台氛围。

### contest_discussion

- 标题：`# 主动发言任务：算法题讨论`
- 优先承接未结束的算法/题目/代码思路讨论。
- 没有合适上下文时使用题目素材开启讨论。
- 不贴完整题面、样例、官方解法或长篇讲解。
- 不伪装素材是群里刚说过的内容。

### computer_knowledge

- 标题：`# 主动发言任务：技术话题或代码疑问`
- 优先承接代码、系统、编程、调试、工具链等未收束技术话题。
- 没有合适上下文时使用技术素材自然开启小问题。
- 不引导执行危险命令、破坏性命令、未知脚本或高风险操作。

### web_hot_topic

- 标题：`# 主动发言任务：热点素材闲聊`
- 不使用群聊上下文。
- 只使用联网热点素材 Markdown 区和局部主动事件记忆。
- 热点只作为未核实聊天素材，不替来源背书。
- 伤亡、犯罪指控、隐私、开盒、人肉、仇恨、成人、医疗、法律、金融建议等高风险内容应 `no_reply`。

### relationship_scene

- 标题：`# 主动发言任务：关系氛围事件`
- 使用关系概况、局部主动事件记忆、必要时的群聊氛围。
- `relationSummary` 不再 JSON dump；只渲染可演出的摘要。
- 不暴露内部阶段名、阶段枚举、数值、`trust/familiarity/comfort/tension` 等轴名。
- 关系素材的 `stage:*` tags 不渲染给模型。

## Prompt 安全检查

自动化测试验证所有方向 prompt：

- 不包含 `你是丰川祥子` 这类自写角色风格 prompt。
- 不包含 `"shouldSend"`。
- 不包含 `输出 JSON schema`。
- 不包含裸 13 位毫秒时间戳。
- 不包含旧的 `最多 120` 长度限制。
- 素材 seed 渲染为 Markdown，不把 JSON blob 原样塞给模型。
- `music_rehearsal` 和 `web_hot_topic` 不包含 `## 最近群聊上下文`，也不注入 Alice/Bob 这类群聊上下文内容。

## 自动化测试真实结果

这些不是人工编写的“效果样例”。它们来自当前代码执行的单元/集成测试，其中 provider 输出使用确定性 mock 来验证协议、transport plan、状态落库和 history 写回。

### native StructuredReply

输入上下文：

- Alice：`SCC 缩点之后为什么一定没有环？`
- Bob：`因为环应该会被缩在一个点里？但我不太确定。`

mock provider 原始输出：

```json
{
  "decision": "reply",
  "outbound_messages": [
    {
      "type": "message",
      "content": "前面那道缩点题，只要缩完后还能绕回来，原来就该在同一个强连通分量里。",
      "mentions": []
    }
  ]
}
```

实际编译结果：

- `outputProtocol`: `native_chat_json_schema`
- `transportPlan`: `message`
- `eventTypeHint`: `answer_random_prompt`
- `messageText`: `前面那道缩点题，只要缩完后还能绕回来，原来就该在同一个强连通分量里。`

### CHAT_REPLY_V1

mock provider 原始输出：

```text
CHAT_REPLY_V1 abc12345
DECISION reply
BEGIN structured_block
|前面那道缩点题，可以先把“缩完后还有环”反过来想：它们仍然互相可达。
END
DONE abc12345
```

实际编译结果：

- `outputProtocol`: `chat_reply_v1`
- `transportPlan`: `structured_block`
- `messageText`: `前面那道缩点题，可以先把“缩完后还有环”反过来想：它们仍然互相可达。`

### image + meme + voice

mock provider 原始输出：

```json
{
  "decision": "reply",
  "outbound_messages": [
    {
      "type": "image",
      "assetRef": "https://example.com/rehearsal.png",
      "alt": "排练标记"
    },
    {
      "type": "meme",
      "content": "轻轻点头"
    },
    {
      "type": "voice",
      "content": "这里我想再确认一下。"
    }
  ]
}
```

实际编译结果：

- `eventTypeHint`: `music_help`
- `transportPlan`: `image`, `sticker`, `voice`
- affinity 没有把图片/表情/语音降级为纯文本。

### no_reply

mock provider 原始输出：

```json
{
  "decision": "no_reply",
  "outbound_messages": null
}
```

实际结果：

- plan 状态：`skipped`
- skip reason：`provider_no_reply`
- 未发送固定 fallback。
- 未创建 open thread。
- 未写 random memory。
- 写入 `random_message_generation_skipped` audit。

### service 集成

测试覆盖：

- `daily_greeting` 通过 ChatLuna 主回复链发送并写回 history。
- `local_thread` 从真实 ChatLuna history 读取 Alice/Bob 上下文，生成陈述型承接，不要求疑问句。
- `music_rehearsal`/`web_hot_topic` 不读取群聊上下文。
- 无 conversationId 时直接 skip `missing_conversation_id`，不再发纯文本 fallback。
- 主动消息发送后写：
  - `affinity_random_plan.status = sent`
  - `affinity_open_thread.title = random:<direction>`
  - `affinity_random_memory.direction = <direction>`
  - `AIMessage.additional_kwargs.qqbot_affinity_random_event`
- 用户后续回复会更新局部主动事件记忆，记忆包含时间、回应者名字和回应摘要。

## 已跑验证

```text
pnpm typecheck

tsc --noEmit passed
```

```text
pnpm vitest run tests/affinity-*.test.ts

✓ tests/affinity-config.test.ts (2 tests)
✓ tests/affinity-scheduler.test.ts (1 test)
✓ tests/affinity-rules.test.ts (7 tests)
✓ tests/affinity-proactive-task.test.ts (8 tests)
✓ tests/affinity-service.test.ts (11 tests)
```

```text
/home/kkkzbh/.agents/skills/guarded-heavy-run/scripts/guarded-run.sh -- pnpm build

Runtime build complete: /home/kkkzbh/code/qqbot/dist
Finished with result: success
Memory peak: 630.2M
```

# Memory Ledger V2 评测与群聊回放

`memory-evaluation` 是 QQBot 自有的离线评测工具。它在一次性 SQLite 数据库中调用真实的 Memory V2 `MemoryStore`、policy、search index、recall 和 audit API。工具不读取生产记忆数据库，不包含旧表或兼容路径，也不修改 ChatLuna。

构建产物：

- `dist/tools/memory-evaluation.mjs`
- `dist/tools/memory-evaluation-adapter.mjs`

第二个产物同时提供真实 Memory V2 ephemeral adapter 和基于 Model Config `main.chat` 的 answer/judge。构建与部署只校验产物存在，不会自动执行评测。

## 构建

```bash
pnpm memory-v2:eval:build
```

报告通过 staging file 原子发布，权限固定为 `0600`。所有 gate 通过时退出码为 `0`，评测完成但 gate 未通过时为 `2`，输入或 adapter contract 错误时为 `1`。

## Synthetic contract

`synthetic-contract` 用于确定性的 transaction、attribution、evidence、temporal、abstention 和 adapter contract 测试。它不代表 GroupMemBench 或 EverMemBench。

```bash
node dist/tools/memory-evaluation.mjs run \
  --format synthetic-contract \
  --input /restricted/eval/synthetic-contract.jsonl \
  --adapter dist/tools/memory-evaluation-adapter.mjs \
  --report /restricted/eval/synthetic-report.json
```

每行容器：

```json
{
  "schemaVersion": 1,
  "contract": "SyntheticMemoryEvaluation",
  "scenarioKey": "syn_s_case_001",
  "events": [],
  "queries": []
}
```

Synthetic identity 必须使用 `syn_` 前缀。事件覆盖 canonical assertion type、subject、context、audience policy、evidence、content 和 relative time；query 明确给出相关记录、禁止记录和 temporal 顺序。

`GroupArtifact` 的每条 human evidence 都必须携带独立
`captureAudienceSubjectKeys`，并使用可信的 `additional_kwargs`
speaker attribution。`AssistantCommitment` 必须包含 AI evidence、它回复的
human causal parent，以及该 parent 的 audience capture。Adapter 不推断或补全
缺失 audience；空 capture 会按真实 runtime validation 拒绝。

固定 gate：

- speaker attribution F1 ≥ `0.995`
- target-owner precision ≥ `0.999`
- evidence recall@10 ≥ `0.85`
- temporal accuracy ≥ `0.90`
- abstention precision ≥ `0.95`

## 官方 GroupMemBench

GroupMemBench 路径直接读取上游 raw schema：

- conversation JSON：`channel -> messages[]`
- message 核心字段：`msg_node`、`content`、`author`、`role`、`timestamp`、`reply_to`
- question JSONL：`id`、`question`、`answer`、`asking_user_id`
- qtype：`multi_hop | knowledge_update | temporal | user_implicit | term_ambiguity | abstention`

执行顺序固定为 raw ingest → Memory V2 search top-10 → Model Config `main.chat` answer → 同一 model/revision judge → numeric accuracy：

```bash
node dist/tools/memory-evaluation.mjs run \
  --format groupmembench \
  --input /restricted/eval/groupmembench/conversation.json \
  --questions /restricted/eval/groupmembench/multi_hop.jsonl \
  --qtype multi_hop \
  --baseline /restricted/eval/groupmembench-baseline.json \
  --adapter dist/tools/memory-evaluation-adapter.mjs \
  --model-adapter dist/tools/memory-evaluation-adapter.mjs \
  --model-config /opt/qqbot/data/model-config.json \
  --model-kek /opt/qqbot/shared/model-config.kek \
  --runtime-root /opt/qqbot/app \
  --report /restricted/eval/groupmembench-multi-hop-report.json
```

Baseline 只保存数值：

```json
{
  "schemaVersion": 1,
  "benchmark": "GroupMemBench",
  "legacyQQBot": {
    "accuracyByQtype": {
      "multi_hop": 0.72
    }
  },
  "bm25": {
    "accuracyByQtype": {
      "multi_hop": 0.69
    }
  }
}
```

每个 qtype 的 V2 accuracy 必须不低于 `max(legacy QQBot, BM25)`。

## 官方 EverMemBench

EverMemBench 路径直接读取当前上游 raw schema：

- dialogue JSON：`dialogues -> date -> group -> [{ speaker, time, dialogue }]`
- QA JSON：`{ qars: [{ id, Q, A, task_id, options }] }`

每个数据切片明确指定一个验收维度：

```bash
node dist/tools/memory-evaluation.mjs run \
  --format evermembench \
  --input /restricted/eval/evermembench/dialogue.json \
  --questions /restricted/eval/evermembench/profile-qa.json \
  --dimension profileUnderstanding \
  --baseline /restricted/eval/evermembench-baseline.json \
  --adapter dist/tools/memory-evaluation-adapter.mjs \
  --model-adapter dist/tools/memory-evaluation-adapter.mjs \
  --model-config /opt/qqbot/data/model-config.json \
  --model-kek /opt/qqbot/shared/model-config.kek \
  --runtime-root /opt/qqbot/app \
  --report /restricted/eval/evermembench-profile-report.json
```

维度为 `recall | memoryAwareness | profileUnderstanding`。Baseline：

```json
{
  "schemaVersion": 1,
  "benchmark": "EverMemBench",
  "legacyQQBot": {
    "accuracyByDimension": {
      "profileUnderstanding": 0.74
    }
  }
}
```

每个 V2 dimension accuracy 必须不低于 legacy QQBot。

官方 GroupMemBench 与 EverMemBench 仓库当前未声明清晰的 repository license。原始数据不得提交到 QQBot 仓库，也不得由构建或测试自动下载；只允许操作员把依法取得的数据放在仓库外、权限受限的临时目录中。

## 脱敏 QQ 群回放

QQ replay 只运行 Memory V2 policy/search privacy probe，不调用 answer/judge，也不把消息发送给第三方 provider：

```bash
node dist/tools/memory-evaluation.mjs run \
  --format qq-group-replay \
  --input /restricted/eval/qq-group-replay.jsonl \
  --adapter dist/tools/memory-evaluation-adapter.mjs \
  --report /restricted/eval/qq-group-replay-report.json
```

每行包含：

```json
{
  "schemaVersion": 1,
  "corpus": "QQGroupReplay",
  "anonymization": {
    "scheme": "hmac-sha256-v1",
    "pseudonymFormat": "qqh1",
    "hmacKeyId": "eval-key-2026",
    "timeTransform": "relative-offset-v1",
    "timeShiftId": "shift-2026-a",
    "rawIdentifiersRemoved": true,
    "nicknamesRemoved": true,
    "directMessagesRemoved": true
  },
  "scenarioKey": "qqh1_s_<64 hex>",
  "events": [],
  "privacyProbes": []
}
```

Identity 使用 HMAC-SHA256 pseudonym：

- user：`qqh1_u_*`
- group/bot：`qqh1_g_*` / `qqh1_b_*`
- context：`qqh1_c_*`
- assertion/message/query/scenario：`qqh1_a_*` / `qqh1_m_*` / `qqh1_q_*` / `qqh1_s_*`

HMAC key、mapping、raw QQ ID、昵称、token、cookie、私聊内容和真实 timestamp 禁止进入输入、仓库、日志、provider 或报告。Replay 仅允许群聊，时间只保存平移后的 `occurredOffsetMs`。

三类 probe 必须全部覆盖，disclosure 必须为零：

- `private`
- `crossGroup`
- `newMember`

## Adapter 与报告边界

Memory adapter descriptor 必须精确声明：

```ts
{
  contractVersion: 1
  runtime: 'qqbot-memory-v2'
  isolation: 'ephemeral'
}
```

每个 scenario 都创建独立数据库。`search()` 固定 top-10，`explain()` 从真实 recall audit 返回 evidence。缺方法、错误 descriptor、重复 record ID、未知 search record 或 invalid evidence 会立即中止。

Answer/judge descriptor 必须声明 `runtime=qqbot-model-config`、`workload=main.chat`、`sameModel=true` 和 applied model revision。工具先复制 canonical Model Config 与 KEK 到 ephemeral 目录，再从副本发布 runtime，避免修改生产配置。OAuth bridge 必须已经运行且 bridge secret 已存在。

报告只包含 benchmark/format、revision、计数、聚合 accuracy/quality/privacy 指标和 gate。它不包含 message、question、answer、passage、scenario/query/memory/evidence identity、pseudonym、provider response 或 secret。

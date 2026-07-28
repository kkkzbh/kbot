# Memory Ledger V3 cutover

Memory Ledger V3 is the breaking boundary from the production V2 ledger to an
empty, Tool-first lexical ledger. QQBot owns the ledger, extraction, policy,
search, and `memory_search` Tool. ChatLuna remains an unmodified upstream
dependency and only exposes its public Tool registry.

## Cutover contract

- Model Config V2 is converted to V3 by removing every embedding profile and
  the `memory.embedding` workload. Connections, encrypted secrets, chat models,
  and all other bindings remain byte-for-byte equivalent at the field level.
- Every `memory_v2_*` relation is permanently deleted with SQLite
  `secure_delete`, followed by integrity check, checkpoint, `VACUUM`, fsync, and
  atomic database replacement.
- The new database begins with the complete `memory_v3_*` schema and no events,
  payloads, evidence, heads, work, cursors, suppression rows, audits, lexical
  documents, or lexical terms.
- Runtime schema registration rejects V2, partial V3, mixed, and unknown memory
  relations. It never performs migration.
- Memory read and write remain disabled after cutover. Production verification
  uses the extraction probe and an empty-result `memory_search` smoke without
  creating memory.

## Commands

```bash
pnpm memory-v3:build
node dist/tools/model-config-v3-cutover.mjs preflight \
  --config /opt/qqbot/data/model-config.json \
  --report /restricted/model-config-v3.json
node dist/tools/memory-v3-cutover.mjs preflight \
  --database /opt/qqbot/data/koishi.db \
  --report /restricted/memory-v3.json
```

`apply` requires system-level `qqbot.target` to be stopped and revalidates the
preflight digest before mutation. Reports are content-free and mode `0600`.

## Deployment transaction

The installer disables boot ownership, snapshots the database, application,
Model Config, KEK, environment, presets, Agent data, and systemd units, then
applies both V3 cutovers before publishing the new application. Offline
failures restore the paired snapshot. Once the new runtime starts, failures
stop the target and require roll-forward so runtime writes are never paired
with an older application.

`qqbot-koishi.service` publishes
`/run/qqbot/memory-v3-ready.json` only after strict V3 schema validation, public
Tool registration, and a live applied `memory.extract` binding. Host
verification checks file permissions, PID/cgroup ownership, schema version,
and applied Model Config revision before re-enabling `qqbot.target`.

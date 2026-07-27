# Memory Ledger V2 cutover

`memory-v2-cutover` is the one-shot production boundary from the legacy QQBot
memory tables to Memory Ledger V2. The runtime has no legacy reader, dual
writer, alias, or migration fallback.

The sibling ChatLuna checkout is treated as an unmodified upstream dependency.
QQBot stops loading its long-memory runtime and rejects or removes the
`longMemory` preset block at the QQBot boundary; the cutover does not delete or
patch ChatLuna packages, source files, or tests.

## Profile decision

Legacy `memory_profile` rows are derived summaries. V2 does not persist a
second profile projection. Profile understanding is derived on read from
canonical active heads.

Preflight therefore requires every one of the four legacy profile rows to
resolve to at least one of the 59 active heads with the same immutable subject
and source context. A missing source aborts preflight. The content-free report
records:

- `decisions.profilesDerivedOnRead`
- `decisions.profileDerivationMode = active-heads-on-read`
- `decisions.profileSubjectContexts`
- `decisions.profileSourceActiveHeads`

Apply writes one `migration-profile-derived-on-read` audit per legacy profile
and deletes the legacy profile body with the rest of the old schema. Bootstrap
and final verification require all four audits to retain a matching active-head
source. No derived profile text is migrated or regenerated during cutover.

## Release sequence

1. `preflight` validates the exact 373/43 production baseline, source digest,
   Admin event preservation digest, model revision, context presets, audience
   decisions, cursor boundaries, and profile derivation sources. Every active
   assertion must also map its evidence speaker to the immutable principal
   `userId` and have exact verified legacy provenance for the same owner,
   context, message IDs, and speaker IDs.
2. `apply` runs only while `qqbot.target` and `qqbot-koishi.service` are
   inactive. It publishes the staged database, context-preset cleanup, and
   pending model revision with durable backups. Snapshot rollback remains
   available only in this offline phase. Before any publication,
   `qqbot.target` is disabled and the fsynced deployment transaction phase is
   written under `/opt/qqbot/shared`; a reboot cannot start the old app over a
   V2 database.
3. The first startup uses `MEMORY_MAINTENANCE=true` with read and write closed.
   `bootstrap-verify` requires 59 active heads, 59 FTS rows, zero embeddings,
   and exactly 59 untouched pending backfill jobs.
4. Maintenance is released while read and write remain closed. `probe-gate`
   requires three successful `memory.extract` probes and three successful
   `memory.embedding` probes. Every response must match the expected canonical
   model and semantic schema; embedding dimensions must be positive and stable.
5. `verify` opens the final gate only when all 59 current embeddings exist,
every backfill job succeeded, and stranded, orphan, stale, inactive,
pending, leased, and dead-letter counts are zero.

The target remains disabled throughout these gates. Controlled manual starts
allow verification without restoring boot ownership. Each installer
invocation loads the persisted phase, so a V2 database at `runtime-probes` or
`runtime-backfill` resumes those gates instead of taking the ordinary
already-migrated path. `qqbot.target` is re-enabled only after final
verification succeeds.

Legacy extraction job keys are validated only as source data. Every migrated
cursor and discard watermark uses the runtime identity
`lane:${sha256(JSON.stringify([subjectKey, contextKey]))}` from the shared
Memory identity function. The cutover integration test opens the migrated
database through the real runtime store and verifies that enqueue, window read,
and finalize continue the same cursor without replaying a discarded window.

Recall and extraction remain closed after this sequence. Evaluation and
privacy gates control the later read/write rollout.

Immediately before the first `qqbot.target` start, the installer transfers
ownership of the application, database, configuration, and units to the new
runtime. From that point, Koishi and unrelated plugins may commit database
writes. A startup, probe, backfill, or final-gate failure therefore stops the
stack and keeps the new application/database pair intact for roll-forward
repair. The installer never restores the stopped-phase database snapshot after
runtime ownership transfer. This boundary also prevents an old application
from being paired with a database already touched by the new runtime.
Host verification additionally requires the Memory plugin's private
`/run/qqbot` readiness marker to match the active Koishi `MainPID`,
schemaVersion 2, and the applied model revision. A Cordis-caught plugin startup
failure cannot pass through HTTP liveness alone.

## Fresh databases

An absent database or a database with no memory tables follows the explicit
`initialize` path after system services stop. The command preserves unrelated
tables, creates the complete V2 schema in a staged SQLite database, writes
`schemaVersion=2` and `initializationMode=fresh`, verifies integrity, and
atomically publishes it. Initialization refuses legacy, partial V2, mixed, or
unknown memory tables.

The installer pins `MEMORY_READ_ENABLED=false` and
`MEMORY_WRITE_ENABLED=false` for this path. Runtime schema registration does
not create the canonical meta row and is never used as an initialization or
migration fallback.

## Commands

Build the artifact with:

```bash
pnpm memory-v2:build
```

The supported one-shot commands are:

```text
memory-v2:status
memory-v2:initialize
memory-v2:preflight
memory-v2:apply
memory-v2:bootstrap-verify
memory-v2:probe-gate
memory-v2:verify
```

Preflight and apply reports are content-free and must remain mode `0600`.

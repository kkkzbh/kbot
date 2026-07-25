# Preset V2 production cutover

This runbook applies to the single production instance on `km6`. The V2
runtime rejects V1 YAML and requires `chatluna_meta.globalDefaultPresetId`, so
QQBot and ChatLuna must be released together.

## Preconditions

- Build and verify the coordinated QQBot/ChatLuna release before uploading it.
- Upload the coordinated `qqbot.tar.gz` release without running the normal
  deployment command.
- Confirm the release contains the five V2 bundled presets and the standalone
  `qqbot/dist/tools/preset-v2-cutover.mjs` plus
  `qqbot/dist/tools/preset-v2-sqlite.py`.
- Keep enough free space for an application backup, a SQLite backup, two
  copies of the runtime preset directory, the new persistent archive copy, and
  the tool-owned legacy archive retention copy.
- Choose a cutover directory whose name includes the UTC timestamp.
- Confirm the legacy application archive source is
  `/opt/qqbot/app/qqbot/data/chatluna/archive`.
- Reserve `/opt/qqbot/data/chatluna/archive` as the new persistent archive
  target. It must be absent or empty before cutover.
- Every recoverable `chatluna_archive.path` must resolve below the legacy
  source without symlinks. Source, target, and staging must be separate trees.
  Do not use `/`, `/opt/qqbot`, or another broad directory for any archive
  root.

The migration command reads preset identities only. Do not pass passwords,
cookies, API keys, or session data on its command line.

## 1. Read-only preflight

Extract the release into a private directory. The tool is bundled with all
JavaScript dependencies and does not use the active application's
`node_modules`.

```bash
sudo install -d -m 700 /opt/qqbot/incoming/<release>
sudo tar -xzf /opt/qqbot/incoming/qqbot.tar.gz \
  -C /opt/qqbot/incoming/<release>
sudo install -d -m 700 /opt/qqbot/backup/<cutover>
```

Run preflight while the old service is still available:

```bash
sudo /usr/bin/node \
  /opt/qqbot/incoming/<release>/qqbot/dist/tools/preset-v2-cutover.mjs \
  preflight \
  --database /opt/qqbot/data/koishi.db \
  --bundled-dir /opt/qqbot/incoming/<release>/qqbot/data/chathub/presets \
  --runtime-dir /opt/qqbot/data/chathub/presets \
  --archive-source-root /opt/qqbot/app/qqbot/data/chatluna/archive \
  --archive-target-root /opt/qqbot/data/chatluna/archive \
  --global-default sakiko \
  --report /opt/qqbot/backup/<cutover>/preset-v2-preflight.json
```

The command must report:

- every effective preset with one canonical ID;
- zero unresolved IDs or aliases;
- every database rewrite and recoverable archive source-to-target relocation;
- `globalDefaultPresetId` pointing to an effective preset;
- every alias-lane merge in `bindingMerges`, including its source rows, retained
  row, selected active/last conversation, maximum `updatedAt`, and removed
  source rows;
- every sequence repair in `conversationSeqRenumbers`.

Stop here if any identity is unknown or ambiguous. Add an explicit migration
mapping in source, rebuild the release, and run preflight again.

When several legacy preset lanes map to one canonical binding key, preflight
uses the following deterministic merge:

1. all conversations are retained and their binding keys are rewritten to the
   canonical lane;
2. `activeConversationId` comes from the valid active pointer on the binding
   row with the latest `updatedAt`;
3. `lastConversationId` is the latest remaining valid active/last pointer with
   an ID different from the selected active conversation;
4. the target binding keeps the maximum source `updatedAt`; a pre-existing
   canonical row is retained as the physical row, otherwise the
   lexicographically first source key is retained;
5. all other source binding rows are deleted inside the migration transaction;
6. already unique positive conversation `seq` values stay fixed. Null,
   non-positive, and colliding values receive the smallest available positive
   integers ordered by `createdAt`, existing `seq`, `updatedAt`, then
   conversation ID.

Review every reported merge before stopping the service. In particular, verify
that old `saki`, `小祥`, and `祥` lanes converge on the expected `sakiko`
binding and that the chosen active/last conversation IDs still exist.

## 2. Stop and back up production

```bash
sudo systemctl stop qqbot.target
sudo systemctl is-active qqbot.target
sudo systemctl is-active qqbot-koishi.service
```

Both status checks must report `inactive`. Then back up:

- `/opt/qqbot/app`;
- `/opt/qqbot/data/koishi.db` through SQLite backup semantics;
- `/opt/qqbot/data/chathub/presets`;
- the recoverable archive directories listed in the preflight report;
- `/opt/qqbot/shared/.env.server` and the generated runtime env file.

The cutover tool also creates
`<backup-dir>/legacy-archive-source` by copying each recoverable legacy
archive and verifying its artifact hash. The active application source remains
unchanged. The installer later replaces the old application tree, so the
tool-owned retention copy is the authoritative V1 archive source for rollback
after release activation.

The apply command repeats both systemd checks using `/usr/bin/systemctl` and
refuses to mutate data unless `qqbot.target` and `qqbot-koishi.service` both
have `ActiveState=inactive`.

## 3. Apply the offline migration

Run a fresh preflight and apply in one invocation after the service has
stopped:

```bash
sudo /usr/bin/node \
  /opt/qqbot/incoming/<release>/qqbot/dist/tools/preset-v2-cutover.mjs \
  apply \
  --database /opt/qqbot/data/koishi.db \
  --bundled-dir /opt/qqbot/incoming/<release>/qqbot/data/chathub/presets \
  --runtime-dir /opt/qqbot/data/chathub/presets \
  --archive-source-root /opt/qqbot/app/qqbot/data/chatluna/archive \
  --archive-target-root /opt/qqbot/data/chatluna/archive \
  --archive-staging-dir /opt/qqbot/data/chatluna/archive.v2-staging \
  --global-default sakiko \
  --staging-dir /opt/qqbot/data/chathub/presets.v2-staging \
  --backup-dir /opt/qqbot/backup/<cutover>/preset-v2-tool \
  --report /opt/qqbot/backup/<cutover>/preset-v2-applied.json \
  --systemctl /usr/bin/systemctl \
  --confirm-service-stopped
```

The apply command:

1. reruns all identity and reference checks;
2. schema-validates, compiles, writes, and round-trips every effective preset;
3. creates SQLite and runtime preset backups plus a hash-verified legacy
   archive retention copy;
4. copies every recoverable directory or gzip archive into archive staging,
   verifies the whole-artifact hash, writes migrated conversation content,
   verifies it again, and atomically moves each staged artifact below the
   persistent target root;
5. starts `BEGIN IMMEDIATE`, verifies the complete preset, binding pointer,
   conversation sequence, timestamp, and archive-path database snapshot still
   equals preflight, then applies preset references, binding merges, sequence
   repairs, archive paths, and the global default in that transaction;
6. renames the old runtime preset directory and activates the staged V2
   directory.

The legacy application archive is never modified. When any apply step fails,
the tool restores the database and runtime preset directory and removes every
activated target archive plus its staging directory. An incomplete rollback is
reported explicitly and requires keeping the service stopped. The tool creates
backup directories with mode `0700` and backup/report files with mode `0600`.

## 4. Activate the coordinated release

Install the release while retaining the stopped state:

```bash
sudo QQBOT_BASE_DIR=/opt/qqbot \
  bash /opt/qqbot/incoming/<release>/qqbot/deploy/installer.sh \
  /opt/qqbot/incoming/qqbot.tar.gz full keep-stopped
```

The installer removes `CHATLUNA_DEFAULT_PRESET` and
`CHATLUNA_PRESET_DIRS` from both server and generated runtime environment
files. It renders the systemd units and generated runtime environment with:

```text
CHATLUNA_BUNDLED_PRESET_DIR=/opt/qqbot/app/qqbot/data/chathub/presets
CHATLUNA_RUNTIME_PRESET_DIR=/opt/qqbot/data/chathub/presets
CHATLUNA_ARCHIVE_DIR=/opt/qqbot/data/chatluna/archive
```

While `qqbot.target` is running, `PresetService` is the exclusive writer for
the runtime preset directory. Apply live changes through the Admin API so
schema validation, revision checks, atomic file replacement, and in-memory
activation remain one transaction boundary. Direct file writes are rejected
when detected and are unsupported. The migration tool changes this directory
only while the target is stopped.

Any installer failure after application activation begins explicitly stops
`qqbot.target`.

## 5. Start and verify

```bash
sudo systemctl start qqbot.target
sudo systemctl status qqbot.target --no-pager
sudo journalctl -u qqbot-koishi.service -n 200 --no-pager
sudo QQBOT_BASE_DIR=/opt/qqbot \
  bash /opt/qqbot/app/qqbot/deploy/verify.sh full
```

If startup or verification fails, immediately run
`sudo systemctl stop qqbot.target` and follow the rollback section.

Verify through the authenticated Admin UI/API:

- the selected preset equals live `globalDefaultPresetId`;
- all five bundled IDs load with the expected source and revision;
- a bundled edit creates a runtime override and revert restores bundled data;
- changing the global default updates the live runtime without restart;
- one normal conversation records a context snapshot whose request ID joins
  the provider usage event;
- snapshot messages contain no internal metadata, credentials, or raw binary
  data.

Also verify that every ready archive row points below
`/opt/qqbot/data/chatluna/archive` and that restore/export works for one
pre-cutover archive. ChatLuna rejects archive database paths outside the
configured archive root and rejects symlinked archive paths.

## 6. Finalize legacy archive retention

Keep the tool backup and legacy archive retention copy through the agreed
rollback window. Finalize only after the coordinated release has remained
healthy and a database backup taken after cutover is available.

```bash
sudo sqlite3 /opt/qqbot/data/koishi.db \
  "select id, path from chatluna_archive where state = 'ready' and path not like '/opt/qqbot/data/chatluna/archive/%';"
```

The query must return no rows. Compare the applied report's
`archiveRelocationVerification` hashes with the retained source, then move the
exact retention directory into the finalized cutover backup:

```bash
sudo mv \
  /opt/qqbot/backup/<cutover>/preset-v2-tool/legacy-archive-source \
  /opt/qqbot/backup/<cutover>/finalized-legacy-archive-source
```

This explicit finalize action ends the migration tool's retention
responsibility. Do not recursively remove `/opt/qqbot/data`,
`/opt/qqbot/backup`, or another parent directory.

## Rollback

Keep `qqbot.target` stopped. Restore the old application, SQLite database,
runtime preset directory, and prior generated runtime environment from the
same cutover backup. Restore the legacy archive source from
`preset-v2-tool/legacy-archive-source`, remove the new persistent archive
target, and start the old target only after all resources belong to the old
release again.

Snapshots created after cutover stay in memory and require no database
rollback. Historical model calls have no V2 snapshots.

# Canonical model-config production cutover

This runbook applies the one-time legacy model configuration migration on the
single production instance at `km6`. The migration creates
`/opt/qqbot/data/model-config.json` and
`/opt/qqbot/shared/model-config.kek`, rewrites persisted model references, and
removes the retired model environment keys.

## Preconditions

- Use a maintenance window and stop Admin model or Agent edits before
  activation.
- Keep enough free space for the active application, SQLite, Agent data,
  recoverable archives, preset catalogs, environment files, and systemd units.
- Confirm the coordinated bundle contains
  `qqbot/dist/tools/model-config-cutover.mjs`.
- Confirm the legacy SQLite database exists at
  `/opt/qqbot/data/koishi.db`.
- The canonical document and KEK must either both exist or both be absent.
  A one-sided pair is an error.
- Do not put passwords, API keys, cookies, or tokens in the mapping file or on
  the command line.

A clean install with no legacy database does not use this migration. Create or
import an explicit canonical model-config document and KEK before starting a
clean installation. The installer does not guess a model, endpoint, or
credential and does not create default credentials.

## Explicit legacy model mapping

Unambiguous, exactly configured models are resolved automatically. Ambiguous
historical values require
`/opt/qqbot/shared/model-config-mapping.json`, mode `0600`. The file is a JSON
object whose keys are exact legacy model strings and whose values are
configured migration profile IDs:

```json
{
  "deepseek/deepseek-chat": "legacy:openai-generic",
  "deepseek/deepseek-v4-pro": "legacy:openai-generic",
  "deepseek/deepseek-reasoner": "legacy:openai-generic",
  "openai/gemini-3.1-pro-preview": "main:openai",
  "openai/gpt-5-mini": "main:openai",
  "openai/gpt-5.4-medium-thinking": "main:openai",
  "openai/gpt-5.4-mini": "main:openai",
  "openai/gpt-5.5": "main:openai"
}
```

Include only values present in the reviewed production inventory. Duplicate
keys, unavailable targets, unknown models, and conflicting resolutions abort
preflight. `openai/auto` has the fixed Copilot interpretation and cannot be
mapped to another profile.

Install the reviewed file:

```bash
ssh km6 'sudo install -d -m 700 /opt/qqbot/shared'
scp model-config-mapping.json km6:/tmp/model-config-mapping.json
ssh km6 'sudo install -m 600 /tmp/model-config-mapping.json /opt/qqbot/shared/model-config-mapping.json && rm /tmp/model-config-mapping.json'
```

The mapping file contains no secrets. It is included in both the migration
backup and the deployment transaction backup.

## Build, upload, and activate

Build and upload the committed coordinated release:

```bash
QQBOT_DEPLOY_MODE=upload-only deploy/deploy.sh km6
```

Materialize and run the uploaded installer:

```bash
ssh km6 '
  sudo tar -xOf /opt/qqbot/incoming/qqbot.tar.gz \
    qqbot/deploy/installer.sh \
    > /opt/qqbot/incoming/model-config-installer.sh
  sudo chmod 700 /opt/qqbot/incoming/model-config-installer.sh
  sudo QQBOT_BASE_DIR=/opt/qqbot \
    bash /opt/qqbot/incoming/model-config-installer.sh \
    /opt/qqbot/incoming/qqbot.tar.gz full start
'
```

The installer performs these boundaries:

1. runs a read-only, zero-write model preflight while the old service remains
   active;
2. scans layered server/runtime env, SQLite conversation/room/automation and
   affinity state, persistent `data/chatluna/agents`, the legacy app Agent
   catalog and Markdown roots, and every recoverable archive;
3. reports redacted connections, the explicit legacy-to-canonical model map,
   Agent ID map, disabled/inherited workload decisions, and the folded context
   budget;
4. stops `qqbot.target` and snapshots the old application, SQLite, env, Agent
   data, archives, preset catalogs, mapping file, and systemd artifacts;
5. applies Context/Role preset and model-config migrations while stopped;
6. atomically swaps the application, starts the target, and runs full
   verification.

`CHATLUNA_MAX_CONTEXT_RATIO` is validated in `(0, 1]` and folded into each
canonical chat model `contextSize`. The old default and current production
value `0.35` therefore produce an effective budget of `44,800` from the legacy
`128,000` context size.

The generated runtime env owns
`CHATLUNA_AGENT_DATA_DIR=/opt/qqbot/data/chatluna`; the active Agent config is
`/opt/qqbot/data/chatluna/agents/config.json`.

## Verification

After activation:

```bash
ssh km6 '
  sudo systemctl status qqbot.target qqbot-koishi.service --no-pager
  sudo QQBOT_BASE_DIR=/opt/qqbot \
    bash /opt/qqbot/app/qqbot/deploy/verify.sh full
  sudo journalctl -u qqbot-koishi.service -n 250 --no-pager
'
```

Confirm:

- the canonical document and KEK both exist with mode `0600`;
- every reported connection has the expected adapter, normalized endpoint,
  and redacted credential state;
- no report contains an API key or encrypted secret payload;
- persisted conversation, room, Agent, and archive references use canonical
  IDs;
- Search inherits the invocation model when its legacy value was empty;
- blank Affinity inherits main chat;
- incomplete Memory and Natural Trigger model triples are disabled;
- Automation inherits the invocation/room model;
- the retired model and Automation env keys are absent from both env layers.

## Rollback

Any failure after cutover begins invokes the installer transaction rollback.
It restores the old application, SQLite, both env layers, persistent and
legacy Agent artifacts, archives, preset catalogs, mapping file, and systemd
units; reloads systemd; starts the previous target; and verifies the previous
release.

If rollback itself fails, the installer keeps `qqbot.target` stopped and prints
the exact recovery directory:

```text
/opt/qqbot/backup/deploy-<UTC timestamp>-<pid>
```

Do not start the failed release. Preserve that directory together with the
`model-config-*` and `context-presets-*` backups until recovery is complete.

# Context and role preset production cutover

This runbook applies to the single production instance on `km6`. The release
splits every Preset V2 resource into a shared Role Preset V1 and an outer
Context Preset V1 while keeping all persisted preset IDs unchanged.

## Preconditions

- Use a maintenance window and stop Admin preset edits before the final
  preflight.
- Build and verify QQBot and ChatLuna together.
- Confirm the release contains:
  - `qqbot/data/chathub/context-presets`;
  - `qqbot/data/chathub/role-presets`;
  - `qqbot/dist/tools/context-preset-cutover.mjs`;
  - `qqbot/dist/tools/context-preset-sqlite.py`.
- Confirm `/opt/qqbot/data/chathub/context-presets` and
  `/opt/qqbot/data/chathub/role-presets` are absent or empty.
- Keep enough free space for the active application, a SQLite backup, both
  legacy preset catalogs, generated environment files, and systemd units.
- Do not pass passwords, cookies, tokens, or session data on the migration
  command line.

The migration reads preset-reference columns only. It rejects aliases in
persisted references, unknown IDs, malformed catalogs, unsafe anchors, and
non-YAML catalog entries.

## 1. Build and upload the coordinated release

From the local QQBot checkout:

```bash
QQBOT_DEPLOY_MODE=upload-only deploy/deploy.sh km6
```

The deployment builder uses committed QQBot `HEAD` and requires a clean
ChatLuna worktree. Do not continue if the uploaded bundle was built from
different revisions than the locally verified release.

On `km6`, choose UTC-stamped release and backup names, then extract the bundle
into a private directory:

```bash
release="context-presets-$(date -u +%Y%m%dT%H%M%SZ)"
cutover="${release}"

sudo install -d -m 700 "/opt/qqbot/incoming/${release}"
sudo tar -xzf /opt/qqbot/incoming/qqbot.tar.gz \
  -C "/opt/qqbot/incoming/${release}"
sudo install -d -m 700 "/opt/qqbot/backup/${cutover}"
```

Keep these exact names available for the remaining commands.

## 2. Run the read-only preflight

Run preflight while the current service remains available:

```bash
sudo /usr/bin/node \
  "/opt/qqbot/incoming/${release}/qqbot/dist/tools/context-preset-cutover.mjs" \
  preflight \
  --database /opt/qqbot/data/koishi.db \
  --legacy-bundled-dir /opt/qqbot/app/qqbot/data/chathub/presets \
  --legacy-runtime-dir /opt/qqbot/data/chathub/presets \
  --bundled-role-dir \
    "/opt/qqbot/incoming/${release}/qqbot/data/chathub/role-presets" \
  --bundled-context-dir \
    "/opt/qqbot/incoming/${release}/qqbot/data/chathub/context-presets" \
  --runtime-role-dir /opt/qqbot/data/chathub/role-presets \
  --runtime-context-dir /opt/qqbot/data/chathub/context-presets \
  --report "/opt/qqbot/backup/${cutover}/preflight.json"
```

Review the report before stopping services. It must show:

- all bundled and runtime preset IDs;
- `databaseReferencesChanged: false`;
- `database.canonicalReferencesUnchanged: true`;
- an empty `database.unresolvedReferences`;
- the expected `globalDefaultContextPresetId`;
- matching runtime Role and Context catalog digests.

For the current production dataset, all conversations and the global default
must remain on the canonical outer Context ID `sakiko`.

## 3. Create pre-activation backups

Create a SQLite-consistent backup and copy the rollback resources:

```bash
sudo /usr/bin/python3 \
  "/opt/qqbot/incoming/${release}/qqbot/dist/tools/context-preset-sqlite.py" \
  backup \
  /opt/qqbot/data/koishi.db \
  "/opt/qqbot/backup/${cutover}/pre-activation-koishi.db"

sudo cp -a \
  /opt/qqbot/app \
  "/opt/qqbot/backup/${cutover}/app"
sudo cp -a \
  /opt/qqbot/data/chathub/presets \
  "/opt/qqbot/backup/${cutover}/legacy-runtime-presets"
sudo install -m 600 \
  /opt/qqbot/shared/.env.server \
  "/opt/qqbot/backup/${cutover}/env.server"
sudo install -m 600 \
  /opt/qqbot/shared/.env.runtime \
  "/opt/qqbot/backup/${cutover}/env.runtime"

sudo tar -czf "/opt/qqbot/backup/${cutover}/systemd-units.tar.gz" \
  -C / \
  etc/systemd/system/qqbot.target \
  etc/systemd/system/qqbot-llbot.service \
  etc/systemd/system/qqbot-koishi.service \
  etc/systemd/system/cloudflared-qqbot-hbu-jw.service \
  etc/systemd/system/cloudflared-qqbot-genshin.service \
  etc/containers/systemd/qqbot-pmhq.container
sudo chmod 600 "/opt/qqbot/backup/${cutover}/systemd-units.tar.gz"
```

The installer creates a second SQLite-consistent backup and catalog copy after
the services stop. The pre-activation copy protects the state that was
reviewed during preflight.

## 4. Activate the release

Materialize the installer outside its managed staging directory:

```bash
sudo tar -xOf /opt/qqbot/incoming/qqbot.tar.gz \
  qqbot/deploy/installer.sh \
  > "/opt/qqbot/incoming/${release}-installer.sh"
sudo chmod 700 "/opt/qqbot/incoming/${release}-installer.sh"
```

Run the installer in normal `start` mode:

```bash
sudo QQBOT_BASE_DIR=/opt/qqbot \
  bash "/opt/qqbot/incoming/${release}-installer.sh" \
  /opt/qqbot/incoming/qqbot.tar.gz \
  full \
  start
```

The installer performs the coordinated boundary:

1. validates the staged runtime and reruns migration preflight;
2. stops `qqbot.target`;
3. verifies both `qqbot.target` and `qqbot-koishi.service` are inactive;
4. creates the authoritative SQLite and legacy-catalog backup under
   `/opt/qqbot/backup/context-presets-<UTC timestamp>`;
5. writes the runtime Role and Context catalogs through staging directories
   tracked by `/opt/qqbot/data/chathub/.context-role-v1-cutover.json`;
6. replaces the application, renders the four new directory env keys, and
   starts `qqbot.target`;
7. runs full verification;
8. removes `/opt/qqbot/data/chathub/presets` only after verification succeeds.

The catalog transaction is idempotent across process termination, including
termination between the Role and Context directory installs. A retry verifies
the stored digests and the authoritative backup before completing the missing
install. If the outer deploy transaction restores empty preset targets during
rollback, the next retry reinstalls both catalogs from the same durable
transaction.

For an intentionally stopped installation, pass `keep-stopped`. That mode
retains the old runtime catalog and requires an explicit start, verification,
and later legacy-catalog finalization.

## 5. Verify production

Run service and log checks:

```bash
sudo systemctl status \
  qqbot.target \
  qqbot-pmhq.service \
  qqbot-llbot.service \
  qqbot-koishi.service \
  --no-pager

sudo journalctl -u qqbot-koishi.service -n 250 --no-pager

sudo QQBOT_BASE_DIR=/opt/qqbot \
  bash /opt/qqbot/app/qqbot/deploy/verify.sh full
```

Confirm the generated environment exposes only the new directory keys:

```bash
sudo sed -n \
  's/^\(CHATLUNA_\(BUNDLED\|RUNTIME\)_\(CONTEXT\|ROLE\)_PRESET_DIR\)=.*/\1/p' \
  /opt/qqbot/shared/.env.runtime
```

Verify through the authenticated Admin workspace:

- navigation opens `/intelligence/context-presets`;
- all five Context Presets and all five Role Presets load;
- `sakiko` remains the global default;
- each initial Context references the same-ID shared Role;
- draft preview resolves the contiguous stack and both Runtime blocks;
- an invalid anchor returns a typed error with `blockId` and `stage`;
- saving a Role changes every referencing Context without changing their
  revisions;
- “另存为新角色” creates a separate Role and leaves the Context draft dirty;
- a normal QQ context request succeeds and the backend diagnostic snapshot
  still joins the provider usage event.

Also verify that runtime writes appear only below:

```text
/opt/qqbot/data/chathub/context-presets
/opt/qqbot/data/chathub/role-presets
```

Keep both backup directories through the rollback window.

## Rollback

Keep all services stopped:

```bash
sudo systemctl stop qqbot.target
sudo systemctl is-active qqbot.target
sudo systemctl is-active qqbot-koishi.service
```

Both status commands must report `inactive`. Move the failed resources into
the cutover backup, then restore the exact pre-activation state:

```bash
sudo mv \
  /opt/qqbot/app \
  "/opt/qqbot/backup/${cutover}/failed-app"
sudo cp -a \
  "/opt/qqbot/backup/${cutover}/app" \
  /opt/qqbot/app

sudo install -m 600 \
  "/opt/qqbot/backup/${cutover}/env.server" \
  /opt/qqbot/shared/.env.server
sudo install -m 600 \
  "/opt/qqbot/backup/${cutover}/env.runtime" \
  /opt/qqbot/shared/.env.runtime

if sudo test -d /opt/qqbot/data/chathub/context-presets; then
  sudo mv \
    /opt/qqbot/data/chathub/context-presets \
    "/opt/qqbot/backup/${cutover}/failed-context-presets"
fi
if sudo test -d /opt/qqbot/data/chathub/role-presets; then
  sudo mv \
    /opt/qqbot/data/chathub/role-presets \
    "/opt/qqbot/backup/${cutover}/failed-role-presets"
fi
if sudo test -d /opt/qqbot/data/chathub/presets; then
  sudo mv \
    /opt/qqbot/data/chathub/presets \
    "/opt/qqbot/backup/${cutover}/failed-legacy-runtime-presets"
fi
sudo cp -a \
  "/opt/qqbot/backup/${cutover}/legacy-runtime-presets" \
  /opt/qqbot/data/chathub/presets

for file in koishi.db koishi.db-wal koishi.db-shm; do
  if sudo test -e "/opt/qqbot/data/${file}"; then
    sudo mv \
      "/opt/qqbot/data/${file}" \
      "/opt/qqbot/backup/${cutover}/failed-${file}"
  fi
done
sudo install -m 600 \
  "/opt/qqbot/backup/${cutover}/pre-activation-koishi.db" \
  /opt/qqbot/data/koishi.db

sudo tar -xzf \
  "/opt/qqbot/backup/${cutover}/systemd-units.tar.gz" \
  -C /
sudo systemctl daemon-reload
sudo systemctl start qqbot.target
```

Do not recursively remove `/opt/qqbot/data`, `/opt/qqbot/backup`,
`/opt/qqbot/shared`, or another broad directory.

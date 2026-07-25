#!/usr/bin/env python3
"""SQLite boundary for the offline Preset V2 cutover tool.

Preset semantics stay in ChatLuna. This helper only provides transactional,
parameterized SQLite reads/writes so the Node migration entrypoint does not
need another database driver.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import sqlite3
import sys
import time
from typing import Any

os.umask(0o077)


REQUIRED_COLUMNS = {
    "chatluna_conversation": {
        "id",
        "seq",
        "bindingKey",
        "preset",
        "createdAt",
        "updatedAt",
    },
    "chatluna_binding": {
        "bindingKey",
        "activeConversationId",
        "lastConversationId",
        "updatedAt",
    },
    "chatluna_constraint": {
        "activePresetLane",
        "defaultPreset",
        "fixedPreset",
    },
    "chatluna_meta": {"key", "value", "updatedAt"},
}

MUTABLE_COLUMNS = {
    "chatluna_conversation": {"bindingKey", "preset", "seq"},
    "chatluna_constraint": {
        "activePresetLane",
        "defaultPreset",
        "fixedPreset",
    },
    "chathub_room": {"preset"},
}


def read_payload() -> dict[str, Any]:
    raw = sys.stdin.read()
    return json.loads(raw) if raw else {}


def emit(value: Any) -> None:
    json.dump(value, sys.stdout, ensure_ascii=False, separators=(",", ":"))
    sys.stdout.write("\n")


def connect_readonly(database_path: str) -> sqlite3.Connection:
    uri = Path(database_path).resolve().as_uri() + "?mode=ro"
    connection = sqlite3.connect(uri, uri=True)
    connection.row_factory = sqlite3.Row
    return connection


def connect(database_path: str) -> sqlite3.Connection:
    connection = sqlite3.connect(str(Path(database_path).resolve()))
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA busy_timeout = 5000")
    return connection


def table_exists(connection: sqlite3.Connection, table: str) -> bool:
    row = connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        (table,),
    ).fetchone()
    return row is not None


def columns(connection: sqlite3.Connection, table: str) -> set[str]:
    return {
        str(row["name"])
        for row in connection.execute(f'PRAGMA table_info("{table}")')
    }


def rows(connection: sqlite3.Connection, sql: str) -> list[dict[str, Any]]:
    return [dict(row) for row in connection.execute(sql)]


def require_columns(
    connection: sqlite3.Connection,
    table: str,
    expected: set[str],
) -> None:
    if not table_exists(connection, table):
        raise RuntimeError(f"required SQLite table is missing: {table}")
    missing = expected - columns(connection, table)
    if missing:
        joined = ", ".join(sorted(missing))
        raise RuntimeError(f"required SQLite columns are missing from {table}: {joined}")


def inspect_connection(connection: sqlite3.Connection) -> dict[str, Any]:
    for table, expected in REQUIRED_COLUMNS.items():
        require_columns(connection, table, expected)

    result: dict[str, Any] = {
        "conversations": rows(
            connection,
            'SELECT rowid AS "_rowid", "id", "seq", "bindingKey", "preset", '
            '"createdAt", "updatedAt" '
            'FROM "chatluna_conversation" ORDER BY rowid',
        ),
        "bindings": rows(
            connection,
            'SELECT rowid AS "_rowid", "bindingKey", "activeConversationId", '
            '"lastConversationId", "updatedAt" FROM "chatluna_binding" '
            "ORDER BY rowid",
        ),
        "constraints": rows(
            connection,
            'SELECT rowid AS "_rowid", "activePresetLane", '
            '"defaultPreset", "fixedPreset" FROM "chatluna_constraint" '
            "ORDER BY rowid",
        ),
        "rooms": [],
        "archives": [],
        "globalDefaultValue": None,
    }

    if table_exists(connection, "chathub_room"):
        require_columns(connection, "chathub_room", {"roomId", "preset"})
        result["rooms"] = rows(
            connection,
            'SELECT rowid AS "_rowid", "roomId", "preset" '
            'FROM "chathub_room" ORDER BY rowid',
        )

    if table_exists(connection, "chatluna_archive"):
        require_columns(connection, "chatluna_archive", {"id", "path", "state"})
        result["archives"] = rows(
            connection,
            'SELECT "id", "path", "state" FROM "chatluna_archive" ORDER BY "id"',
        )

    default_row = connection.execute(
        'SELECT "value" FROM "chatluna_meta" '
        'WHERE "key" = ? LIMIT 1',
        ("globalDefaultPresetId",),
    ).fetchone()
    if default_row is not None:
        result["globalDefaultValue"] = default_row["value"]

    return result


def inspect_database(database_path: str) -> dict[str, Any]:
    with connect_readonly(database_path) as connection:
        return inspect_connection(connection)


def backup_database(source_path: str, destination_path: str) -> None:
    destination = Path(destination_path).resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    with connect(source_path) as source, sqlite3.connect(destination) as target:
        source.backup(target)
    destination.chmod(0o600)


def restore_database(backup_path: str, destination_path: str) -> None:
    with sqlite3.connect(str(Path(backup_path).resolve())) as source:
        with connect(destination_path) as target:
            source.backup(target)
    Path(destination_path).resolve().chmod(0o600)


def apply_changes(database_path: str, payload: dict[str, Any]) -> int:
    changes = payload.get("changes")
    binding_plans = payload.get("bindingPlans")
    archive_path_changes = payload.get("archivePathChanges")
    global_default_id = payload.get("globalDefaultPresetId")
    expected_state = payload.get("expectedState")
    if not isinstance(changes, list):
        raise RuntimeError("changes must be an array")
    if not isinstance(binding_plans, list):
        raise RuntimeError("bindingPlans must be an array")
    if not isinstance(archive_path_changes, list):
        raise RuntimeError("archivePathChanges must be an array")
    if not isinstance(global_default_id, str) or not global_default_id:
        raise RuntimeError("globalDefaultPresetId must be a non-empty string")
    if not isinstance(expected_state, dict):
        raise RuntimeError("expectedState must be the complete preflight database state")

    connection = connect(database_path)
    try:
        connection.execute("BEGIN IMMEDIATE")
        if inspect_connection(connection) != expected_state:
            raise RuntimeError(
                "database preset state changed after preflight; rerun the cutover"
            )
        for change in changes:
            if not isinstance(change, dict):
                raise RuntimeError("database change must be an object")
            table = change.get("table")
            column = change.get("column")
            rowid = change.get("rowid")
            before = change.get("from")
            after = change.get("to")
            if table not in MUTABLE_COLUMNS or column not in MUTABLE_COLUMNS[table]:
                raise RuntimeError(f"unsupported database change: {table}.{column}")
            if not isinstance(rowid, int):
                raise RuntimeError(f"invalid rowid for {table}.{column}")
            if column == "seq":
                if not isinstance(after, int) or isinstance(after, bool) or after < 1:
                    raise RuntimeError(
                        f"invalid target sequence for {table}.{column}"
                    )
            elif not isinstance(after, str) or not after:
                raise RuntimeError(f"invalid target value for {table}.{column}")

            cursor = connection.execute(
                f'UPDATE "{table}" SET "{column}" = ? '
                f'WHERE rowid = ? AND "{column}" IS ?',
                (after, rowid, before),
            )
            if cursor.rowcount != 1:
                raise RuntimeError(
                    f"stale database row during preset migration: "
                    f"{table}.{column} rowid={rowid}"
                )

        binding_targets: set[str] = set()
        binding_source_rowids: set[int] = set()
        for plan in binding_plans:
            if not isinstance(plan, dict):
                raise RuntimeError("binding plan must be an object")
            target = plan.get("targetBindingKey")
            source_rows = plan.get("sourceRows")
            keeper_rowid = plan.get("keeperRowid")
            active_id = plan.get("activeConversationId")
            last_id = plan.get("lastConversationId")
            updated_at = plan.get("updatedAt")
            if not isinstance(target, str) or not target:
                raise RuntimeError("binding plan targetBindingKey must be non-empty")
            if target in binding_targets:
                raise RuntimeError(f"duplicate binding plan target: {target}")
            binding_targets.add(target)
            if not isinstance(source_rows, list) or not source_rows:
                raise RuntimeError(
                    f"binding plan sourceRows must be non-empty: {target}"
                )
            if not isinstance(keeper_rowid, int):
                raise RuntimeError(f"binding plan keeperRowid is invalid: {target}")
            if active_id is not None and (
                not isinstance(active_id, str) or not active_id
            ):
                raise RuntimeError(
                    f"binding plan activeConversationId is invalid: {target}"
                )
            if last_id is not None and (
                not isinstance(last_id, str) or not last_id
            ):
                raise RuntimeError(
                    f"binding plan lastConversationId is invalid: {target}"
                )
            if active_id is not None and active_id == last_id:
                raise RuntimeError(
                    f"binding plan active and last conversation must differ: {target}"
                )
            if updated_at is None:
                raise RuntimeError(f"binding plan updatedAt is required: {target}")

            source_by_rowid: dict[int, dict[str, Any]] = {}
            for source in source_rows:
                if not isinstance(source, dict):
                    raise RuntimeError(
                        f"binding plan source row must be an object: {target}"
                    )
                rowid = source.get("rowid")
                binding_key = source.get("bindingKey")
                if not isinstance(rowid, int):
                    raise RuntimeError(
                        f"binding plan source rowid is invalid: {target}"
                    )
                if rowid in source_by_rowid or rowid in binding_source_rowids:
                    raise RuntimeError(
                        f"duplicate binding plan source rowid: {rowid}"
                    )
                if not isinstance(binding_key, str) or not binding_key:
                    raise RuntimeError(
                        f"binding plan source bindingKey is invalid: {target}"
                    )
                source_by_rowid[rowid] = source
                binding_source_rowids.add(rowid)

            keeper = source_by_rowid.get(keeper_rowid)
            if keeper is None:
                raise RuntimeError(
                    f"binding plan keeper is not a source row: {target}"
                )

            for source in source_rows:
                if source["rowid"] == keeper_rowid:
                    continue
                cursor = connection.execute(
                    'DELETE FROM "chatluna_binding" '
                    'WHERE rowid = ? AND "bindingKey" IS ? '
                    'AND "activeConversationId" IS ? '
                    'AND "lastConversationId" IS ? AND "updatedAt" IS ?',
                    (
                        source["rowid"],
                        source["bindingKey"],
                        source.get("activeConversationId"),
                        source.get("lastConversationId"),
                        source.get("updatedAt"),
                    ),
                )
                if cursor.rowcount != 1:
                    raise RuntimeError(
                        "stale binding row during preset migration: "
                        f"rowid={source['rowid']}"
                    )

            cursor = connection.execute(
                'UPDATE "chatluna_binding" SET "bindingKey" = ?, '
                '"activeConversationId" = ?, "lastConversationId" = ?, '
                '"updatedAt" = ? WHERE rowid = ? AND "bindingKey" IS ? '
                'AND "activeConversationId" IS ? '
                'AND "lastConversationId" IS ? AND "updatedAt" IS ?',
                (
                    target,
                    active_id,
                    last_id,
                    updated_at,
                    keeper_rowid,
                    keeper["bindingKey"],
                    keeper.get("activeConversationId"),
                    keeper.get("lastConversationId"),
                    keeper.get("updatedAt"),
                ),
            )
            if cursor.rowcount != 1:
                raise RuntimeError(
                    "stale binding keeper during preset migration: "
                    f"rowid={keeper_rowid}"
                )

        if archive_path_changes:
            require_columns(
                connection,
                "chatluna_archive",
                {"id", "path", "state"},
            )
        archive_ids: set[str] = set()
        for change in archive_path_changes:
            if not isinstance(change, dict):
                raise RuntimeError("archive path change must be an object")
            archive_id = change.get("id")
            before = change.get("from")
            after = change.get("to")
            state = change.get("state")
            if not isinstance(archive_id, str) or not archive_id:
                raise RuntimeError("archive path change id must be a non-empty string")
            if archive_id in archive_ids:
                raise RuntimeError(f"duplicate archive path change: {archive_id}")
            archive_ids.add(archive_id)
            if not isinstance(before, str) or not Path(before).is_absolute():
                raise RuntimeError(
                    f"archive path change source must be absolute: {archive_id}"
                )
            if not isinstance(after, str) or not Path(after).is_absolute():
                raise RuntimeError(
                    f"archive path change target must be absolute: {archive_id}"
                )
            if before == after:
                raise RuntimeError(
                    f"archive path change must relocate the archive: {archive_id}"
                )
            if state != "ready":
                raise RuntimeError(
                    f"archive path change requires ready state: {archive_id}"
                )

            cursor = connection.execute(
                'UPDATE "chatluna_archive" SET "path" = ? '
                'WHERE "id" = ? AND "path" = ? AND "state" = ?',
                (after, archive_id, before, state),
            )
            if cursor.rowcount != 1:
                raise RuntimeError(
                    f"stale archive path during preset migration: {archive_id}"
                )

        connection.execute(
            'INSERT INTO "chatluna_meta" ("key", "value", "updatedAt") '
            "VALUES (?, ?, ?) "
            'ON CONFLICT("key") DO UPDATE SET '
            '"value" = excluded."value", "updatedAt" = excluded."updatedAt"',
            (
                "globalDefaultPresetId",
                json.dumps(global_default_id, ensure_ascii=False),
                int(time.time() * 1000),
            ),
        )
        connection.commit()
        binding_change_count = sum(
            len(plan["sourceRows"]) for plan in binding_plans
        )
        return (
            len(changes)
            + binding_change_count
            + len(archive_path_changes)
        )
    except BaseException:
        connection.rollback()
        raise
    finally:
        connection.close()


def main() -> None:
    if len(sys.argv) < 3:
        raise RuntimeError(
            "usage: preset-v2-sqlite.py "
            "inspect|backup|restore|apply <database> [destination]"
        )

    operation = sys.argv[1]
    database_path = sys.argv[2]
    if operation == "inspect":
        emit(inspect_database(database_path))
        return
    if operation == "backup":
        if len(sys.argv) != 4:
            raise RuntimeError("backup requires a destination path")
        backup_database(database_path, sys.argv[3])
        emit({"ok": True})
        return
    if operation == "restore":
        if len(sys.argv) != 4:
            raise RuntimeError("restore requires a destination path")
        restore_database(database_path, sys.argv[3])
        emit({"ok": True})
        return
    if operation == "apply":
        changed = apply_changes(database_path, read_payload())
        emit({"ok": True, "changed": changed})
        return
    raise RuntimeError(f"unknown operation: {operation}")


if __name__ == "__main__":
    try:
        main()
    except BaseException as error:
        emit({"error": str(error)})
        raise

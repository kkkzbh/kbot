#!/usr/bin/env python3
"""Read and back up the SQLite preset-reference boundary for context cutover."""

from __future__ import annotations

import json
import os
from pathlib import Path
import sqlite3
import sys
from typing import Any

os.umask(0o077)

REQUIRED_COLUMNS = {
    "chatluna_conversation": {"id", "bindingKey", "preset"},
    "chatluna_binding": {"bindingKey"},
    "chatluna_constraint": {
        "activePresetLane",
        "defaultPreset",
        "fixedPreset",
    },
    "chatluna_meta": {"key", "value"},
}


def emit(value: Any) -> None:
    json.dump(value, sys.stdout, ensure_ascii=False, separators=(",", ":"))
    sys.stdout.write("\n")


def connect_readonly(database_path: str) -> sqlite3.Connection:
    uri = Path(database_path).resolve().as_uri() + "?mode=ro"
    connection = sqlite3.connect(uri, uri=True)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA busy_timeout = 5000")
    return connection


def table_exists(connection: sqlite3.Connection, table: str) -> bool:
    return connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        (table,),
    ).fetchone() is not None


def columns(connection: sqlite3.Connection, table: str) -> set[str]:
    return {
        str(row["name"])
        for row in connection.execute(f'PRAGMA table_info("{table}")')
    }


def require_columns(
    connection: sqlite3.Connection,
    table: str,
    expected: set[str],
) -> None:
    if not table_exists(connection, table):
        raise RuntimeError(f"required SQLite table is missing: {table}")
    missing = expected - columns(connection, table)
    if missing:
        raise RuntimeError(
            f"required SQLite columns are missing from {table}: "
            + ", ".join(sorted(missing))
        )


def rows(connection: sqlite3.Connection, sql: str) -> list[dict[str, Any]]:
    return [dict(row) for row in connection.execute(sql)]


def inspect_database(database_path: str) -> dict[str, Any]:
    with connect_readonly(database_path) as connection:
        for table, expected in REQUIRED_COLUMNS.items():
            require_columns(connection, table, expected)
        result: dict[str, Any] = {
            "conversations": rows(
                connection,
                'SELECT "id", "bindingKey", "preset" '
                'FROM "chatluna_conversation" ORDER BY rowid',
            ),
            "bindings": rows(
                connection,
                'SELECT "bindingKey" FROM "chatluna_binding" ORDER BY rowid',
            ),
            "constraints": rows(
                connection,
                'SELECT "activePresetLane", "defaultPreset", "fixedPreset" '
                'FROM "chatluna_constraint" ORDER BY rowid',
            ),
            "rooms": [],
            "globalDefaultValue": None,
        }
        if table_exists(connection, "chathub_room"):
            require_columns(connection, "chathub_room", {"roomId", "preset"})
            result["rooms"] = rows(
                connection,
                'SELECT "roomId", "preset" FROM "chathub_room" ORDER BY rowid',
            )
        default = connection.execute(
            'SELECT "value" FROM "chatluna_meta" '
            'WHERE "key" = ? LIMIT 1',
            ("globalDefaultPresetId",),
        ).fetchone()
        if default is not None:
            result["globalDefaultValue"] = default["value"]
        return result


def backup_database(source_path: str, destination_path: str) -> None:
    destination = Path(destination_path).resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        raise RuntimeError(f"backup destination already exists: {destination}")
    with connect_readonly(source_path) as source:
        with sqlite3.connect(destination) as target:
            source.backup(target)
            integrity = target.execute("PRAGMA integrity_check").fetchone()
            if integrity is None or integrity[0] != "ok":
                raise RuntimeError("SQLite backup integrity_check failed")
    destination.chmod(0o600)


def main() -> None:
    if len(sys.argv) < 3:
        raise RuntimeError(
            "usage: context-preset-sqlite.py inspect|backup "
            "<database> [destination]"
        )
    operation = sys.argv[1]
    database_path = sys.argv[2]
    if operation == "inspect":
        if len(sys.argv) != 3:
            raise RuntimeError("inspect accepts exactly one database path")
        emit(inspect_database(database_path))
        return
    if operation == "backup":
        if len(sys.argv) != 4:
            raise RuntimeError("backup requires a destination path")
        backup_database(database_path, sys.argv[3])
        emit({"ok": True})
        return
    raise RuntimeError(f"unknown operation: {operation}")


if __name__ == "__main__":
    try:
        main()
    except BaseException as error:
        emit({"error": str(error)})
        raise

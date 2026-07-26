#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB_PATH="${QQBOT_KOISHI_DB_PATH:-$ROOT_DIR/data/koishi.db}"
BOT_ENV_FILE="${QQBOT_ENV_FILE:-$ROOT_DIR/.env.local}"
BOT_ENV_BASE_FILE="${QQBOT_ENV_BASE_FILE:-}"
BOT_ENV_OVERRIDE_FILE="${QQBOT_ENV_OVERRIDE_FILE:-}"
EXPLICIT_MODEL_CONFIG_PATH="${QQBOT_MODEL_CONFIG_PATH:-}"
FAKE_USER_ID="${FAKE_USER_ID:-}"
CHAT_MODE="${1:-${CHAT_MODE:-}}"
ROOM_PREFIX="${ROOM_PREFIX:-codex-debug}"
LOCAL_RUNTIME_ENV_FILE="${ROOT_DIR}/.runtime/.env.runtime"

usage() {
  cat <<'EOF'
Usage:
  FAKE_USER_ID=9123456789 prepare-debug-chat-state.sh tool_research_then_reply

Description:
  Ensure the probe private debug room exists for the fake user, pin its chatMode,
  and disable autoUpdate so local smoke can deterministically hit the target route.

Environment:
  QQBOT_KOISHI_DB_PATH  Override sqlite db path (default: data/koishi.db)
  QQBOT_MODEL_CONFIG_PATH
                        Explicit canonical model-config path. When unset, resolve
                        it from the layered bot env files.
  QQBOT_ENV_FILE        Bot env file used to resolve QQBOT_MODEL_CONFIG_PATH
  FAKE_USER_ID          Required fake private-chat user id
  CHAT_MODE             Optional fallback for the positional chat mode
  ROOM_PREFIX           Debug room name prefix (default: codex-debug)
EOF
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[error] Missing command: $1" >&2
    exit 2
  fi
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

require_cmd python3

if [[ ! -f "$DB_PATH" ]]; then
  echo "[error] Missing database: $DB_PATH" >&2
  exit 1
fi

if [[ "$BOT_ENV_FILE" != /* ]]; then
  BOT_ENV_FILE="$ROOT_DIR/$BOT_ENV_FILE"
fi

resolve_optional_env_file() {
  local explicit="$1"
  if [[ -z "$explicit" ]]; then
    return 1
  fi
  if [[ "$explicit" != /* ]]; then
    explicit="${ROOT_DIR}/${explicit}"
  fi
  printf '%s\n' "$explicit"
}

BASE_ENV_FILE="$(resolve_optional_env_file "$BOT_ENV_BASE_FILE" || true)"
OVERRIDE_ENV_FILE="$(resolve_optional_env_file "$BOT_ENV_OVERRIDE_FILE" || true)"

if [[ -n "$BASE_ENV_FILE" || -n "$OVERRIDE_ENV_FILE" ]]; then
  if [[ -z "$BASE_ENV_FILE" ]]; then
    echo "[error] QQBOT_ENV_BASE_FILE is required when runtime env layering is enabled" >&2
    exit 2
  fi
else
  BASE_ENV_FILE="$BOT_ENV_FILE"
  if [[ "$BASE_ENV_FILE" == "$ROOT_DIR/.env.local" ]]; then
    OVERRIDE_ENV_FILE="$LOCAL_RUNTIME_ENV_FILE"
  fi
fi

if [[ ! -f "$BASE_ENV_FILE" && -z "$EXPLICIT_MODEL_CONFIG_PATH" ]]; then
  echo "[error] Missing bot env file: $BASE_ENV_FILE" >&2
  exit 1
fi

if [[ -z "$FAKE_USER_ID" ]] || ! [[ "$FAKE_USER_ID" =~ ^[0-9]+$ ]]; then
  echo "[error] FAKE_USER_ID must be a numeric user id." >&2
  exit 2
fi

if [[ -z "$CHAT_MODE" ]]; then
  echo "[error] Missing chat mode." >&2
  exit 2
fi

export ROOT_DIR DB_PATH BASE_ENV_FILE OVERRIDE_ENV_FILE EXPLICIT_MODEL_CONFIG_PATH
export FAKE_USER_ID CHAT_MODE ROOM_PREFIX

python3 <<'PY'
import os
import json
import re
import sqlite3
import time
from pathlib import Path

root_dir = Path(os.environ['ROOT_DIR'])
db_path = os.environ['DB_PATH']
base_env_file = os.environ['BASE_ENV_FILE']
override_env_file = os.environ.get('OVERRIDE_ENV_FILE', '').strip()
explicit_model_config_path = os.environ.get('EXPLICIT_MODEL_CONFIG_PATH', '').strip()
fake_user_id = os.environ['FAKE_USER_ID']
chat_mode = os.environ['CHAT_MODE'].strip()
room_prefix = os.environ['ROOM_PREFIX']
now = int(time.time() * 1000)

def parse_env_file(path: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw_line in Path(path).read_text(encoding='utf-8').splitlines():
        line = raw_line.strip()
        if not line or line.startswith('#'):
            continue
        if line.startswith('export '):
            line = line[7:].lstrip()
        if '=' not in line:
            continue
        key, value = line.split('=', 1)
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and (
            (value.startswith("'") and value.endswith("'")) or
            (value.startswith('"') and value.endswith('"'))
        ):
            value = value[1:-1]
        values[key] = value
    return values

def require_list(document: dict[str, object], key: str) -> list[object]:
    value = document.get(key)
    if not isinstance(value, list):
        raise RuntimeError(f'canonical model-config field {key} must be an array')
    return value

def resolve_main_chat_model(model_config_path: Path) -> str:
    try:
        document = json.loads(model_config_path.read_text(encoding='utf-8'))
    except FileNotFoundError as error:
        raise RuntimeError(f'canonical model-config does not exist: {model_config_path}') from error
    except json.JSONDecodeError as error:
        raise RuntimeError(
            f'canonical model-config is invalid JSON at {model_config_path}: {error.msg}'
        ) from error

    if not isinstance(document, dict):
        raise RuntimeError(f'canonical model-config root must be an object: {model_config_path}')

    main_bindings = [
        binding
        for binding in require_list(document, 'bindings')
        if isinstance(binding, dict) and binding.get('workload') == 'main.chat'
    ]
    if len(main_bindings) != 1:
        raise RuntimeError(
            f'canonical model-config must contain exactly one main.chat binding: {model_config_path}'
        )
    binding = main_bindings[0]
    if binding.get('mode') != 'dedicated':
        raise RuntimeError('canonical model-config main.chat binding must use dedicated mode')

    connection_id = binding.get('connectionId')
    model_id = binding.get('modelId')
    if not isinstance(connection_id, str) or not re.fullmatch(
        r'[a-z0-9](?:[a-z0-9-]*[a-z0-9])?', connection_id
    ):
        raise RuntimeError('canonical model-config main.chat connectionId is invalid')
    if not isinstance(model_id, str) or not re.fullmatch(
        r'[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?', model_id
    ):
        raise RuntimeError('canonical model-config main.chat modelId is invalid')

    connections = require_list(document, 'connections')
    if not any(
        isinstance(connection, dict) and connection.get('id') == connection_id
        for connection in connections
    ):
        raise RuntimeError(
            f'canonical model-config main.chat references missing connection: {connection_id}'
        )

    models = require_list(document, 'models')
    if not any(
        isinstance(model, dict)
        and model.get('connectionId') == connection_id
        and model.get('id') == model_id
        for model in models
    ):
        raise RuntimeError(
            f'canonical model-config main.chat references missing model: {connection_id}/{model_id}'
        )

    return f'qqbot-{connection_id}/{model_id}'

env_values = parse_env_file(base_env_file) if Path(base_env_file).exists() else {}
if override_env_file and Path(override_env_file).exists():
    env_values.update(parse_env_file(override_env_file))
configured_model_config_path = (
    explicit_model_config_path
    or env_values.get('QQBOT_MODEL_CONFIG_PATH', '').strip()
)
if not configured_model_config_path:
    raise RuntimeError(
        'QQBOT_MODEL_CONFIG_PATH is missing from the explicit environment and layered bot env'
    )
model_config_path = Path(configured_model_config_path)
if not model_config_path.is_absolute():
    model_config_path = root_dir / model_config_path
model_from_config = resolve_main_chat_model(model_config_path.resolve())

conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row

try:
    global_default = conn.execute(
        "select value from chatluna_meta where key = 'globalDefaultPresetId'"
    ).fetchone()
    if global_default is None:
        raise RuntimeError('chatluna_meta.globalDefaultPresetId is missing')
    preset = json.loads(str(global_default['value']))
    if not isinstance(preset, str) or not preset.strip():
        raise RuntimeError('chatluna_meta.globalDefaultPresetId is invalid')
    preset = preset.strip()

    rooms = conn.execute(
        """
        select roomId, conversationId
        from chathub_room
        where roomMasterId = ?
        order by updatedTime desc, roomId desc
        """,
        (fake_user_id,),
    ).fetchall()

    template = conn.execute(
        """
        select password
        from chathub_room
        where model is not null
          and trim(model) != ''
        order by case when roomMasterId = '0' then 0 else 1 end, updatedTime desc, roomId desc
        limit 1
        """
    ).fetchone()

    model = model_from_config
    password = str(template['password']) if template and template['password'] else ''

    updated_room_ids = []

    def ensure_conversation(conversation_id: str, title: str) -> None:
        conn.execute(
            """
            insert into chatluna_conversation (
              id, title, model, preset, chatMode, createdBy,
              createdAt, updatedAt, lastChatAt, status, latestMessageId, autoTitle
            ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', null, 0)
            on conflict(id) do update set
              title = excluded.title,
              model = excluded.model,
              preset = excluded.preset,
              chatMode = excluded.chatMode,
              updatedAt = excluded.updatedAt,
              status = excluded.status,
              autoTitle = excluded.autoTitle
            """,
            (conversation_id, title, model, preset, chat_mode, fake_user_id, now, now, now),
        )

    with conn:
        if rooms:
            for row in rooms:
                room_id = int(row['roomId'])
                conversation_id = str(row['conversationId']) if row['conversationId'] else f'codex-debug:{fake_user_id}:{room_id}'
                conn.execute(
                    """
                    update chathub_room
                    set conversationId = ?, preset = ?, model = ?, chatMode = ?, autoUpdate = 0, updatedTime = ?
                    where roomId = ?
                    """,
                    (conversation_id, preset, model, chat_mode, now, room_id),
                )
                ensure_conversation(conversation_id, f'{room_prefix}-{fake_user_id}:{room_id}')
                conn.execute(
                    """
                    insert or ignore into chathub_room_member (userId, roomId, roomPermission, mute)
                    values (?, ?, 'owner', 0)
                    """,
                    (fake_user_id, room_id),
                )
                updated_room_ids.append(room_id)
        else:
            next_room_id = conn.execute(
                "select coalesce(max(roomId), 0) + 1 from chathub_room"
            ).fetchone()[0]
            conversation_id = f'codex-debug:{fake_user_id}'
            ensure_conversation(conversation_id, f'{room_prefix}-{fake_user_id}')
            conn.execute(
                """
                insert into chathub_room (
                  roomId, roomName, conversationId, roomMasterId, visibility,
                  preset, model, chatMode, password, autoUpdate, updatedTime
                ) values (?, ?, ?, ?, 'private', ?, ?, ?, ?, 0, ?)
                """,
                (
                    next_room_id,
                    f'{room_prefix}-{fake_user_id}',
                    conversation_id,
                    fake_user_id,
                    preset,
                    model,
                    chat_mode,
                    password,
                    now,
                ),
            )
            conn.execute(
                """
                insert into chathub_room_member (userId, roomId, roomPermission, mute)
                values (?, ?, 'owner', 0)
                """,
                (fake_user_id, next_room_id),
            )
            updated_room_ids.append(int(next_room_id))

        default_room_id = updated_room_ids[0]
        conn.execute(
            "delete from chathub_user where userId = ? and groupId is null",
            (fake_user_id,),
        )
        conn.execute(
            """
            insert into chathub_user (userId, defaultRoomId, groupId)
            values (?, ?, null)
            """,
            (fake_user_id, default_room_id),
        )

    print(
        f'rooms={len(updated_room_ids)} defaultRoomId={updated_room_ids[0]} '
        f'chatMode={chat_mode} preset={preset} model={model}'
    )
finally:
    conn.close()
PY

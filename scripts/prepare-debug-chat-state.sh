#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB_PATH="${QQBOT_KOISHI_DB_PATH:-$ROOT_DIR/data/koishi.db}"
BOT_ENV_FILE="${QQBOT_ENV_FILE:-$ROOT_DIR/.env.local}"
BOT_ENV_BASE_FILE="${QQBOT_ENV_BASE_FILE:-}"
BOT_ENV_OVERRIDE_FILE="${QQBOT_ENV_OVERRIDE_FILE:-}"
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
  QQBOT_ENV_FILE        Bot env file used to resolve the active built-in tab and runtime model
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

if [[ ! -f "$BASE_ENV_FILE" ]]; then
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

export DB_PATH BASE_ENV_FILE OVERRIDE_ENV_FILE FAKE_USER_ID CHAT_MODE ROOM_PREFIX

python3 <<'PY'
import os
import json
import sqlite3
import time
from pathlib import Path

db_path = os.environ['DB_PATH']
base_env_file = os.environ['BASE_ENV_FILE']
override_env_file = os.environ.get('OVERRIDE_ENV_FILE', '').strip()
fake_user_id = os.environ['FAKE_USER_ID']
chat_mode = os.environ['CHAT_MODE'].strip()
room_prefix = os.environ['ROOM_PREFIX']
now = int(time.time() * 1000)

def parse_env_file(path: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw_line in Path(path).read_text(encoding='utf-8').splitlines():
        line = raw_line.strip()
        if not line or line.startswith('#') or '=' not in line:
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

def resolve_runtime_model(env_values: dict[str, str]) -> str:
    active_tab = env_values.get('CHATLUNA_ACTIVE_TAB', '').strip()
    tab_model_key = {
        'openai': 'CHATLUNA_OPENAI_DEFAULT_MODEL',
        'siliconflow': 'CHATLUNA_SILICONFLOW_DEFAULT_MODEL',
        'copilot': 'CHATLUNA_COPILOT_DEFAULT_MODEL',
    }.get(active_tab)
    if tab_model_key is not None:
        model = (
            env_values.get(tab_model_key, '').strip() or
            env_values.get('CHATLUNA_DEFAULT_MODEL', '').strip()
        )
    else:
        model = env_values.get('CHATLUNA_DEFAULT_MODEL', '').strip()

    if not model:
        raise RuntimeError(f'no runtime main-chat model found in env file: {base_env_file}')
    return normalize_canonical_model(active_tab, model)

def normalize_canonical_model(active_tab: str, model: str) -> str:
    value = model.strip()
    if not value:
        return value
    if active_tab in ('openai', 'copilot'):
        if value.startswith('github-copilot/'):
            value = value.split('/', 1)[1].strip()
        if value.startswith('openai/'):
            return value
        if '/' not in value:
            return f'openai/{value}'
    return value

env_values = parse_env_file(base_env_file)
if override_env_file and Path(override_env_file).exists():
    env_values.update(parse_env_file(override_env_file))
model_from_env = resolve_runtime_model(env_values)

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

    model = model_from_env
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

#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

resolve_db_path() {
  if [[ -n "${QQBOT_KOISHI_DB_PATH:-}" ]]; then
    printf '%s\n' "${QQBOT_KOISHI_DB_PATH}"
    return
  fi

  printf '%s\n' "${ROOT_DIR}/data/koishi.db"
}

usage() {
  cat <<'EOF'
Usage:
  cleanup-probe-chat-state.sh <fake_user_id> <group_id>

Description:
  Remove temporary probe chat state for a non-default probe group, including the
  cloned room, conversation messages, room membership, chathub_user mapping, and
  isolated memory user/context identities.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

fake_user_id="${1:-}"
group_id="${2:-}"
if [[ -z "$fake_user_id" || -z "$group_id" ]]; then
  echo "[error] Missing fake_user_id or group_id." >&2
  usage >&2
  exit 2
fi

if ! [[ "$fake_user_id" =~ ^[0-9]+$ ]] || ! [[ "$group_id" =~ ^[0-9]+$ ]]; then
  echo "[error] fake_user_id and group_id must be numeric." >&2
  exit 2
fi

db_path="$(resolve_db_path)"
if [[ ! -f "$db_path" ]]; then
  echo "[error] koishi db not found: $db_path" >&2
  exit 2
fi

room_id="$(
  sqlite3 "$db_path" "select defaultRoomId from chathub_user where userId='${fake_user_id}' and groupId='${group_id}' limit 1;" \
    | tr -d '\n'
)"

chat_cleanup_sql=""
conversation_cleanup_sql=""
if [[ -n "$room_id" ]]; then
  conversation_id="$(
    sqlite3 "$db_path" "select conversationId from chathub_room where roomId=${room_id} and roomMasterId='${fake_user_id}' limit 1;" \
      | tr -d '\n'
  )"
  if [[ -n "$conversation_id" ]]; then
    conversation_cleanup_sql=$'delete from chatluna_message where conversationId='"'${conversation_id}'"$';\n'"delete from chatluna_conversation where id='${conversation_id}';"
  fi
  chat_cleanup_sql=$'delete from chathub_room_member where roomId='"${room_id}"$';\n'"delete from chathub_user where userId='${fake_user_id}' and groupId='${group_id}';"$'\n'"delete from chathub_room where roomId=${room_id} and roomMasterId='${fake_user_id}';"$'\n'"${conversation_cleanup_sql}"
fi

memory_schema="$(
  sqlite3 "$db_path" "
    select group_concat(name, ',')
    from (
      select name
      from sqlite_schema
      where type = 'table'
        and name in (
          'memory_v3_principal',
          'memory_v3_context'
        )
      order by name
    );
  " | tr -d '\n'
)"

memory_cleanup_sql=""
case "$memory_schema" in
  "")
    ;;
  "memory_v3_context,memory_v3_principal")
    memory_cleanup_sql=$'delete from memory_v3_principal where userKey='"'onebot:user:${fake_user_id}'"$' and platform='"'onebot'"' and userId='"'${fake_user_id}'"$';\n'"delete from memory_v3_context where platform='onebot' and channelType='group' and groupId='${group_id}';"
    ;;
  *)
    echo "[error] unsupported probe memory schema: ${memory_schema}" >&2
    exit 2
    ;;
esac

sqlite3 "$db_path" <<SQL
begin immediate;
${chat_cleanup_sql}
${memory_cleanup_sql}
commit;
SQL

echo "[info] cleaned probe state: user=${fake_user_id} group=${group_id} room=${room_id:-none}" >&2

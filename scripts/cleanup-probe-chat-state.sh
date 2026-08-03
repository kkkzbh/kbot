#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
LIVE_ACCEPTANCE_GROUP_ID="$(node -e "const s=require('./scripts/lib/probe-local-bot-shared.cjs');process.stdout.write(s.LIVE_ACCEPTANCE_GROUP_ID)" 2>/dev/null)"
TEMP_GROUP_PREFIX="$(node -e "const s=require('./scripts/lib/probe-local-bot-shared.cjs');process.stdout.write(s.TEMP_PROBE_GROUP_PREFIX)" 2>/dev/null)"
TEMP_USER_PREFIX="$(node -e "const s=require('./scripts/lib/probe-local-bot-shared.cjs');process.stdout.write(s.TEMP_PROBE_USER_PREFIX)" 2>/dev/null)"

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
  cleanup-probe-chat-state.sh <ownership-journal.json>

Description:
  Recover and remove one explicitly owned temporary group probe. The journal,
  controlled temporary IDs, conversation marker, and active binding must agree
  before any persisted chat or memory state is changed.
EOF
}

sql_quote() {
  local value="$1"
  value="${value//\'/\'\'}"
  printf "'%s'" "$value"
}

table_exists() {
  local table="$1"
  [[ "$(sqlite3 "$db_path" "select count(*) from sqlite_schema where type='table' and name=$(sql_quote "$table");")" == "1" ]]
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

journal_path="${1:-}"
if [[ -z "$journal_path" || $# -ne 1 ]]; then
  echo "[error] Exactly one ownership journal is required." >&2
  usage >&2
  exit 2
fi
if [[ ! -f "$journal_path" ]]; then
  echo "[error] Probe ownership journal not found: $journal_path" >&2
  exit 2
fi

ownership_dir="${QQBOT_PROBE_OWNERSHIP_DIR:-${ROOT_DIR}/.tmp/probe-ownership}"
canonical_ownership_dir="$(realpath -m "$ownership_dir")"
canonical_journal="$(realpath -m "$journal_path")"
if [[ "$(dirname "$canonical_journal")" != "$canonical_ownership_dir" ]]; then
  echo "[error] Ownership journal is outside the controlled probe journal directory." >&2
  exit 2
fi

journal_fields="$({ QQBOT_PROBE_JOURNAL="$canonical_journal" node <<'NODE'
const fs = require('fs')
const path = require('path')
const value = JSON.parse(fs.readFileSync(process.env.QQBOT_PROBE_JOURNAL, 'utf8'))
const fail = (message) => { throw new Error(message) }
if (!value || typeof value !== 'object' || Array.isArray(value)) fail('journal must be an object')
if (value.schemaVersion !== 1 || value.owner !== 'qqbot-probe') fail('journal owner/schema mismatch')
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.token || '')) fail('invalid ownership token')
if (path.basename(process.env.QQBOT_PROBE_JOURNAL) !== `${value.token}.json`) fail('journal filename/token mismatch')
if (!['reserved', 'installing', 'installed', 'runtime-restored'].includes(value.phase)) fail('invalid journal phase')
const previous = value.previousBinding
if (previous != null && (!previous || typeof previous !== 'object' || Array.isArray(previous))) fail('invalid previous binding')
const encode = (item) => item == null || String(item) === ''
  ? '-'
  : Buffer.from(String(item), 'utf8').toString('base64')
const updatedAt = previous && previous.updatedAt != null
  ? (typeof previous.updatedAt === 'number' ? previous.updatedAt : Date.parse(String(previous.updatedAt)))
  : ''
if (updatedAt !== '' && !Number.isFinite(updatedAt)) fail('invalid previous binding timestamp')
process.stdout.write([
  value.token,
  value.userId,
  value.groupId,
  value.phase,
  encode(value.bindingKey),
  encode(value.conversationId),
  previous ? '1' : '0',
  encode(previous && previous.bindingKey),
  encode(previous && previous.activeConversationId),
  previous && previous.activeConversationId == null ? '1' : '0',
  encode(previous && previous.lastConversationId),
  previous && previous.lastConversationId == null ? '1' : '0',
  encode(updatedAt),
].join('\t'))
NODE
} 2>&1)" || {
  echo "[error] Invalid probe ownership journal: $journal_fields" >&2
  exit 2
}

IFS=$'\t' read -r ownership_token fake_user_id group_id journal_phase binding_key_b64 conversation_id_b64 previous_exists previous_key_b64 previous_active_b64 previous_active_null previous_last_b64 previous_last_null previous_updated_b64 <<<"$journal_fields"
decode_b64() {
  [[ "$1" == "-" ]] && return
  printf '%s' "$1" | base64 -d
}
binding_key="$(decode_b64 "$binding_key_b64")"
conversation_id="$(decode_b64 "$conversation_id_b64")"
previous_key="$(decode_b64 "$previous_key_b64")"
previous_active="$(decode_b64 "$previous_active_b64")"
previous_last="$(decode_b64 "$previous_last_b64")"
previous_updated="$(decode_b64 "$previous_updated_b64")"

if [[ "$group_id" == "$LIVE_ACCEPTANCE_GROUP_ID" ]]; then
  echo "[error] Refusing to clean the live acceptance group ${LIVE_ACCEPTANCE_GROUP_ID}." >&2
  exit 2
fi
if ! [[ "$fake_user_id" =~ ^${TEMP_USER_PREFIX}[0-9]{9}$ ]]; then
  echo "[error] Journal user is outside the controlled temporary namespace." >&2
  exit 2
fi
if ! [[ "$group_id" =~ ^${TEMP_GROUP_PREFIX}[0-9]{9}$ ]]; then
  echo "[error] Journal group is outside the controlled temporary namespace." >&2
  exit 2
fi
if [[ "$journal_phase" != "reserved" ]]; then
  if [[ -z "$binding_key" || -z "$conversation_id" ]]; then
    echo "[error] Installed probe journal is missing binding/conversation ownership." >&2
    exit 2
  fi
  expected_binding_suffix=":${group_id}:preset:"
  if [[ "$binding_key" != shared:onebot:*"${expected_binding_suffix}"* ]]; then
    echo "[error] Journal binding does not belong to the temporary group." >&2
    exit 2
  fi
  if [[ "$previous_exists" == "1" && "$previous_key" != "$binding_key" ]]; then
    echo "[error] Previous binding snapshot belongs to a different key." >&2
    exit 2
  fi
fi

db_path="$(resolve_db_path)"
if [[ ! -f "$db_path" ]]; then
  echo "[error] koishi db not found: $db_path" >&2
  exit 2
fi

expected_marker="$(node -e "process.stdout.write(JSON.stringify({qqbotProbe:{schemaVersion:1,token:process.argv[1],userId:process.argv[2],groupId:process.argv[3]}}))" "$ownership_token" "$fake_user_id" "$group_id")"
owned_room_id=""
owned_room_conversation_id=""

if [[ -n "$binding_key" ]] && ! table_exists chatluna_binding; then
  echo "[error] Installed probe journal requires chatluna_binding for ownership recovery." >&2
  exit 2
fi
if [[ -n "$conversation_id" ]] && ! table_exists chatluna_conversation; then
  echo "[error] Installed probe journal requires chatluna_conversation for ownership recovery." >&2
  exit 2
fi

if [[ -n "$conversation_id" ]] && table_exists chatluna_conversation; then
  conversation_count="$(sqlite3 "$db_path" "select count(*) from chatluna_conversation where id=$(sql_quote "$conversation_id");")"
  if [[ "$conversation_count" != "0" ]]; then
    owned_count="$(sqlite3 "$db_path" "select count(*) from chatluna_conversation where id=$(sql_quote "$conversation_id") and bindingKey=$(sql_quote "$binding_key") and createdBy=$(sql_quote "$fake_user_id") and additional_kwargs=$(sql_quote "$expected_marker");")"
    if [[ "$owned_count" != "1" ]]; then
      echo "[error] Conversation ownership marker does not match journal; refusing cleanup." >&2
      exit 2
    fi
  fi
fi

binding_action="none"
if [[ -n "$binding_key" ]] && table_exists chatluna_binding; then
  current_binding_count="$(sqlite3 "$db_path" "select count(*) from chatluna_binding where bindingKey=$(sql_quote "$binding_key");")"
  current_active="$(sqlite3 "$db_path" "select coalesce(activeConversationId,'') from chatluna_binding where bindingKey=$(sql_quote "$binding_key") limit 1;")"
  current_last="$(sqlite3 "$db_path" "select coalesce(lastConversationId,'') from chatluna_binding where bindingKey=$(sql_quote "$binding_key") limit 1;")"
  if [[ "$current_binding_count" == "1" && "$current_active" == "$conversation_id" ]]; then
    binding_action="restore"
  elif [[ "$previous_exists" == "1" && "$current_binding_count" == "1" && "$current_active" == "$previous_active" && "$current_last" == "$previous_last" ]]; then
    binding_action="already-restored"
  elif [[ "$previous_exists" == "0" && "$current_binding_count" == "0" ]]; then
    binding_action="already-restored"
  elif [[ -n "$conversation_id" ]]; then
    echo "[error] Active binding is no longer owned by this probe; refusing cleanup." >&2
    exit 2
  fi
fi

if table_exists chathub_user; then
  room_mapping_count="$(sqlite3 "$db_path" "select count(*) from chathub_user where userId=$(sql_quote "$fake_user_id") and groupId=$(sql_quote "$group_id");")"
  if [[ "$room_mapping_count" -gt 1 ]]; then
    echo "[error] Probe identity has multiple room mappings; refusing ambiguous cleanup." >&2
    exit 2
  fi
  if [[ "$room_mapping_count" == "1" ]]; then
    owned_room_id="$(sqlite3 "$db_path" "select defaultRoomId from chathub_user where userId=$(sql_quote "$fake_user_id") and groupId=$(sql_quote "$group_id") limit 1;")"
    if ! table_exists chathub_room; then
      echo "[error] Probe room mapping exists without chathub_room." >&2
      exit 2
    fi
    owned_room_count="$(sqlite3 "$db_path" "select count(*) from chathub_room where roomId=${owned_room_id} and roomMasterId=$(sql_quote "$fake_user_id") and instr(roomName,$(sql_quote "$ownership_token"))>0;")"
    if [[ "$owned_room_count" != "1" ]]; then
      echo "[error] Probe room ownership marker does not match journal; refusing cleanup." >&2
      exit 2
    fi
    owned_room_conversation_id="$(sqlite3 "$db_path" "select coalesce(conversationId,'') from chathub_room where roomId=${owned_room_id} limit 1;")"
    if [[ -n "$owned_room_conversation_id" ]]; then
      if ! table_exists chatluna_conversation; then
        echo "[error] Probe room references a conversation without chatluna_conversation." >&2
        exit 2
      fi
      owned_room_conversation_count="$(sqlite3 "$db_path" "select count(*) from chatluna_conversation where id=$(sql_quote "$owned_room_conversation_id") and createdBy=$(sql_quote "$fake_user_id") and additional_kwargs=$(sql_quote "$expected_marker");")"
      if [[ "$owned_room_conversation_count" != "1" ]]; then
        echo "[error] Probe room conversation ownership marker does not match journal; refusing cleanup." >&2
        exit 2
      fi
      shared_room_conversation_count="$(sqlite3 "$db_path" "select count(*) from chathub_room where roomId!=${owned_room_id} and conversationId=$(sql_quote "$owned_room_conversation_id");")"
      if [[ "$shared_room_conversation_count" != "0" ]]; then
        echo "[error] Probe room conversation is shared by another room; refusing cleanup." >&2
        exit 2
      fi
      if table_exists chatluna_binding; then
        shared_binding_conversation_count="$(sqlite3 "$db_path" "select count(*) from chatluna_binding where (bindingKey is null or bindingKey!=$(sql_quote "$binding_key")) and (activeConversationId=$(sql_quote "$owned_room_conversation_id") or lastConversationId=$(sql_quote "$owned_room_conversation_id"));")"
        if [[ "$shared_binding_conversation_count" != "0" ]]; then
          echo "[error] Probe room conversation is referenced by another binding; refusing cleanup." >&2
          exit 2
        fi
      fi
    fi
    if table_exists chathub_room_member; then
      foreign_room_member_count="$(sqlite3 "$db_path" "select count(*) from chathub_room_member where roomId=${owned_room_id} and (userId is null or userId!=$(sql_quote "$fake_user_id"));")"
      if [[ "$foreign_room_member_count" != "0" ]]; then
        echo "[error] Probe room has a foreign user member; refusing cleanup." >&2
        exit 2
      fi
    fi
    if table_exists chathub_room_group_member; then
      foreign_room_group_count="$(sqlite3 "$db_path" "select count(*) from chathub_room_group_member where roomId=${owned_room_id} and (groupId is null or groupId!=$(sql_quote "$group_id"));")"
      if [[ "$foreign_room_group_count" != "0" ]]; then
        echo "[error] Probe room has a foreign group member; refusing cleanup." >&2
        exit 2
      fi
    fi
    foreign_room_mapping_count="$(sqlite3 "$db_path" "select count(*) from chathub_user where defaultRoomId=${owned_room_id} and (userId is null or userId!=$(sql_quote "$fake_user_id") or groupId is null or groupId!=$(sql_quote "$group_id"));")"
    if [[ "$foreign_room_mapping_count" != "0" ]]; then
      echo "[error] Probe room is referenced by a foreign user mapping; refusing cleanup." >&2
      exit 2
    fi
  fi
fi

memory_schema="$(sqlite3 "$db_path" "select group_concat(name, ',') from (select name from sqlite_schema where type='table' and name like 'memory_v3_%' and name != 'memory_v3_meta' order by name);" | tr -d '\n')"
memory_cleanup_sql=""
case "$memory_schema" in
  "") ;;
  "memory_v3_context,memory_v3_principal")
    memory_cleanup_sql="
delete from memory_v3_principal where userKey=$(sql_quote "onebot:user:${fake_user_id}") and platform='onebot' and userId=$(sql_quote "$fake_user_id");
delete from memory_v3_context where platform='onebot' and channelType='group' and groupId=$(sql_quote "$group_id");"
    ;;
  "memory_v3_audit,memory_v3_context,memory_v3_cursor,memory_v3_event,memory_v3_evidence,memory_v3_head,memory_v3_lexical_document,memory_v3_lexical_term,memory_v3_payload,memory_v3_principal,memory_v3_suppression,memory_v3_work")
    memory_cleanup_sql="
create temp table probe_memory_context_keys as
select contextKey from memory_v3_context where platform='onebot' and channelType='group' and groupId=$(sql_quote "$group_id");
create temp table probe_memory_candidate_stream_ids as
select distinct streamId from memory_v3_event
where actorKey=$(sql_quote "onebot:user:${fake_user_id}")
  and sourceContextKey in (select contextKey from probe_memory_context_keys);
create temp table probe_memory_stream_ids as
select candidate.streamId from probe_memory_candidate_stream_ids candidate
where not exists (
  select 1 from memory_v3_event event
  where event.streamId=candidate.streamId
    and (
      event.actorKey is null
      or event.actorKey!=$(sql_quote "onebot:user:${fake_user_id}")
      or event.sourceContextKey is null
      or event.sourceContextKey not in (select contextKey from probe_memory_context_keys)
    )
)
and not exists (
  select 1 from memory_v3_event event
  join memory_v3_evidence evidence on evidence.eventId=event.eventId
  where event.streamId=candidate.streamId
    and (evidence.contextKey is null or evidence.contextKey not in (select contextKey from probe_memory_context_keys))
)
and not exists (
  select 1 from memory_v3_head head
  where head.streamId=candidate.streamId
    and (
      head.sourceContextKey is null
      or head.sourceContextKey not in (select contextKey from probe_memory_context_keys)
    )
);
create temp table probe_memory_ownership_guard (ambiguousCount integer check (ambiguousCount=0));
insert into probe_memory_ownership_guard
select count(*) from probe_memory_candidate_stream_ids
where streamId not in (select streamId from probe_memory_stream_ids);
create temp table probe_memory_event_ids as
select eventId from memory_v3_event where streamId in (select streamId from probe_memory_stream_ids);
create temp table probe_memory_payload_ids as
select payloadId from memory_v3_payload where eventId in (select eventId from probe_memory_event_ids)
union
select payloadId from memory_v3_head where streamId in (select streamId from probe_memory_stream_ids) and payloadId is not null
union
select excerptPayloadId from memory_v3_evidence where eventId in (select eventId from probe_memory_event_ids) and excerptPayloadId is not null;
delete from memory_v3_lexical_term where streamId in (select streamId from probe_memory_stream_ids);
delete from memory_v3_lexical_document where streamId in (select streamId from probe_memory_stream_ids) or eventId in (select eventId from probe_memory_event_ids);
delete from memory_v3_evidence where eventId in (select eventId from probe_memory_event_ids) and contextKey in (select contextKey from probe_memory_context_keys);
delete from memory_v3_payload where payloadId in (select payloadId from probe_memory_payload_ids) or eventId in (select eventId from probe_memory_event_ids);
delete from memory_v3_head where streamId in (select streamId from probe_memory_stream_ids);
delete from memory_v3_event where eventId in (select eventId from probe_memory_event_ids) or streamId in (select streamId from probe_memory_stream_ids);
delete from memory_v3_work where subjectKey=$(sql_quote "onebot:user:${fake_user_id}") and contextKey in (select contextKey from probe_memory_context_keys);
delete from memory_v3_cursor where subjectKey=$(sql_quote "onebot:user:${fake_user_id}") and contextKey in (select contextKey from probe_memory_context_keys);
delete from memory_v3_suppression where subjectKey=$(sql_quote "onebot:user:${fake_user_id}") and contextKey in (select contextKey from probe_memory_context_keys);
delete from memory_v3_audit where subjectKey=$(sql_quote "onebot:user:${fake_user_id}") and contextKey in (select contextKey from probe_memory_context_keys);
delete from memory_v3_principal where userKey=$(sql_quote "onebot:user:${fake_user_id}") and platform='onebot' and userId=$(sql_quote "$fake_user_id")
  and not exists (select 1 from memory_v3_event where subjectKey=$(sql_quote "onebot:user:${fake_user_id}"))
  and not exists (select 1 from memory_v3_event where actorKey=$(sql_quote "onebot:user:${fake_user_id}"))
  and not exists (select 1 from memory_v3_head where subjectKey=$(sql_quote "onebot:user:${fake_user_id}"))
  and not exists (select 1 from memory_v3_work where subjectKey=$(sql_quote "onebot:user:${fake_user_id}"))
  and not exists (select 1 from memory_v3_cursor where subjectKey=$(sql_quote "onebot:user:${fake_user_id}"))
  and not exists (select 1 from memory_v3_suppression where subjectKey=$(sql_quote "onebot:user:${fake_user_id}"))
  and not exists (select 1 from memory_v3_audit where subjectKey=$(sql_quote "onebot:user:${fake_user_id}"));
delete from memory_v3_context where contextKey in (select contextKey from probe_memory_context_keys)
  and not exists (select 1 from memory_v3_event where sourceContextKey=memory_v3_context.contextKey)
  and not exists (select 1 from memory_v3_evidence where contextKey=memory_v3_context.contextKey)
  and not exists (select 1 from memory_v3_head where sourceContextKey=memory_v3_context.contextKey)
  and not exists (select 1 from memory_v3_work where contextKey=memory_v3_context.contextKey)
  and not exists (select 1 from memory_v3_cursor where contextKey=memory_v3_context.contextKey)
  and not exists (select 1 from memory_v3_suppression where contextKey=memory_v3_context.contextKey)
  and not exists (select 1 from memory_v3_audit where contextKey=memory_v3_context.contextKey);
drop table probe_memory_payload_ids;
drop table probe_memory_event_ids;
drop table probe_memory_stream_ids;
drop table probe_memory_candidate_stream_ids;
drop table probe_memory_ownership_guard;
drop table probe_memory_context_keys;"
    ;;
  *)
    echo "[error] unsupported probe memory schema: ${memory_schema}" >&2
    exit 2
    ;;
esac

ownership_guard_sql="create temp table probe_cleanup_ownership_guard (owned integer check (owned=1));"
binding_cleanup_sql=""
if [[ "$binding_action" == "restore" ]]; then
  if [[ "$previous_exists" == "1" ]]; then
    previous_active_sql="$(sql_quote "$previous_active")"
    previous_last_sql="$(sql_quote "$previous_last")"
    [[ "$previous_active_null" == "1" ]] && previous_active_sql="null"
    [[ "$previous_last_null" == "1" ]] && previous_last_sql="null"
    binding_cleanup_sql="update chatluna_binding set activeConversationId=${previous_active_sql},lastConversationId=${previous_last_sql},updatedAt=${previous_updated:-0} where bindingKey=$(sql_quote "$binding_key") and activeConversationId=$(sql_quote "$conversation_id");
insert into probe_cleanup_ownership_guard values (changes());"
  else
    binding_cleanup_sql="delete from chatluna_binding where bindingKey=$(sql_quote "$binding_key") and activeConversationId=$(sql_quote "$conversation_id");
insert into probe_cleanup_ownership_guard values (changes());"
  fi
elif [[ "$binding_action" == "already-restored" ]]; then
  if [[ "$previous_exists" == "1" ]]; then
    previous_active_condition="activeConversationId=$(sql_quote "$previous_active")"
    previous_last_condition="lastConversationId=$(sql_quote "$previous_last")"
    [[ "$previous_active_null" == "1" ]] && previous_active_condition="activeConversationId is null"
    [[ "$previous_last_null" == "1" ]] && previous_last_condition="lastConversationId is null"
    ownership_guard_sql+=$'\n'"insert into probe_cleanup_ownership_guard select case when count(*)=1 then 1 else 0 end from chatluna_binding where bindingKey=$(sql_quote "$binding_key") and ${previous_active_condition} and ${previous_last_condition};"
  else
    ownership_guard_sql+=$'\n'"insert into probe_cleanup_ownership_guard select case when count(*)=0 then 1 else 0 end from chatluna_binding where bindingKey=$(sql_quote "$binding_key");"
  fi
fi

if [[ -n "$conversation_id" ]] && table_exists chatluna_conversation; then
  ownership_guard_sql+=$'\n'"insert into probe_cleanup_ownership_guard select case when (select count(*) from chatluna_conversation where id=$(sql_quote "$conversation_id"))=(select count(*) from chatluna_conversation where id=$(sql_quote "$conversation_id") and bindingKey=$(sql_quote "$binding_key") and createdBy=$(sql_quote "$fake_user_id") and additional_kwargs=$(sql_quote "$expected_marker")) then 1 else 0 end;"
fi
if [[ -n "$owned_room_id" ]]; then
  ownership_guard_sql+=$'\n'"insert into probe_cleanup_ownership_guard select case when count(*)=1 then 1 else 0 end from chathub_room where roomId=${owned_room_id} and roomMasterId=$(sql_quote "$fake_user_id") and instr(roomName,$(sql_quote "$ownership_token"))>0;"
  ownership_guard_sql+=$'\n'"insert into probe_cleanup_ownership_guard select case when count(*)=1 then 1 else 0 end from chathub_user where userId=$(sql_quote "$fake_user_id") and groupId=$(sql_quote "$group_id") and defaultRoomId=${owned_room_id};"
  ownership_guard_sql+=$'\n'"insert into probe_cleanup_ownership_guard select case when count(*)=0 then 1 else 0 end from chathub_user where defaultRoomId=${owned_room_id} and (userId is null or userId!=$(sql_quote "$fake_user_id") or groupId is null or groupId!=$(sql_quote "$group_id"));"
  if [[ -n "$owned_room_conversation_id" ]]; then
    ownership_guard_sql+=$'\n'"insert into probe_cleanup_ownership_guard select case when count(*)=1 then 1 else 0 end from chatluna_conversation where id=$(sql_quote "$owned_room_conversation_id") and createdBy=$(sql_quote "$fake_user_id") and additional_kwargs=$(sql_quote "$expected_marker");"
    ownership_guard_sql+=$'\n'"insert into probe_cleanup_ownership_guard select case when count(*)=0 then 1 else 0 end from chathub_room where roomId!=${owned_room_id} and conversationId=$(sql_quote "$owned_room_conversation_id");"
    if table_exists chatluna_binding; then
      ownership_guard_sql+=$'\n'"insert into probe_cleanup_ownership_guard select case when count(*)=0 then 1 else 0 end from chatluna_binding where (bindingKey is null or bindingKey!=$(sql_quote "$binding_key")) and (activeConversationId=$(sql_quote "$owned_room_conversation_id") or lastConversationId=$(sql_quote "$owned_room_conversation_id"));"
    fi
  fi
  if table_exists chathub_room_member; then
    ownership_guard_sql+=$'\n'"insert into probe_cleanup_ownership_guard select case when count(*)=0 then 1 else 0 end from chathub_room_member where roomId=${owned_room_id} and (userId is null or userId!=$(sql_quote "$fake_user_id"));"
  fi
  if table_exists chathub_room_group_member; then
    ownership_guard_sql+=$'\n'"insert into probe_cleanup_ownership_guard select case when count(*)=0 then 1 else 0 end from chathub_room_group_member where roomId=${owned_room_id} and (groupId is null or groupId!=$(sql_quote "$group_id"));"
  fi
fi

chat_cleanup_sql="${ownership_guard_sql}"$'\n'"${binding_cleanup_sql}"
if [[ -n "$conversation_id" ]] && table_exists chatluna_conversation; then
  if table_exists chatluna_message; then
    chat_cleanup_sql+=$'\n'"delete from chatluna_message where conversationId=$(sql_quote "$conversation_id") and exists (select 1 from chatluna_conversation where id=$(sql_quote "$conversation_id") and bindingKey=$(sql_quote "$binding_key") and createdBy=$(sql_quote "$fake_user_id") and additional_kwargs=$(sql_quote "$expected_marker"));"
  fi
  chat_cleanup_sql+=$'\n'"delete from chatluna_conversation where id=$(sql_quote "$conversation_id") and bindingKey=$(sql_quote "$binding_key") and createdBy=$(sql_quote "$fake_user_id") and additional_kwargs=$(sql_quote "$expected_marker");"
fi
if [[ -n "$owned_room_id" ]]; then
  if [[ -n "$owned_room_conversation_id" && "$owned_room_conversation_id" != "$conversation_id" ]] && table_exists chatluna_conversation; then
    if table_exists chatluna_message; then
      chat_cleanup_sql+=$'\n'"delete from chatluna_message where conversationId=$(sql_quote "$owned_room_conversation_id") and exists (select 1 from chatluna_conversation where id=$(sql_quote "$owned_room_conversation_id") and createdBy=$(sql_quote "$fake_user_id") and additional_kwargs=$(sql_quote "$expected_marker"));"
    fi
    chat_cleanup_sql+=$'\n'"delete from chatluna_conversation where id=$(sql_quote "$owned_room_conversation_id") and createdBy=$(sql_quote "$fake_user_id") and additional_kwargs=$(sql_quote "$expected_marker");"
  fi
  if table_exists chathub_room_group_member; then
    chat_cleanup_sql+=$'\n'"delete from chathub_room_group_member where roomId=${owned_room_id};"
  fi
  if table_exists chathub_room_member; then
    chat_cleanup_sql+=$'\n'"delete from chathub_room_member where roomId=${owned_room_id};"
  fi
  chat_cleanup_sql+=$'\n'"delete from chathub_user where userId=$(sql_quote "$fake_user_id") and groupId=$(sql_quote "$group_id") and defaultRoomId=${owned_room_id};"
  chat_cleanup_sql+=$'\n'"delete from chathub_room where roomId=${owned_room_id} and roomMasterId=$(sql_quote "$fake_user_id") and instr(roomName,$(sql_quote "$ownership_token"))>0;"
fi

sqlite3 "$db_path" <<SQL
.bail on
begin immediate;
${chat_cleanup_sql}
${memory_cleanup_sql}
commit;
SQL

rm -f -- "$canonical_journal" "${canonical_journal}.tmp"
echo "[info] cleaned owned probe state: token=${ownership_token} user=${fake_user_id} group=${group_id}" >&2

#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  probe-local-bot.sh <prompt>
  printf '%s' '<prompt>' | probe-local-bot.sh
  printf '%s' '<sequence-json>' | probe-local-bot.sh --sequence

Description:
  Inject a synthetic QQ group message into the locally running Koishi bot,
  capture only the real outbound reply for that group, and print a JSON result.
  This probe is group-only and must not be used to infer private-chat behavior.
  Sequence mode runs every turn in one isolated temporary conversation and
  removes its messages, conversation, and binding state before exit.
  The script temporarily opens Node inspector on 127.0.0.1:9229 when needed
  and closes it after the probe by default.
  For workflow and result interpretation, use $qqbot-group-probe at
  /home/kkkzbh/code/qqbot/.codex/skills/qqbot-group-probe/SKILL.md

Environment:
  FAKE_USER_ID          Controlled temporary user id (15 digits, prefix 890000)
  FAKE_GROUP_ID         Controlled temporary group id (15 digits, prefix 880000)
  PROBE_ISOLATED_ROOM   Must be 1. Every probe owns an isolated conversation.
  PROBE_PRESET_ID       Preset used by an isolated probe room. When omitted,
                       the current group preset lane is preserved.
  PROBE_TRIGGER_PREFIX  Trigger prefix injected when the input lacks an obvious
                       group trigger keyword (default: saki )
  PROBE_ASSERT_FAILURES Set to 0 to keep printing probe json without returning
                       failure on detected model/runtime errors (default: 1)
  BOT_TIMEOUT_SECONDS   Max seconds to wait for reply stability (default: 40)
  KEEP_INSPECTOR        Set to 1 to keep inspector open after the probe
EOF
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[error] Missing command: $1" >&2
    exit 2
  fi
}

ensure_positive_int() {
  local name="$1"
  local value="$2"
  if ! [[ "$value" =~ ^[0-9]+$ ]] || [[ "$value" -le 0 ]]; then
    echo "[error] $name must be a positive integer" >&2
    exit 2
  fi
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

require_cmd curl
require_cmd node
require_cmd base64
require_cmd flock
require_cmd mkdir

sequence_mode=0
sequence_json=""
prompt=""
if [[ "${1:-}" == "--sequence" ]]; then
  sequence_mode=1
  shift
  if (( $# > 0 )) || [[ -t 0 ]]; then
    echo "[error] Sequence mode reads one JSON object from stdin and accepts no positional prompt." >&2
    exit 2
  fi
  sequence_json="$(cat)"
  if [[ -z "$sequence_json" ]]; then
    echo "[error] Missing sequence JSON." >&2
    exit 2
  fi
elif [[ "$#" -gt 0 ]]; then
  prompt="$*"
elif [[ ! -t 0 ]]; then
  prompt="$(cat)"
fi

if [[ "$sequence_mode" == "0" && -z "$prompt" ]]; then
  echo "[error] Missing prompt." >&2
  usage >&2
  exit 2
fi

timeout_seconds="${BOT_TIMEOUT_SECONDS:-40}"
keep_inspector="${KEEP_INSPECTOR:-0}"
probe_isolated_room="${PROBE_ISOLATED_ROOM:-1}"
probe_preset_id="${PROBE_PRESET_ID:-}"
probe_trigger_prefix="${PROBE_TRIGGER_PREFIX:-saki }"
probe_assert_failures="${PROBE_ASSERT_FAILURES:-1}"
ensure_positive_int "BOT_TIMEOUT_SECONDS" "$timeout_seconds"

if [[ "$sequence_mode" == "1" ]]; then
  probe_isolated_room=1
fi

if [[ -n "${PROBE_TAB:-}" || -n "${PROBE_ROOM_MODEL:-}" ]]; then
  echo "[error] PROBE_TAB and PROBE_ROOM_MODEL are no longer supported. Configure the canonical main.chat or room model instead." >&2
  exit 2
fi

if [[ "$probe_isolated_room" != "1" ]]; then
  echo "[error] PROBE_ISOLATED_ROOM must be 1; probe-local-bot.sh only operates owned temporary conversations." >&2
  exit 2
fi

if [[ -n "$probe_preset_id" && ! "$probe_preset_id" =~ ^[a-z0-9]+([_-][a-z0-9]+)*$ ]]; then
  echo "[error] PROBE_PRESET_ID must be a lowercase preset slug." >&2
  exit 2
fi

if [[ "$probe_assert_failures" != "0" && "$probe_assert_failures" != "1" ]]; then
  echo "[error] PROBE_ASSERT_FAILURES must be 0 or 1." >&2
  exit 2
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
cd "$repo_root"
default_group_id="$(
  node -e "const shared=require('./scripts/lib/probe-local-bot-shared.cjs'); process.stdout.write(shared.DEFAULT_PROBE_GROUP_ID)"
)"
live_acceptance_group_id="$(
  node -e "const shared=require('./scripts/lib/probe-local-bot-shared.cjs'); process.stdout.write(shared.LIVE_ACCEPTANCE_GROUP_ID)"
)"
temp_group_prefix="$(
  node -e "const shared=require('./scripts/lib/probe-local-bot-shared.cjs'); process.stdout.write(shared.TEMP_PROBE_GROUP_PREFIX)"
)"
temp_user_prefix="$(
  node -e "const shared=require('./scripts/lib/probe-local-bot-shared.cjs'); process.stdout.write(shared.TEMP_PROBE_USER_PREFIX)"
)"
probe_lock_relative="$(
  node -e "const shared=require('./scripts/lib/probe-local-bot-shared.cjs'); process.stdout.write(shared.PROBE_LOCK_FILE)"
)"
if [[ "$probe_lock_relative" != .tmp/probe-runtime/* ]]; then
  echo "[error] Probe lock must live in the controlled workspace runtime directory." >&2
  exit 2
fi
probe_lock_file="$repo_root/$probe_lock_relative"
probe_lock_parent="$(dirname "$probe_lock_file")"
if [[ -L "$repo_root/.tmp" || -L "$probe_lock_parent" ]]; then
  echo "[error] Probe runtime directory must not be a symbolic link." >&2
  exit 2
fi
mkdir -p -m 700 "$probe_lock_parent"
chmod 700 "$probe_lock_parent"
if [[ -L "$probe_lock_file" ]]; then
  echo "[error] Probe lock file must not be a symbolic link." >&2
  exit 2
fi

if [[ -z "${FAKE_USER_ID:-}" ]]; then
  fake_user_id="$(node -e "const {randomInt}=require('crypto'); process.stdout.write('${temp_user_prefix}'+String(randomInt(0,1e9)).padStart(9,'0'))")"
else
  fake_user_id="$FAKE_USER_ID"
fi
fake_group_id="${FAKE_GROUP_ID:-$default_group_id}"

if ! [[ "$fake_user_id" =~ ^${temp_user_prefix}[0-9]{9}$ ]]; then
  echo "[error] FAKE_USER_ID must belong to the controlled temporary namespace ${temp_user_prefix}#########." >&2
  exit 2
fi

if [[ "$fake_group_id" == "$live_acceptance_group_id" ]]; then
  echo "[error] Group ${live_acceptance_group_id} is reserved for explicit live acceptance and cannot be used by probe-local-bot.sh." >&2
  exit 2
fi

if ! [[ "$fake_group_id" =~ ^${temp_group_prefix}[0-9]{9}$ ]]; then
  echo "[error] FAKE_GROUP_ID must belong to the controlled temporary namespace ${temp_group_prefix}#########." >&2
  exit 2
fi

if [[ -n "${QQBOT_PREPARE_DEBUG_CHAT_MODE:-}" ]]; then
  echo "[error] QQBOT_PREPARE_DEBUG_CHAT_MODE is no longer supported. probe-local-bot.sh is group-only." >&2
  exit 2
fi

original_prompt="$prompt"

if [[ "$sequence_mode" == "0" ]]; then
  if ! printf '%s' "$prompt" | rg -qi '(^|[[:space:][:punct:]])(saki|祥)([[:space:][:punct:]]|$)'; then
    prompt="${probe_trigger_prefix}${prompt}"
  fi
fi

exec 9>"$probe_lock_file"
if ! flock -n 9; then
  echo "[error] Another group probe is already running. Wait for it to finish before starting a new one." >&2
  exit 1
fi

cleanup_probe_lock() {
  flock -u 9 >/dev/null 2>&1 || true
  exec 9>&-
}
trap cleanup_probe_lock EXIT

probe_ownership_dir="$repo_root/.tmp/probe-ownership"
mkdir -p "$probe_ownership_dir"

for stale_journal in "$probe_ownership_dir"/*.json; do
  [[ -e "$stale_journal" ]] || continue
  if ! bash "$repo_root/scripts/cleanup-probe-chat-state.sh" "$stale_journal" >/dev/null; then
    echo "[error] Failed to recover stale probe ownership journal: $stale_journal" >&2
    cleanup_probe_lock
    exit 1
  fi
done

ownership_token="$(node -e "process.stdout.write(require('crypto').randomUUID())")"
ownership_journal="$probe_ownership_dir/$ownership_token.json"
fake_group_name="qqbot-probe:$ownership_token"
fake_group_card="qqbot-probe:$ownership_token"
QQBOT_PROBE_JOURNAL="$ownership_journal" \
QQBOT_PROBE_TOKEN="$ownership_token" \
QQBOT_PROBE_USER_ID="$fake_user_id" \
QQBOT_PROBE_GROUP_ID="$fake_group_id" \
node <<'NODE'
const fs = require('fs')
const journal = process.env.QQBOT_PROBE_JOURNAL
const value = {
  schemaVersion: 1,
  owner: 'qqbot-probe',
  token: process.env.QQBOT_PROBE_TOKEN,
  userId: process.env.QQBOT_PROBE_USER_ID,
  groupId: process.env.QQBOT_PROBE_GROUP_ID,
  phase: 'reserved',
  createdAt: new Date().toISOString(),
  bindingKey: null,
  conversationId: null,
  previousBinding: null,
}
const temporary = `${journal}.tmp`
fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { flag: 'wx' })
fs.renameSync(temporary, journal)
NODE

cleanup_owned_probe_state() {
  bash "$repo_root/scripts/cleanup-probe-chat-state.sh" "$ownership_journal" >/dev/null
}

cleanup_on_exit() {
  local exit_status=$?
  trap - EXIT
  if ! cleanup_owned_probe_state; then
    echo "[error] Failed to clean owned probe state from journal=$ownership_journal." >&2
    exit_status=1
  fi
  cleanup_probe_lock
  exit "$exit_status"
}

trap cleanup_on_exit EXIT

worker_pid="$(ps -ef | awk '/koishi\/lib\/worker/ && !/awk/ {print $2; exit}')"
if [[ -z "$worker_pid" ]]; then
  echo "[error] Failed to find local Koishi worker pid." >&2
  exit 1
fi

opened_inspector=0
if ! curl -fsS http://127.0.0.1:9229/json/list >/dev/null 2>&1; then
  kill -USR1 "$worker_pid"
  opened_inspector=1
  for _ in $(seq 1 50); do
    if curl -fsS http://127.0.0.1:9229/json/list >/dev/null 2>&1; then
      break
    fi
    sleep 0.2
  done
fi

if ! curl -fsS http://127.0.0.1:9229/json/list >/dev/null 2>&1; then
  echo "[error] Inspector did not become available on 127.0.0.1:9229." >&2
  exit 1
fi

prompt_b64="$(printf '%s' "$prompt" | base64 | tr -d '\n')"
sequence_b64="$(printf '%s' "$sequence_json" | base64 | tr -d '\n')"

probe_json="$(
  QQBOT_TEST_PROMPT_B64="$prompt_b64" \
  QQBOT_ORIGINAL_PROMPT_B64="$(printf '%s' "$original_prompt" | base64 | tr -d '\n')" \
  QQBOT_SEQUENCE_B64="$sequence_b64" \
  QQBOT_FAKE_USER_ID="$fake_user_id" \
  QQBOT_FAKE_GROUP_ID="$fake_group_id" \
  QQBOT_FAKE_GROUP_NAME="$fake_group_name" \
  QQBOT_FAKE_GROUP_CARD="$fake_group_card" \
  QQBOT_PROBE_ISOLATED_ROOM="$probe_isolated_room" \
  QQBOT_PROBE_PRESET_ID="$probe_preset_id" \
  QQBOT_TIMEOUT_SECONDS="$timeout_seconds" \
  QQBOT_KEEP_INSPECTOR="$keep_inspector" \
  QQBOT_OPENED_INSPECTOR="$opened_inspector" \
  QQBOT_PROBE_OWNERSHIP_TOKEN="$ownership_token" \
  QQBOT_PROBE_OWNERSHIP_JOURNAL="$ownership_journal" \
  node <<'NODE'
const path = require('path')
const http = require('http')
const {
  evaluateTurnTerminal,
  isCaptureAfterOrchestration,
  isSuccessfulDeliveryCapture,
  latestTerminalOrchestration,
  normalizeVisibleContent,
  serializePayload,
} = require(path.join(process.cwd(), 'scripts/lib/probe-local-bot-shared.cjs'))
const evaluateTurnTerminalSource = evaluateTurnTerminal.toString()
const isCaptureAfterOrchestrationSource = isCaptureAfterOrchestration.toString()
const isSuccessfulDeliveryCaptureSource = isSuccessfulDeliveryCapture.toString()
const latestTerminalOrchestrationSource = latestTerminalOrchestration.toString()
const normalizeVisibleContentSource = normalizeVisibleContent.toString()
const serializePayloadSource = serializePayload.toString()

const prompt = Buffer.from(process.env.QQBOT_TEST_PROMPT_B64 || '', 'base64').toString('utf8')
const originalPrompt = Buffer.from(process.env.QQBOT_ORIGINAL_PROMPT_B64 || '', 'base64').toString('utf8')
const sequenceJson = Buffer.from(process.env.QQBOT_SEQUENCE_B64 || '', 'base64').toString('utf8')
const fakeUserId = Number(process.env.QQBOT_FAKE_USER_ID || '0')
const fakeGroupId = Number(process.env.QQBOT_FAKE_GROUP_ID || '0')
const fakeGroupName = String(process.env.QQBOT_FAKE_GROUP_NAME || 'codex-probe-group')
const fakeGroupCard = String(process.env.QQBOT_FAKE_GROUP_CARD || 'codex-probe')
const probeIsolatedRoom = process.env.QQBOT_PROBE_ISOLATED_ROOM === '1'
const probePresetId = String(process.env.QQBOT_PROBE_PRESET_ID || '').trim()
const timeoutSeconds = Number(process.env.QQBOT_TIMEOUT_SECONDS || '40')
const keepInspector = process.env.QQBOT_KEEP_INSPECTOR === '1'
const openedInspector = process.env.QQBOT_OPENED_INSPECTOR === '1'
const ownershipToken = String(process.env.QQBOT_PROBE_OWNERSHIP_TOKEN || '')
const ownershipJournal = String(process.env.QQBOT_PROBE_OWNERSHIP_JOURNAL || '')

if (!prompt && !sequenceJson) {
  console.error('[error] Empty prompt after base64 decode.')
  process.exit(2)
}

let sequence = null
if (sequenceJson) {
  const allowedCategories = new Set([
    'casual_opportunity',
    'explicit_sticker',
    'informational_negative',
    'neutral',
    'serious_negative',
  ])
  sequence = JSON.parse(sequenceJson)
  if (!sequence || typeof sequence !== 'object' || Array.isArray(sequence)) {
    throw new Error('sequence input must be an object')
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(sequence.id || '')) {
    throw new Error('sequence id must be a lowercase slug')
  }
  if (!Array.isArray(sequence.turns) || sequence.turns.length < 2 || sequence.turns.length > 100) {
    throw new Error('sequence must contain 2 to 100 turns')
  }
  const turnIds = new Set()
  for (const turn of sequence.turns) {
    if (!turn || typeof turn !== 'object' || Array.isArray(turn)) throw new Error('sequence turns must be objects')
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(turn.id || '') || turnIds.has(turn.id)) {
      throw new Error('sequence turn ids must be unique lowercase slugs')
    }
    turnIds.add(turn.id)
    if (typeof turn.prompt !== 'string' || turn.prompt.trim() !== turn.prompt || !turn.prompt.startsWith('saki ')) {
      throw new Error('sequence prompts must be trimmed and include the real saki trigger')
    }
    if (!allowedCategories.has(turn.category)) {
      throw new Error('sequence turn has an unsupported category: ' + String(turn.category))
    }
  }
}

if (!Number.isFinite(fakeUserId) || fakeUserId <= 0) {
  console.error('[error] Invalid fake user id.')
  process.exit(2)
}

if (!Number.isFinite(fakeGroupId) || fakeGroupId <= 0) {
  console.error('[error] Invalid fake group id.')
  process.exit(2)
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = ''
      res.on('data', (chunk) => {
        data += chunk
      })
      res.on('end', () => {
        try {
          resolve(JSON.parse(data))
        } catch (error) {
          reject(error)
        }
      })
    }).on('error', reject)
  })
}

async function main() {
  const targets = await getJson('http://127.0.0.1:9229/json/list')
  const target = targets.find((item) => item.webSocketDebuggerUrl)
  if (!target) {
    throw new Error('no inspector target found')
  }

  const WebSocket = require(require.resolve('ws', { paths: [process.cwd()] }))
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  const pending = new Map()
  let seq = 0

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })

  ws.on('message', (buf) => {
    const msg = JSON.parse(buf.toString())
    if (!msg.id) return
    const task = pending.get(msg.id)
    if (!task) return
    pending.delete(msg.id)
    if (msg.error) {
      task.reject(new Error(msg.error.message || JSON.stringify(msg.error)))
      return
    }
    task.resolve(msg.result)
  })

  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })

  try {
    await send('Runtime.enable')

    const proto = await send('Runtime.evaluate', {
      expression:
        "(() => { const m = process.mainModule.require('@koishijs/loader'); const C = m.default || m; return C.prototype })()",
    })
    const queried = await send('Runtime.queryObjects', {
      prototypeObjectId: proto.result.objectId,
    })
    const activeLoader = await send('Runtime.callFunctionOn', {
      objectId: queried.objects.objectId,
      functionDeclaration: `function() {
        const loaders = Array.from(this || [])
        return (
          loaders.find((loader) =>
            loader &&
            loader.app &&
            loader.app.chatluna &&
            loader.app.chatluna.platform &&
            loader.app.chatluna.preset
          ) ||
          loaders.find((loader) =>
            loader &&
            loader.app &&
            loader.app.chatluna
          ) ||
          loaders.find((loader) => loader && loader.app) ||
          loaders[0] ||
          null
        )
      }`,
    })
    const loader = activeLoader.result.objectId
    if (!loader) {
      throw new Error('failed to resolve loader instance')
    }

    const call = await send('Runtime.callFunctionOn', {
      objectId: loader,
      functionDeclaration: `async function(input, originalInput, sequence, fakeUserId, fakeGroupId, fakeGroupName, fakeGroupCard, probeIsolatedRoom, probePresetId, timeoutSeconds, ownershipToken, ownershipJournal) {
        try {
          const latestTerminalOrchestration = ${latestTerminalOrchestrationSource}
          const isSuccessfulDeliveryCapture = ${isSuccessfulDeliveryCaptureSource}
          const isCaptureAfterOrchestration = ${isCaptureAfterOrchestrationSource}
          const evaluateTurnTerminal = ${evaluateTurnTerminalSource}
          const normalizeVisibleContent = ${normalizeVisibleContentSource}
          const serializePayload = ${serializePayloadSource}
          const requestedTurns = sequence
            ? sequence.turns.map((turn, index) => ({
                id: turn.id,
                category: turn.category,
                input: turn.prompt,
                originalInput: turn.prompt,
                index,
              }))
            : [{ id: null, category: null, input, originalInput: originalInput || input, index: 0 }]
          const sequenceId = sequence ? sequence.id : null
          const { OneBot } = process.mainModule.require('koishi-plugin-adapter-onebot')
          const dispatchSession = OneBot && OneBot.dispatchSession
          if (typeof dispatchSession !== 'function') {
            return JSON.stringify({
              ok: false,
              error: 'dispatchSession missing',
              adapterKeys: OneBot ? Object.keys(OneBot) : null,
            })
          }

          const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
          const detectFirstErrorSignature = (result) => {
            if (!result || typeof result !== 'object') {
              return null
            }

            if (result.ok === false) {
              return 'probe_execution_failed'
            }

            const visibleMessages = Array.isArray(result.visibleMessages)
              ? result.visibleMessages.map((item) => String(item || ''))
              : []
            const visibleText = visibleMessages.join('\\n')

            if (/ChatLunaError:?303|错误码为 303/i.test(visibleText)) {
              return 'ChatLunaError:303'
            }

            if (/is not a chat model/i.test(visibleText)) {
              return 'ModelIsNotChatModel'
            }

            const orchestrations = Array.isArray(result.orchestrations)
              ? result.orchestrations
              : []
            if (orchestrations.some((item) => item && item.result && item.result.status === 'error')) {
              return 'ReplyOrchestrationError'
            }
            if (
              orchestrations.length > 0 &&
              orchestrations.every((item) => item && item.result && item.result.status === 'await_model')
            ) {
              if (result.timeout === true) {
                return 'ReplyAwaitModelTimeout'
              }

              if (visibleMessages.length > 0) {
                return 'ReplyAwaitModelFailedBeforeModelCall'
              }
            }

            return null
          }
          const crypto = process.mainModule.require('crypto')
          const fs = process.mainModule.require('fs')
          const ownershipMarker = {
            qqbotProbe: {
              schemaVersion: 1,
              token: ownershipToken,
              userId: String(fakeUserId),
              groupId: String(fakeGroupId),
            },
          }
          const ownershipMarkerJson = JSON.stringify(ownershipMarker)
          const writeOwnershipJournal = (patch) => {
            const current = JSON.parse(fs.readFileSync(ownershipJournal, 'utf8'))
            if (current.owner !== 'qqbot-probe' || current.token !== ownershipToken) {
              throw new Error('probe ownership journal changed while the probe was running')
            }
            const next = { ...current, ...patch, updatedAt: new Date().toISOString() }
            const temporary = ownershipJournal + '.tmp'
            fs.writeFileSync(temporary, JSON.stringify(next) + '\\n', { flag: 'wx' })
            fs.renameSync(temporary, ownershipJournal)
          }
          const waitForStableRuntime = async () => {
            const deadline = Date.now() + 15000
            const stableWindowMs = 2500
            let stableSince = 0

            while (Date.now() < deadline) {
              const rawBots = this.app && this.app.bots
              const bots = Array.isArray(rawBots) ? rawBots : Object.values(rawBots || {})
              const onebotBot = bots.find((item) => item && item.platform === 'onebot')
              const stable = Boolean(
                this.app &&
                this.app.chatluna &&
                this.app.chatluna.platform &&
                this.app.chatluna.preset &&
                this.app.modelConfig &&
                onebotBot
              )

              if (stable) {
                stableSince ||= Date.now()
                if (Date.now() - stableSince >= stableWindowMs) {
                  return
                }
              } else {
                stableSince = 0
              }

              await sleep(250)
            }

            throw new Error('timed out waiting for Koishi/ChatLuna runtime to become stable')
          }

          await waitForStableRuntime()

          const modelConfig = this.app && this.app.modelConfig
          if (!modelConfig || typeof modelConfig.getRedactedRuntimeSnapshot !== 'function') {
            throw new Error('canonical model-config service is unavailable')
          }
          const modelSnapshot = modelConfig.getRedactedRuntimeSnapshot()
          const mainBinding = Array.isArray(modelSnapshot.resolvedBindings)
            ? modelSnapshot.resolvedBindings.find((binding) => binding && binding.workload === 'main.chat')
            : null
          if (
            !mainBinding ||
            mainBinding.mode !== 'dedicated' ||
            typeof mainBinding.canonicalModel !== 'string' ||
            mainBinding.canonicalModel.trim().length === 0
          ) {
            throw new Error('canonical model-config main.chat binding is not dedicated')
          }
          const mainModel = mainBinding.canonicalModel.trim()
          const canonicalModels = new Set(
            (Array.isArray(modelSnapshot.models) ? modelSnapshot.models : []).map(
              (model) => 'qqbot-' + model.connectionId + '/' + model.id
            )
          )
          if (!canonicalModels.has(mainModel)) {
            throw new Error('canonical model-config main.chat model is missing: ' + mainModel)
          }
          const shouldUseIsolatedRoom = Boolean(probeIsolatedRoom)
          if (!shouldUseIsolatedRoom || !ownershipToken || !ownershipJournal) {
            throw new Error('probe requires an owned isolated conversation')
          }

          const rawBots = this.app && this.app.bots
          const bots = Array.isArray(rawBots) ? rawBots : Object.values(rawBots || {})
          const bot = bots.find((item) => item.platform === 'onebot')
          if (!bot) {
            return JSON.stringify({ ok: false, error: 'onebot bot not found' })
          }

          const fakeChannelId = String(fakeGroupId)
          const cleanupWarnings = []
          let activeTurnCapture = null
          const turnCapturesByMessageId = new Map()
          let isolatedRoom = null
          let isolatedPreviousBinding = null
          const resolveProbeTurnCapture = (channelId, options) => {
            if (String(channelId) !== fakeChannelId) return null
            const session = options && typeof options === 'object' ? options.session : null
            if (!session || typeof session !== 'object') return null
            if (String(session.channelId ?? '') !== fakeChannelId) return null
            if (String(session.userId ?? '') !== String(fakeUserId)) return null
            return turnCapturesByMessageId.get(Number(session.messageId ?? 0)) || null
          }
          const capture = (turnCapture, route, content, extra = {}) => {
            if (!turnCapture) throw new Error('probe capture has no target turn')
            const visibleText = normalizeVisibleContent(content).trim()
            const captured = {
              route,
              channelId: fakeChannelId,
              visibleText,
              payload: serializePayload(content),
              at: Date.now(),
              ordinal: ++turnCapture.eventOrdinal,
              delivered: false,
              receipt: null,
              ...extra,
            }
            turnCapture.captures.push(captured)
            return captured
          }

          const db = this.app.database
          const bindingPrefix = 'shared:' + bot.platform + ':' + bot.selfId + ':' + fakeChannelId + ':preset:'
          const bindings = await db.get('chatluna_binding', {})
          const scopedBinding =
            (Array.isArray(bindings) ? bindings : []).find((row) => typeof row.bindingKey === 'string' && row.bindingKey.startsWith(bindingPrefix)) ||
            null
          const activeConversation =
            scopedBinding && typeof scopedBinding.activeConversationId === 'string'
              ? ((await db.get('chatluna_conversation', { id: scopedBinding.activeConversationId }))[0] || null)
              : null
          const configuredRoomModel =
            activeConversation && typeof activeConversation.model === 'string'
              ? activeConversation.model.trim()
              : ''
          if (configuredRoomModel && !canonicalModels.has(configuredRoomModel)) {
            throw new Error('probe room references a non-canonical model: ' + configuredRoomModel)
          }
          const resolvedProbeRoomModel = shouldUseIsolatedRoom
            ? mainModel
            : configuredRoomModel || mainModel
          const resolvedModelSource = shouldUseIsolatedRoom || !configuredRoomModel ? 'main.chat' : 'room'
          const resolvedModelProfile =
            (Array.isArray(modelSnapshot.models) ? modelSnapshot.models : []).find(
              (model) => 'qqbot-' + model.connectionId + '/' + model.id === resolvedProbeRoomModel
            ) || null
          if (!resolvedModelProfile) {
            throw new Error('probe model is missing from canonical model-config: ' + resolvedProbeRoomModel)
          }

          if (shouldUseIsolatedRoom) {
            const presetLane =
              scopedBinding && typeof scopedBinding.bindingKey === 'string'
                ? scopedBinding.bindingKey.slice(bindingPrefix.length).trim()
                : ''
            const preset =
              probePresetId ||
              (activeConversation && typeof activeConversation.preset === 'string' && activeConversation.preset.trim()) ||
              presetLane ||
              'saki'
            const bindingKey = bindingPrefix + preset
            isolatedPreviousBinding = ((await db.get('chatluna_binding', { bindingKey }))[0] || null)
            const sameBindingConversations = await db.get('chatluna_conversation', { bindingKey })
            const seq = (Array.isArray(sameBindingConversations) ? sameBindingConversations : [])
              .reduce((current, row) => Math.max(current, Number(row.seq ?? 0)), 0) + 1
            const now = new Date()
            const conversationId = crypto.randomUUID()
            isolatedRoom = {
              roomId: null,
              roomName: 'probe-' + fakeGroupId + '-' + fakeUserId,
              conversationId,
              bindingKey,
              previousBinding: isolatedPreviousBinding,
              updatedTime: new Date(),
              chatMode: 'plugin',
              preset,
              model: resolvedProbeRoomModel,
            }
            writeOwnershipJournal({
              phase: 'installing',
              bindingKey,
              conversationId,
              previousBinding: isolatedPreviousBinding ? serializePayload(isolatedPreviousBinding) : null,
            })
            await db.create('chatluna_conversation', {
              id: conversationId,
              seq,
              bindingKey,
              title: isolatedRoom.roomName,
              model: resolvedProbeRoomModel,
              preset,
              chatMode: 'plugin',
              createdBy: String(fakeUserId),
              createdAt: now,
              updatedAt: now,
              lastChatAt: now,
              status: 'active',
              latestMessageId: null,
              additional_kwargs: ownershipMarkerJson,
              compression: null,
              archivedAt: null,
              archiveId: null,
              legacyRoomId: null,
              legacyMeta: null,
              autoTitle: false,
            })
            await db.upsert('chatluna_binding', [{
              bindingKey,
              activeConversationId: conversationId,
              lastConversationId:
                isolatedPreviousBinding && isolatedPreviousBinding.activeConversationId && isolatedPreviousBinding.activeConversationId !== conversationId
                  ? isolatedPreviousBinding.activeConversationId
                  : (isolatedPreviousBinding ? isolatedPreviousBinding.lastConversationId ?? null : null),
              updatedAt: now,
            }])
            writeOwnershipJournal({ phase: 'installed' })
          }

          const originalSendMessage = bot.sendMessage
          let ReplyOrchestratorService = null
          let completedProbeResult = null
          try {
            const orchestratorModule = process.mainModule.require(process.cwd() + '/dist/plugins/reply/pipeline/orchestrator.js')
            ReplyOrchestratorService = orchestratorModule && orchestratorModule.ReplyOrchestratorService
          } catch {}
          const originalOrchestratorHandle =
            ReplyOrchestratorService && ReplyOrchestratorService.prototype && typeof ReplyOrchestratorService.prototype.handle === 'function'
              ? ReplyOrchestratorService.prototype.handle
              : null

          if (originalOrchestratorHandle) {
            ReplyOrchestratorService.prototype.handle = async function(turnInput, session, context = {}) {
              const turnCapture = session
                ? turnCapturesByMessageId.get(Number(session.messageId ?? 0)) || null
                : null
              const ownsCapture = Boolean(
                turnCapture &&
                session &&
                String(session.userId ?? '') === String(fakeUserId) &&
                String(session.channelId ?? '') === fakeChannelId
              )
              try {
                const result = await originalOrchestratorHandle.call(this, turnInput, session, context)
                if (ownsCapture) {
                  turnCapture.orchestrations.push({
                    at: Date.now(),
                    ordinal: ++turnCapture.eventOrdinal,
                    turnInput: serializePayload(turnInput),
                    routeHint: context && typeof context === 'object' ? context.routeHint ?? null : null,
                    responseMessage: serializePayload(context && typeof context === 'object' ? context.responseMessage ?? null : null),
                    result: serializePayload(result),
                  })
                }
                return result
              } catch (error) {
                if (ownsCapture) {
                  turnCapture.orchestrations.push({
                    at: Date.now(),
                    ordinal: ++turnCapture.eventOrdinal,
                    turnInput: serializePayload(turnInput),
                    routeHint: context && typeof context === 'object' ? context.routeHint ?? null : null,
                    responseMessage: serializePayload(context && typeof context === 'object' ? context.responseMessage ?? null : null),
                    result: {
                      status: 'error',
                      error: String((error && error.message) || error),
                    },
                  })
                }
                throw error
              }
            }
          }

          bot.sendMessage = async function(channelId, content, guildId, options) {
            const turnCapture = resolveProbeTurnCapture(channelId, options)
            if (turnCapture) {
              const captured = capture(turnCapture, 'sendMessage', content, { guildId: guildId ?? null })
              const receipt = ['debug-' + turnCapture.captures.length]
              captured.receipt = serializePayload(receipt)
              captured.delivered = true
              return receipt
            }
            return originalSendMessage.call(this, channelId, content, guildId, options)
          }

          try {
            const turnResults = []
            const messageIdBase = Date.now()
            for (const requestedTurn of requestedTurns) {
              const probeMessageId = messageIdBase + requestedTurn.index
              activeTurnCapture = {
                messageId: probeMessageId,
                eventOrdinal: 0,
                captures: [],
                orchestrations: [],
              }
              turnCapturesByMessageId.set(probeMessageId, activeTurnCapture)
              const baseMessageEvent = {
                post_type: 'message',
                self_id: Number(bot.selfId),
                user_id: fakeUserId,
                message_id: probeMessageId,
                time: Math.floor(probeMessageId / 1000),
                message: requestedTurn.input,
                raw_message: requestedTurn.input,
                font: 0,
              }
              await dispatchSession(bot, {
                ...baseMessageEvent,
                message_type: 'group',
                sub_type: 'normal',
                group_id: fakeGroupId,
                group_name: fakeGroupName,
                anonymous: null,
                message_seq: probeMessageId,
                sender: {
                  user_id: fakeUserId,
                  nickname: 'codex-probe',
                  card: fakeGroupCard,
                  sex: 'unknown',
                  age: 0,
                  area: '',
                  level: '0',
                  role: 'member',
                  title: '',
                },
              })

              const deadline = Date.now() + timeoutSeconds * 1000
              const terminalStableWindowMs = 2500
              let terminalState = evaluateTurnTerminal(
                activeTurnCapture.orchestrations,
                activeTurnCapture.captures,
              )
              while (Date.now() < deadline) {
                await sleep(500)
                terminalState = evaluateTurnTerminal(
                  activeTurnCapture.orchestrations,
                  activeTurnCapture.captures,
                )
                if (!terminalState.terminal) continue
                const lastActivityAt = Math.max(
                  terminalState.at ?? 0,
                  ...activeTurnCapture.captures.map((capture) => Number(capture.at) || 0),
                  ...activeTurnCapture.orchestrations.map((orchestration) => Number(orchestration.at) || 0),
                )
                if (Date.now() - lastActivityAt >= terminalStableWindowMs) {
                  break
                }
              }

              const captures = activeTurnCapture.captures
              const orchestrations = activeTurnCapture.orchestrations
              const visibleMessages = captures.map((item) => item.visibleText).filter((value) => value.length > 0)
              const payloadCaptures = captures.map((item) => ({
                route: item.route,
                channelId: item.channelId,
                guildId: item.guildId ?? null,
                payload: item.payload,
                visibleText: item.visibleText,
                at: item.at,
                ordinal: item.ordinal,
                delivered: item.delivered === true,
                receipt: item.receipt,
              }))
              const turnResult = {
                ok: true,
                turnIndex: requestedTurn.index,
                caseId: requestedTurn.id,
                category: requestedTurn.category,
                input: requestedTurn.input,
                originalInput: requestedTurn.originalInput,
                dispatchedInput: requestedTurn.input,
                captureCount: captures.length,
                orchestrationCount: orchestrations.length,
                orchestrations,
                visibleMessages,
                payloadCaptures,
                combined: visibleMessages.join('\\n'),
                terminalStatus: terminalState.status,
                timeout: !terminalState.terminal,
              }
              turnResult.firstErrorSignature = detectFirstErrorSignature(turnResult)
              turnResults.push(turnResult)
              if (turnResult.timeout || turnResult.firstErrorSignature) break
              await sleep(50)
            }

            const effectiveProbeConversation =
              isolatedRoom
                ? ((await this.app.database.get('chatluna_conversation', { id: isolatedRoom.conversationId }))[0] || null)
                : activeConversation
            const effectivePreset =
              effectiveProbeConversation && typeof effectiveProbeConversation.preset === 'string'
                ? effectiveProbeConversation.preset.trim() || null
                : isolatedRoom && typeof isolatedRoom.preset === 'string'
                  ? isolatedRoom.preset.trim() || null
                  : null
            const probeRoom = {
              resolvedModel: resolvedProbeRoomModel,
              modelSource: resolvedModelSource,
              mainModel,
              connectionId: resolvedModelProfile.connectionId,
              modelId: resolvedModelProfile.id,
              transportModel: resolvedModelProfile.transportModel ?? null,
              requestDefaults: resolvedModelProfile.requestDefaults ?? null,
              reasoningEffort:
                resolvedModelProfile.requestDefaults && typeof resolvedModelProfile.requestDefaults.reasoningEffort === 'string'
                  ? resolvedModelProfile.requestDefaults.reasoningEffort
                  : null,
              modelConfigRevision: modelSnapshot.revision,
              isolated: shouldUseIsolatedRoom,
              roomId: isolatedRoom ? isolatedRoom.roomId : null,
              roomName: isolatedRoom ? isolatedRoom.roomName : null,
              effectivePreset,
              effectiveModel:
                effectiveProbeConversation && typeof effectiveProbeConversation.model === 'string'
                  ? effectiveProbeConversation.model
                  : null,
            }
            const commonResult = {
              fakeChannelId,
              bot: {
                sid: bot.sid,
                selfId: bot.selfId,
                platform: bot.platform,
              },
              targetGroupId: fakeChannelId,
              probeRoom,
              warnings: cleanupWarnings,
            }
            if (!sequence) {
              completedProbeResult = {
                ...turnResults[0],
                ...commonResult,
                mode: 'group',
              }
            } else {
              const result = {
                ok: true,
                sequenceId,
                mode: 'group-sequence',
                ...commonResult,
                requestedTurnCount: requestedTurns.length,
                completedTurnCount: turnResults.length,
                captureCount: turnResults.reduce((total, turn) => total + turn.captureCount, 0),
                orchestrationCount: turnResults.reduce((total, turn) => total + turn.orchestrationCount, 0),
                turns: turnResults,
                timeout: turnResults.some((turn) => turn.timeout),
              }
              result.firstErrorSignature =
                turnResults.find((turn) => turn.firstErrorSignature)?.firstErrorSignature ||
                (result.timeout ? 'ProbeTurnTimeout' : null)
              completedProbeResult = result
            }
          } finally {
            activeTurnCapture = null
            if (originalOrchestratorHandle) {
              ReplyOrchestratorService.prototype.handle = originalOrchestratorHandle
            }
            bot.sendMessage = originalSendMessage
            if (isolatedRoom) {
              try {
                const db = this.app.database
                const ownedConversation = ((await db.get('chatluna_conversation', { id: isolatedRoom.conversationId }))[0] || null)
                if (
                  ownedConversation &&
                  ownedConversation.additional_kwargs !== ownershipMarkerJson
                ) {
                  throw new Error('isolated conversation ownership marker changed before cleanup')
                }
                const currentBinding = ((await db.get('chatluna_binding', { bindingKey: isolatedRoom.bindingKey }))[0] || null)
                if (currentBinding && currentBinding.activeConversationId === isolatedRoom.conversationId) {
                  if (isolatedPreviousBinding) {
                    await db.upsert('chatluna_binding', [isolatedPreviousBinding])
                  } else {
                    await db.remove('chatluna_binding', { bindingKey: isolatedRoom.bindingKey })
                  }
                } else {
                  const bindingAlreadyRestored = isolatedPreviousBinding
                    ? Boolean(
                        currentBinding &&
                        currentBinding.activeConversationId === isolatedPreviousBinding.activeConversationId &&
                        currentBinding.lastConversationId === isolatedPreviousBinding.lastConversationId
                      )
                    : currentBinding == null
                  if (!bindingAlreadyRestored) {
                    throw new Error('isolated binding ownership changed before cleanup')
                  }
                }
                await db.remove('chatluna_message', { conversationId: isolatedRoom.conversationId })
                await db.remove('chatluna_conversation', {
                  id: isolatedRoom.conversationId,
                  bindingKey: isolatedRoom.bindingKey,
                  createdBy: String(fakeUserId),
                  additional_kwargs: ownershipMarkerJson,
                })
                writeOwnershipJournal({ phase: 'runtime-restored' })
              } catch (error) {
                cleanupWarnings.push('isolated room cleanup failed: ' + String((error && error.message) || error))
              }
            }
          }
          if (cleanupWarnings.length > 0) {
            throw new Error(cleanupWarnings.join('; '))
          }
          if (!completedProbeResult) {
            throw new Error('probe completed without a result')
          }
          return JSON.stringify(completedProbeResult)
        } catch (error) {
          const result = {
            ok: false,
            error: String((error && error.stack) || error),
          }
          result.firstErrorSignature = 'probe_execution_failed'
          return JSON.stringify(result)
        }
      }`,
      arguments: [
        { value: prompt },
        { value: originalPrompt },
        { value: sequence },
        { value: fakeUserId },
        { value: fakeGroupId },
        { value: fakeGroupName },
        { value: fakeGroupCard },
        { value: probeIsolatedRoom },
        { value: probePresetId },
        { value: timeoutSeconds },
        { value: ownershipToken },
        { value: ownershipJournal },
      ],
      awaitPromise: true,
      returnByValue: true,
    })

    const raw = call.result.value
    if (typeof raw !== 'string') {
      throw new Error('unexpected probe result shape')
    }

    process.stdout.write(raw + '\n')

    if (openedInspector && !keepInspector) {
      try {
        await send('Runtime.evaluate', {
          expression: "process.mainModule.require('inspector').close()",
        })
      } catch {}
    }
  } finally {
    ws.close()
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: String((error && error.stack) || error) }))
  process.exit(1)
})
NODE
)"

printf '%s\n' "$probe_json"
probe_status="$(
  printf '%s' "$probe_json" | PROBE_ASSERT_FAILURES="$probe_assert_failures" node -e "let data='';process.stdin.on('data',c=>data+=c);process.stdin.on('end',()=>{const parsed=JSON.parse(data);const firstErrorSignature=typeof parsed.firstErrorSignature==='string'&&parsed.firstErrorSignature.length>0?parsed.firstErrorSignature:'';const visibleMessages=Array.isArray(parsed.visibleMessages)?parsed.visibleMessages.map(v=>String(v||'')):[];const visibleText=visibleMessages.join('\n');const assertFailures=process.env.PROBE_ASSERT_FAILURES!=='0';const hasFatalVisibleError=/ChatLunaError:?303|错误码为 303|is not a chat model/i.test(visibleText);const shouldFail=parsed.ok===false||parsed.timeout===true||(assertFailures&&(firstErrorSignature.length>0||hasFatalVisibleError));process.stdout.write(shouldFail?'fail':'pass');});"
)"
if [[ "$probe_status" == "fail" ]]; then
  exit 1
fi
exit 0

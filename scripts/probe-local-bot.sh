#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  probe-local-bot.sh <prompt>
  printf '%s' '<prompt>' | probe-local-bot.sh

Description:
  Inject a synthetic QQ group message into the locally running Koishi bot,
  capture only the real outbound reply for that group, and print a JSON result.
  This probe is group-only and must not be used to infer private-chat behavior.
  The script temporarily opens Node inspector on 127.0.0.1:9229 when needed
  and closes it after the probe by default.
  For workflow and result interpretation, use $qqbot-group-probe at
  /home/kkkzbh/code/qqbot/.codex/skills/qqbot-group-probe/SKILL.md

Environment:
  FAKE_USER_ID          Fake QQ user id (default: derived from timestamp)
  FAKE_GROUP_ID         Optional override for the probe group id (default: 829573670)
  FAKE_GROUP_NAME       Optional synthetic group name (default: codex-probe-group)
  FAKE_GROUP_CARD       Optional synthetic sender group card (default: codex-probe)
  PROBE_ISOLATED_ROOM   Set to 1 to create a temporary isolated room for this
                       probe and delete it afterwards.
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
require_cmd mkdir

prompt=""
if [[ "$#" -gt 0 ]]; then
  prompt="$*"
elif [[ ! -t 0 ]]; then
  prompt="$(cat)"
fi

if [[ -z "$prompt" ]]; then
  echo "[error] Missing prompt." >&2
  usage >&2
  exit 2
fi

timeout_seconds="${BOT_TIMEOUT_SECONDS:-40}"
keep_inspector="${KEEP_INSPECTOR:-0}"
probe_isolated_room="${PROBE_ISOLATED_ROOM:-0}"
probe_trigger_prefix="${PROBE_TRIGGER_PREFIX:-saki }"
probe_assert_failures="${PROBE_ASSERT_FAILURES:-1}"
ensure_positive_int "BOT_TIMEOUT_SECONDS" "$timeout_seconds"

if [[ -n "${PROBE_TAB:-}" || -n "${PROBE_ROOM_MODEL:-}" ]]; then
  echo "[error] PROBE_TAB and PROBE_ROOM_MODEL are no longer supported. Configure the canonical main.chat or room model instead." >&2
  exit 2
fi

if [[ "$probe_isolated_room" != "0" && "$probe_isolated_room" != "1" ]]; then
  echo "[error] PROBE_ISOLATED_ROOM must be 0 or 1." >&2
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
default_group_name="$(
  node -e "const shared=require('./scripts/lib/probe-local-bot-shared.cjs'); process.stdout.write(shared.DEFAULT_PROBE_GROUP_NAME)"
)"
default_group_card="$(
  node -e "const shared=require('./scripts/lib/probe-local-bot-shared.cjs'); process.stdout.write(shared.DEFAULT_PROBE_GROUP_CARD)"
)"
probe_lock_dir="$(
  node -e "const shared=require('./scripts/lib/probe-local-bot-shared.cjs'); process.stdout.write(shared.PROBE_LOCK_DIR)"
)"

if [[ -z "${FAKE_USER_ID:-}" ]]; then
  fake_user_id="9$(date +%s%N | cut -c1-9)"
else
  fake_user_id="$FAKE_USER_ID"
fi
fake_group_id="${FAKE_GROUP_ID:-$default_group_id}"
fake_group_name="${FAKE_GROUP_NAME:-$default_group_name}"
fake_group_card="${FAKE_GROUP_CARD:-$default_group_card}"

if ! [[ "$fake_user_id" =~ ^[0-9]+$ ]]; then
  echo "[error] FAKE_USER_ID must be numeric." >&2
  exit 2
fi

if ! [[ "$fake_group_id" =~ ^[0-9]+$ ]]; then
  echo "[error] FAKE_GROUP_ID must be numeric." >&2
  exit 2
fi

if [[ -n "${QQBOT_PREPARE_DEBUG_CHAT_MODE:-}" ]]; then
  echo "[error] QQBOT_PREPARE_DEBUG_CHAT_MODE is no longer supported. probe-local-bot.sh is group-only." >&2
  exit 2
fi

original_prompt="$prompt"

if ! printf '%s' "$prompt" | rg -qi '(^|[[:space:][:punct:]])(saki|祥)([[:space:][:punct:]]|$)'; then
  prompt="${probe_trigger_prefix}${prompt}"
fi

if [[ -d "$probe_lock_dir" ]]; then
  stale_pid="$(cat "$probe_lock_dir/pid" 2>/dev/null || true)"
  if [[ -n "$stale_pid" ]] && ! kill -0 "$stale_pid" >/dev/null 2>&1; then
    rm -rf "$probe_lock_dir"
  fi
fi

if ! mkdir "$probe_lock_dir" 2>/dev/null; then
  echo "[error] Another group probe is already running. Wait for it to finish before starting a new one." >&2
  exit 1
fi

cleanup_probe_lock() {
  rm -rf "$probe_lock_dir" >/dev/null 2>&1 || true
}

cleanup_non_default_probe_state() {
  if [[ "$fake_group_id" == "$default_group_id" ]]; then
    return
  fi
  bash "$repo_root/scripts/cleanup-probe-chat-state.sh" "$fake_user_id" "$fake_group_id" >/dev/null 2>&1 || true
}

cleanup_on_exit() {
  cleanup_non_default_probe_state
  cleanup_probe_lock
}

trap cleanup_on_exit EXIT
printf '%s\n' "$$" > "$probe_lock_dir/pid"

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

probe_json="$(
  QQBOT_TEST_PROMPT_B64="$prompt_b64" \
  QQBOT_ORIGINAL_PROMPT_B64="$(printf '%s' "$original_prompt" | base64 | tr -d '\n')" \
  QQBOT_FAKE_USER_ID="$fake_user_id" \
  QQBOT_FAKE_GROUP_ID="$fake_group_id" \
  QQBOT_FAKE_GROUP_NAME="$fake_group_name" \
  QQBOT_FAKE_GROUP_CARD="$fake_group_card" \
  QQBOT_PROBE_ISOLATED_ROOM="$probe_isolated_room" \
  QQBOT_TIMEOUT_SECONDS="$timeout_seconds" \
  QQBOT_KEEP_INSPECTOR="$keep_inspector" \
  QQBOT_OPENED_INSPECTOR="$opened_inspector" \
  node <<'NODE'
const path = require('path')
const http = require('http')
const {
  normalizeVisibleContent,
  serializePayload,
} = require(path.join(process.cwd(), 'scripts/lib/probe-local-bot-shared.cjs'))
const normalizeVisibleContentSource = normalizeVisibleContent.toString()
const serializePayloadSource = serializePayload.toString()

const prompt = Buffer.from(process.env.QQBOT_TEST_PROMPT_B64 || '', 'base64').toString('utf8')
const originalPrompt = Buffer.from(process.env.QQBOT_ORIGINAL_PROMPT_B64 || '', 'base64').toString('utf8')
const fakeUserId = Number(process.env.QQBOT_FAKE_USER_ID || '0')
const fakeGroupId = Number(process.env.QQBOT_FAKE_GROUP_ID || '0')
const fakeGroupName = String(process.env.QQBOT_FAKE_GROUP_NAME || 'codex-probe-group')
const fakeGroupCard = String(process.env.QQBOT_FAKE_GROUP_CARD || 'codex-probe')
const probeIsolatedRoom = process.env.QQBOT_PROBE_ISOLATED_ROOM === '1'
const timeoutSeconds = Number(process.env.QQBOT_TIMEOUT_SECONDS || '40')
const keepInspector = process.env.QQBOT_KEEP_INSPECTOR === '1'
const openedInspector = process.env.QQBOT_OPENED_INSPECTOR === '1'

if (!prompt) {
  console.error('[error] Empty prompt after base64 decode.')
  process.exit(2)
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
      functionDeclaration: `async function(input, originalInput, fakeUserId, fakeGroupId, fakeGroupName, fakeGroupCard, probeIsolatedRoom, timeoutSeconds) {
        try {
          const normalizeVisibleContent = ${normalizeVisibleContentSource}
          const serializePayload = ${serializePayloadSource}
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

          const rawBots = this.app && this.app.bots
          const bots = Array.isArray(rawBots) ? rawBots : Object.values(rawBots || {})
          const bot = bots.find((item) => item.platform === 'onebot')
          if (!bot) {
            return JSON.stringify({ ok: false, error: 'onebot bot not found' })
          }

          const fakeChannelId = String(fakeGroupId)
          const probeMessageId = Date.now()
          const captures = []
          const orchestrationCaptures = []
          const cleanupWarnings = []
          let directGroupCaptureAllowed = false
          let isolatedRoom = null
          let isolatedPreviousBinding = null
          const isProbeSend = (channelId, options) => {
            if (String(channelId) !== fakeChannelId) return false
            const session = options && typeof options === 'object' ? options.session : null
            if (!session || typeof session !== 'object') return false
            if (String(session.channelId ?? '') !== fakeChannelId) return false
            if (String(session.userId ?? '') !== String(fakeUserId)) return false
            return Number(session.messageId ?? 0) === probeMessageId
          }
          const capture = (route, content, extra = {}) => {
            const visibleText = normalizeVisibleContent(content).trim()
            captures.push({
              route,
              channelId: fakeChannelId,
              visibleText,
              payload: serializePayload(content),
              at: Date.now(),
              ...extra,
            })
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
          const resolvedProbeRoomModel = configuredRoomModel || mainModel
          const resolvedModelSource = configuredRoomModel ? 'room' : 'main.chat'
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
              additional_kwargs: null,
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
          }

          const originalSendMessage = bot.sendMessage
          const originalSendPrivateMsg = bot.internal && typeof bot.internal.sendPrivateMsg === 'function'
            ? bot.internal.sendPrivateMsg
            : null
          const originalSendGroupMsg = bot.internal && typeof bot.internal.sendGroupMsg === 'function'
            ? bot.internal.sendGroupMsg
            : null
          const originalRequest = bot.internal && typeof bot.internal._request === 'function'
            ? bot.internal._request
            : null
          let ReplyOrchestratorService = null
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
              const result = await originalOrchestratorHandle.call(this, turnInput, session, context)
              if (
                session &&
                String(session.userId ?? '') === String(fakeUserId) &&
                String(session.channelId ?? '') === fakeChannelId &&
                Number(session.messageId ?? 0) === probeMessageId
              ) {
                orchestrationCaptures.push({
                  at: Date.now(),
                  turnInput: serializePayload(turnInput),
                  routeHint: context && typeof context === 'object' ? context.routeHint ?? null : null,
                  responseMessage: serializePayload(context && typeof context === 'object' ? context.responseMessage ?? null : null),
                  result: serializePayload(result),
                })
              }
              return result
            }
          }

          bot.sendMessage = async function(channelId, content, guildId, options) {
            if (isProbeSend(channelId, options)) {
              capture('sendMessage', content, { guildId: guildId ?? null })
              return ['debug-' + captures.length]
            }
            return originalSendMessage.call(this, channelId, content, guildId, options)
          }

          if (originalSendPrivateMsg) {
            bot.internal.sendPrivateMsg = async function(userId, message, autoEscape) {
              return originalSendPrivateMsg.call(this, userId, message, autoEscape)
            }
          }

          if (originalSendGroupMsg) {
            bot.internal.sendGroupMsg = async function(groupId, message, autoEscape) {
              if (directGroupCaptureAllowed && String(groupId) === fakeChannelId) {
                capture('sendGroupMsg', message, { guildId: fakeChannelId })
                return 'debug-group'
              }
              return originalSendGroupMsg.call(this, groupId, message, autoEscape)
            }
          }

          if (originalRequest) {
            bot.internal._request = async function(action, params) {
              if (
                directGroupCaptureAllowed &&
                action === 'send_group_msg' &&
                params &&
                String(params.group_id) === fakeChannelId
              ) {
                capture('_request:send_group_msg', params.message, { guildId: fakeChannelId })
                return { message_id: 'debug-group-request' }
              }
              return originalRequest.call(this, action, params)
            }
          }

          try {
            const baseMessageEvent = {
              post_type: 'message',
              self_id: Number(bot.selfId),
              user_id: fakeUserId,
              message_id: probeMessageId,
              time: Math.floor(probeMessageId / 1000),
              message: input,
              raw_message: input,
              font: 0,
            }
            directGroupCaptureAllowed = true
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
            let lastCount = captures.length
            let stableSince = Date.now()
            while (Date.now() < deadline) {
              await new Promise((resolve) => setTimeout(resolve, 500))
              if (captures.length !== lastCount) {
                lastCount = captures.length
                stableSince = Date.now()
              } else if (captures.length > 0 && Date.now() - stableSince >= 6000) {
                break
              }
            }

            directGroupCaptureAllowed = false
            const visibleMessages = captures.map((item) => item.visibleText).filter((value) => value.length > 0)
            const payloadCaptures = captures.map((item) => ({
              route: item.route,
              channelId: item.channelId,
              guildId: item.guildId ?? null,
              payload: item.payload,
              visibleText: item.visibleText,
              at: item.at,
            }))
            const effectiveProbeConversation =
              isolatedRoom
                ? ((await this.app.database.get('chatluna_conversation', { id: isolatedRoom.conversationId }))[0] || null)
                : activeConversation
            const result = {
              ok: true,
              input,
              originalInput: originalInput || input,
              dispatchedInput: input,
              fakeChannelId,
              mode: 'group',
              bot: {
                sid: bot.sid,
                selfId: bot.selfId,
                platform: bot.platform,
              },
              targetGroupId: fakeChannelId,
              captureCount: captures.length,
              orchestrationCount: orchestrationCaptures.length,
              orchestrations: orchestrationCaptures,
              visibleMessages,
              payloadCaptures,
              probeRoom: {
                resolvedModel: resolvedProbeRoomModel,
                modelSource: resolvedModelSource,
                mainModel,
                connectionId: resolvedModelProfile.connectionId,
                modelId: resolvedModelProfile.id,
                modelConfigRevision: modelSnapshot.revision,
                isolated: shouldUseIsolatedRoom,
                roomId: isolatedRoom ? isolatedRoom.roomId : null,
                roomName: isolatedRoom ? isolatedRoom.roomName : null,
                effectiveModel:
                  effectiveProbeConversation && typeof effectiveProbeConversation.model === 'string'
                    ? effectiveProbeConversation.model
                    : null,
              },
              warnings: cleanupWarnings,
              combined: visibleMessages.join('\\n'),
              timeout: captures.length === 0,
            }

            result.firstErrorSignature = detectFirstErrorSignature(result)
            return JSON.stringify(result)
          } finally {
            directGroupCaptureAllowed = false
            if (originalOrchestratorHandle) {
              ReplyOrchestratorService.prototype.handle = originalOrchestratorHandle
            }
            bot.sendMessage = originalSendMessage
            if (originalSendPrivateMsg) {
              bot.internal.sendPrivateMsg = originalSendPrivateMsg
            }
            if (originalSendGroupMsg) {
              bot.internal.sendGroupMsg = originalSendGroupMsg
            }
            if (originalRequest) {
              bot.internal._request = originalRequest
            }
            if (isolatedRoom) {
              try {
                const db = this.app.database
                await db.remove('chatluna_message', { conversationId: isolatedRoom.conversationId })
                await db.remove('chatluna_conversation', { id: isolatedRoom.conversationId })
                if (isolatedPreviousBinding) {
                  await db.upsert('chatluna_binding', [isolatedPreviousBinding])
                } else {
                  await db.remove('chatluna_binding', { bindingKey: isolatedRoom.bindingKey })
                }
              } catch (error) {
                cleanupWarnings.push('isolated room cleanup failed: ' + String((error && error.message) || error))
              }
            }
          }
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
        { value: fakeUserId },
        { value: fakeGroupId },
        { value: fakeGroupName },
        { value: fakeGroupCard },
        { value: probeIsolatedRoom },
        { value: timeoutSeconds },
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
  PROBE_ASSERT_FAILURES="$probe_assert_failures" printf '%s' "$probe_json" | node -e "let data='';process.stdin.on('data',c=>data+=c);process.stdin.on('end',()=>{const parsed=JSON.parse(data);const firstErrorSignature=typeof parsed.firstErrorSignature==='string'&&parsed.firstErrorSignature.length>0?parsed.firstErrorSignature:'';const visibleMessages=Array.isArray(parsed.visibleMessages)?parsed.visibleMessages.map(v=>String(v||'')):[];const visibleText=visibleMessages.join('\n');const assertFailures=process.env.PROBE_ASSERT_FAILURES!=='0';const hasFatalVisibleError=/ChatLunaError:?303|错误码为 303|is not a chat model/i.test(visibleText);const shouldFail=parsed.ok===false||parsed.timeout===true||(assertFailures&&(firstErrorSignature.length>0||hasFatalVisibleError));process.stdout.write(shouldFail?'fail':'pass');});"
)"
if [[ "$probe_status" == "fail" ]]; then
  exit 1
fi
exit 0

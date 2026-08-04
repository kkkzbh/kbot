#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  smoke-chat-replies.sh

Runs full QQBot pipeline acceptance cases from chat-reply-probe-cases.json.
Regular cases and stateful sequences use isolated conversations in a safe,
non-production temporary group and clean their persisted state after each run.

Environment:
  PROBE_MODE            cases, stateful, or all (default: all)
  PROBE_CASE_IDS        Optional comma-separated case IDs (default: all)
  PROBE_SEQUENCE_IDS    Optional comma-separated sequence IDs (default: all)
  PROBE_REPETITIONS     Runs per case, from 1 to 50 (default: 1)
  BOT_TIMEOUT_SECONDS   Per-probe timeout (default: 90)
  QQBOT_RUN_VOICE_SMOKE Set to 1 to enable the required voice case
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if (( $# > 0 )); then
  echo "[error] smoke-chat-replies.sh takes no positional arguments; select cases with PROBE_CASE_IDS." >&2
  exit 2
fi

ROOT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROBE_SCRIPT="$ROOT_DIR/scripts/probe-local-bot.sh"
MANIFEST_FILE="$ROOT_DIR/scripts/chat-reply-probe-cases.json"
PROBE_JSON_FILE=""
cd "$ROOT_DIR"

if [[ ! -x "$PROBE_SCRIPT" ]]; then
  echo "[error] Missing probe script: $PROBE_SCRIPT" >&2
  exit 1
fi

if [[ ! -f "$MANIFEST_FILE" ]]; then
  echo "[error] Missing probe case manifest: $MANIFEST_FILE" >&2
  exit 1
fi

if [[ -z "${FAKE_USER_ID:-}" ]]; then
  FAKE_USER_ID="$(node -e "const s=require('./scripts/lib/probe-local-bot-shared.cjs');const {randomInt}=require('crypto');process.stdout.write(s.TEMP_PROBE_USER_PREFIX+String(randomInt(0,1e9)).padStart(9,'0'))")"
fi
BOT_TIMEOUT_SECONDS="${BOT_TIMEOUT_SECONDS:-90}"
PROBE_REPETITIONS="${PROBE_REPETITIONS:-1}"
PROBE_MODE="${PROBE_MODE:-all}"
FAKE_GROUP_ID="${FAKE_GROUP_ID:-$(node -e "process.stdout.write(require('./scripts/lib/probe-local-bot-shared.cjs').DEFAULT_PROBE_GROUP_ID)")}"

case "$PROBE_MODE" in
  cases | stateful | all) ;;
  *)
    echo "[error] PROBE_MODE must be cases, stateful, or all." >&2
    exit 2
    ;;
esac

if ! FAKE_GROUP_ID="$FAKE_GROUP_ID" FAKE_USER_ID="$FAKE_USER_ID" node -e "const s=require('./scripts/lib/probe-local-bot-shared.cjs');if(!s.isOwnedTemporaryProbeGroupId(process.env.FAKE_GROUP_ID)||!s.isOwnedTemporaryProbeUserId(process.env.FAKE_USER_ID))process.exit(1)"; then
  echo "[error] Full smoke probes require controlled temporary FAKE_GROUP_ID/FAKE_USER_ID namespaces; the live acceptance group is rejected." >&2
  exit 2
fi

if ! [[ "$PROBE_REPETITIONS" =~ ^[0-9]+$ ]] || (( 10#$PROBE_REPETITIONS < 1 || 10#$PROBE_REPETITIONS > 50 )); then
  echo "[error] PROBE_REPETITIONS must be an integer from 1 to 50." >&2
  exit 2
fi
PROBE_REPETITIONS=$((10#$PROBE_REPETITIONS))

cleanup_probe_result() {
  if [[ -n "$PROBE_JSON_FILE" && -f "$PROBE_JSON_FILE" ]]; then
    rm -f "$PROBE_JSON_FILE"
    PROBE_JSON_FILE=""
  fi
}

trap cleanup_probe_result EXIT

CASE_ROWS="$(
  MANIFEST_FILE="$MANIFEST_FILE" PROBE_CASE_IDS="${PROBE_CASE_IDS:-}" node <<'NODE'
const { loadProbeManifest, selectProbeCases } = require('./scripts/lib/chat-reply-probe-corpus.cjs')
const manifest = loadProbeManifest(process.env.MANIFEST_FILE)
const cases = selectProbeCases(manifest, process.env.PROBE_CASE_IDS)
for (const probeCase of cases) {
  const encode = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64')
  process.stdout.write([
    probeCase.id,
    Buffer.from(manifest.presetId, 'utf8').toString('base64'),
    Buffer.from(probeCase.prompt, 'utf8').toString('base64'),
    encode(probeCase.dimensions),
    encode(probeCase.expect),
    Buffer.from(manifest.expectedModelId, 'utf8').toString('base64'),
    Buffer.from(manifest.expectedTransportModel, 'utf8').toString('base64'),
    manifest.expectedReasoningEffort,
    probeCase.gate || '',
  ].join('\t') + '\n')
}
NODE
)"

SEQUENCE_ROWS="$(
  MANIFEST_FILE="$MANIFEST_FILE" PROBE_SEQUENCE_IDS="${PROBE_SEQUENCE_IDS:-}" node <<'NODE'
const { loadProbeManifest, selectProbeSequences } = require('./scripts/lib/chat-reply-probe-corpus.cjs')
const manifest = loadProbeManifest(process.env.MANIFEST_FILE)
const sequences = selectProbeSequences(manifest, process.env.PROBE_SEQUENCE_IDS)
for (const sequence of sequences) {
  const encode = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64')
  process.stdout.write([
    sequence.id,
    Buffer.from(manifest.presetId, 'utf8').toString('base64'),
    Buffer.from(manifest.expectedModelId, 'utf8').toString('base64'),
    Buffer.from(manifest.expectedTransportModel, 'utf8').toString('base64'),
    manifest.expectedReasoningEffort,
    encode(sequence),
  ].join('\t') + '\n')
}
NODE
)"

run_case() {
  local case_id="$1"
  local repetition="$2"
  local preset_id="$3"
  local prompt="$4"
  local dimensions_json="$5"
  local expectations_json="$6"
  local expected_model_id="$7"
  local expected_transport_model="$8"
  local expected_reasoning_effort="$9"

  echo "=== CASE: $case_id [$repetition/$PROBE_REPETITIONS] ==="
  echo "INPUT: $prompt"

  PROBE_JSON_FILE="$(mktemp)"
  (
    FAKE_USER_ID="$FAKE_USER_ID" \
    FAKE_GROUP_ID="$FAKE_GROUP_ID" \
    BOT_TIMEOUT_SECONDS="$BOT_TIMEOUT_SECONDS" \
    PROBE_ISOLATED_ROOM=1 \
    PROBE_PRESET_ID="$preset_id" \
    bash "$PROBE_SCRIPT" "$prompt"
  ) >"$PROBE_JSON_FILE"

  PROBE_JSON_FILE="$PROBE_JSON_FILE" \
  CASE_ID="$case_id" \
  CASE_REPETITION="$repetition" \
  CASE_PRESET_ID="$preset_id" \
  CASE_PROMPT="$prompt" \
  CASE_DIMENSIONS="$dimensions_json" \
  CASE_EXPECTATIONS="$expectations_json" \
  EXPECTED_MODEL_ID="$expected_model_id" \
  EXPECTED_TRANSPORT_MODEL="$expected_transport_model" \
  EXPECTED_REASONING_EFFORT="$expected_reasoning_effort" \
  node <<'NODE'
const fs = require('fs')
const {
  classifyDeliveredTypedMedia,
  evaluateVisualDeliveryExpectation,
  isCaptureAfterOrchestration,
  isSuccessfulDeliveryCapture,
  latestTerminalOrchestration,
} = require('./scripts/lib/probe-local-bot-shared.cjs')

const caseId = process.env.CASE_ID
const repetition = Number(process.env.CASE_REPETITION)
const presetId = process.env.CASE_PRESET_ID
const prompt = process.env.CASE_PROMPT
const dimensions = JSON.parse(process.env.CASE_DIMENSIONS)
const expect = JSON.parse(process.env.CASE_EXPECTATIONS)
const expectedModelId = process.env.EXPECTED_MODEL_ID
const expectedTransportModel = process.env.EXPECTED_TRANSPORT_MODEL
const expectedReasoningEffort = process.env.EXPECTED_REASONING_EFFORT
const parsed = JSON.parse(fs.readFileSync(process.env.PROBE_JSON_FILE, 'utf8'))

if (parsed.ok !== true) throw new Error(`${caseId}: probe returned ok=false: ${parsed.error || 'unknown error'}`)
if (parsed.timeout === true) throw new Error(`${caseId}: probe timed out`)
if (!Array.isArray(parsed.visibleMessages)) throw new Error(`${caseId}: visibleMessages is missing`)
if (!Array.isArray(parsed.payloadCaptures)) throw new Error(`${caseId}: payloadCaptures is missing`)
if (!Array.isArray(parsed.orchestrations)) throw new Error(`${caseId}: orchestrations is missing`)
if (parsed.originalInput !== prompt || parsed.dispatchedInput !== prompt) {
  throw new Error(`${caseId}: direct and full-pipeline prompts differ`)
}
if (!parsed.probeRoom || typeof parsed.probeRoom !== 'object' || parsed.probeRoom.isolated !== true) {
  throw new Error(`${caseId}: probe did not use an isolated room`)
}

const visibleMessages = parsed.visibleMessages.map((value) => String(value ?? '').trim()).filter(Boolean)
const payloadCaptures = parsed.payloadCaptures
const orchestrations = parsed.orchestrations
const terminalOrchestration = latestTerminalOrchestration(orchestrations)
if (!terminalOrchestration || parsed.terminalStatus !== 'delivered') {
  throw new Error(`${caseId}: reply did not reach successful final delivery`)
}
const finalDeliveryCaptures = payloadCaptures.filter(
  (capture) => isCaptureAfterOrchestration(capture, terminalOrchestration),
)
const finalVisibleMessages = finalDeliveryCaptures
  .map((capture) => String(capture.visibleText ?? '').trim())
  .filter(Boolean)
const visibleText = finalVisibleMessages
  .join('\n')
  .replaceAll('（语音）', '')
  .replaceAll('（图片）', '')
  .replaceAll('（表情包）', '')
  .replace(/<(?:audio|voice|record|img|image|sticker)\b[^>]*>/giu, '')
  .trim()

const deliveredMedia = classifyDeliveredTypedMedia(orchestrations, payloadCaptures)
const hasVoice = deliveredMedia.voice
const hasImage = deliveredMedia.sticker
const hasText = visibleText.length > 0
const warnings = []

function assertMedia(name, mode, present) {
  if (mode === 'required' && !present) throw new Error(`${caseId}: expected ${name}`)
  if (mode === 'discouraged' && present) warnings.push(`unexpected ${name}`)
}

assertMedia('text', expect.text, hasText)
assertMedia('voice', expect.voice, hasVoice)
const visualExpectation = evaluateVisualDeliveryExpectation(expect.image, deliveredMedia)
if (!visualExpectation.ok) {
  if (expect.image === 'required') {
    throw new Error(`${caseId}: visual delivery expectation failed (${visualExpectation.reason})`)
  }
  warnings.push(`visual delivery differed from preference (${visualExpectation.reason})`)
}

if (expect.requireOrchestration && orchestrations.length === 0) {
  throw new Error(`${caseId}: reply never reached the orchestrator`)
}
if (expect.requireProgress) {
  const readyOrchestration = orchestrations.find(
    (item) => item?.result?.status === 'ready' && Number.isFinite(item?.at),
  )
  const progressBeforeFinal = readyOrchestration && payloadCaptures.some(
    (capture) => isSuccessfulDeliveryCapture(capture)
      && Number.isInteger(readyOrchestration.ordinal)
      && capture.ordinal < readyOrchestration.ordinal,
  )
  const finalAfterReady = readyOrchestration && payloadCaptures.some(
    (capture) => isCaptureAfterOrchestration(capture, readyOrchestration),
  )
  if (!progressBeforeFinal || !finalAfterReady) {
    throw new Error(`${caseId}: expected a real progress send before ready orchestration and a final send after it`)
  }
}
if (Number.isInteger(expect.maxVisibleTextChars) && visibleText.length > expect.maxVisibleTextChars) {
  warnings.push(`visible text length ${visibleText.length} exceeds ${expect.maxVisibleTextChars}`)
}
if (Number.isInteger(expect.maxVisibleMessages) && finalVisibleMessages.length > expect.maxVisibleMessages) {
  warnings.push(`visible message count ${finalVisibleMessages.length} exceeds ${expect.maxVisibleMessages}`)
}

if (expect.forbidSpeakerLabels) {
  const speakerLabel = /(^|\n)\s*(?:sakiko|saki|祥子|assistant|user|群友|用户|助手)\s*[：:]/iu
  if (speakerLabel.test(visibleText)) warnings.push('speaker label appeared in visible text')
}

if (expect.forbidMeta) {
  const { findInternalMetadataLeak } = require('./scripts/lib/probe-visible-output.cjs')
  const leaked = findInternalMetadataLeak(visibleText)
  if (leaked) throw new Error(`${caseId}: internal metadata leaked (${leaked})`)
}

if (expect.forbidAssistantBoilerplate) {
  const assistantBoilerplate = /作为(?:一个)?AI|希望以上(?:内容|建议)|请问还有什么|很高兴(?:为你|能帮)/u
  if (assistantBoilerplate.test(visibleText)) {
    warnings.push('assistant boilerplate appeared in visible text')
  }
}

const orchestrationStatuses = orchestrations.map((item) => item?.result?.status ?? null)
const probeRoom = parsed.probeRoom && typeof parsed.probeRoom === 'object' ? parsed.probeRoom : {}
const effectiveModel = probeRoom.effectiveModel ?? probeRoom.resolvedModel ?? null
if (
  typeof effectiveModel !== 'string' || !effectiveModel ||
  typeof probeRoom.mainModel !== 'string' || !probeRoom.mainModel ||
  effectiveModel !== probeRoom.mainModel ||
  probeRoom.modelSource !== 'main.chat' ||
  probeRoom.modelId !== expectedModelId ||
  probeRoom.transportModel !== expectedTransportModel ||
  probeRoom.reasoningEffort !== expectedReasoningEffort ||
  probeRoom.effectivePreset !== presetId ||
  !probeRoom.requestDefaults || typeof probeRoom.requestDefaults !== 'object' ||
  typeof probeRoom.reasoningEffort !== 'string' || !probeRoom.reasoningEffort ||
  (typeof probeRoom.modelConfigRevision !== 'string' && typeof probeRoom.modelConfigRevision !== 'number')
) {
  throw new Error(`${caseId}: model, preset, or revision metadata is incomplete`)
}
const result = {
  type: 'full_pipeline_probe_result',
  caseId,
  repetition,
  status: 'passed',
  verdict: warnings.length > 0 ? 'passed_with_warnings' : 'passed',
  warnings,
  originalInput: prompt,
  dimensions,
  effectiveModel,
  mainModel: probeRoom.mainModel ?? null,
  mainBinding: probeRoom.mainModel ?? null,
  connectionId: probeRoom.connectionId ?? null,
  modelId: probeRoom.modelId ?? null,
  transportModel: probeRoom.transportModel ?? null,
  requestDefaults: probeRoom.requestDefaults ?? null,
  reasoningEffort: probeRoom.reasoningEffort ?? null,
  effectivePreset: probeRoom.effectivePreset ?? null,
  modelConfigRevision: probeRoom.modelConfigRevision ?? null,
  isolated: probeRoom.isolated === true,
  visibleMessageCount: finalVisibleMessages.length,
  payloadCaptureCount: payloadCaptures.length,
  orchestrationStatuses,
  media: { text: hasText, voice: hasVoice, sticker: hasImage, toolImage: deliveredMedia.image },
  visibleTextChars: visibleText.length,
}

console.log(`VISIBLE: ${visibleMessages.join(' | ') || '[empty]'}`)
for (const warning of warnings) console.log(`WARNING: ${warning}`)
console.log(`PROBE_RESULT_JSON: ${JSON.stringify(result)}`)
NODE

  rm -f "$PROBE_JSON_FILE"
  PROBE_JSON_FILE=""
  echo "RESULT: PASS"
  echo
}

run_sequence() {
  local sequence_id="$1"
  local repetition="$2"
  local preset_id="$3"
  local expected_model_id="$4"
  local expected_transport_model="$5"
  local expected_reasoning_effort="$6"
  local sequence_json="$7"

  echo "=== SEQUENCE: $sequence_id [$repetition/$PROBE_REPETITIONS] ==="
  echo "TURNS: $(SEQUENCE_JSON="$sequence_json" node -e "const value=JSON.parse(process.env.SEQUENCE_JSON); process.stdout.write(String(value.turns.length))")"

  PROBE_JSON_FILE="$(mktemp)"
  (
    printf '%s' "$sequence_json" | \
      FAKE_USER_ID="$FAKE_USER_ID" \
      FAKE_GROUP_ID="$FAKE_GROUP_ID" \
      BOT_TIMEOUT_SECONDS="$BOT_TIMEOUT_SECONDS" \
      PROBE_PRESET_ID="$preset_id" \
      bash "$PROBE_SCRIPT" --sequence
  ) >"$PROBE_JSON_FILE"

  PROBE_JSON_FILE="$PROBE_JSON_FILE" \
  SEQUENCE_ID="$sequence_id" \
  SEQUENCE_REPETITION="$repetition" \
  SEQUENCE_PRESET_ID="$preset_id" \
  SEQUENCE_JSON="$sequence_json" \
  EXPECTED_MODEL_ID="$expected_model_id" \
  EXPECTED_TRANSPORT_MODEL="$expected_transport_model" \
  EXPECTED_REASONING_EFFORT="$expected_reasoning_effort" \
  node <<'NODE'
const fs = require('fs')
const { evaluateStatefulStickerRates } = require('./scripts/lib/chat-reply-probe-corpus.cjs')
const {
  classifyDeliveredTypedMedia,
  isCaptureAfterOrchestration,
  isSuccessfulDeliveryCapture,
  latestTerminalOrchestration,
  payloadHasKind,
} = require('./scripts/lib/probe-local-bot-shared.cjs')

const sequenceId = process.env.SEQUENCE_ID
const repetition = Number(process.env.SEQUENCE_REPETITION)
const presetId = process.env.SEQUENCE_PRESET_ID
const expected = JSON.parse(process.env.SEQUENCE_JSON)
const expectedModelId = process.env.EXPECTED_MODEL_ID
const expectedTransportModel = process.env.EXPECTED_TRANSPORT_MODEL
const expectedReasoningEffort = process.env.EXPECTED_REASONING_EFFORT
const parsed = JSON.parse(fs.readFileSync(process.env.PROBE_JSON_FILE, 'utf8'))

if (parsed.ok !== true) throw new Error(`${sequenceId}: probe returned ok=false: ${parsed.error || 'unknown error'}`)
if (parsed.mode !== 'group-sequence' || parsed.sequenceId !== sequenceId) {
  throw new Error(`${sequenceId}: sequence identity or mode does not match`)
}
if (parsed.timeout === true || parsed.firstErrorSignature) {
  throw new Error(`${sequenceId}: sequence failed: ${parsed.firstErrorSignature || 'timeout'}`)
}
if (!Array.isArray(parsed.turns)) throw new Error(`${sequenceId}: turns are missing`)
if (
  parsed.requestedTurnCount !== expected.turns.length ||
  parsed.completedTurnCount !== expected.turns.length ||
  parsed.turns.length !== expected.turns.length
) {
  throw new Error(`${sequenceId}: sequence did not complete every requested turn`)
}

const probeRoom = parsed.probeRoom && typeof parsed.probeRoom === 'object' ? parsed.probeRoom : {}
if (
  probeRoom.isolated !== true ||
  probeRoom.modelSource !== 'main.chat' ||
  probeRoom.effectiveModel !== probeRoom.mainModel ||
  probeRoom.modelId !== expectedModelId ||
  probeRoom.transportModel !== expectedTransportModel ||
  probeRoom.reasoningEffort !== expectedReasoningEffort ||
  probeRoom.effectivePreset !== presetId ||
  !probeRoom.requestDefaults ||
  typeof probeRoom.requestDefaults !== 'object' ||
  (typeof probeRoom.modelConfigRevision !== 'string' && typeof probeRoom.modelConfigRevision !== 'number')
) {
  throw new Error(`${sequenceId}: model, transport, reasoning, preset, or revision metadata does not match the acceptance lane`)
}

const categoryStats = new Map()
const turnSummaries = []
const sequenceWarnings = []
for (let index = 0; index < expected.turns.length; index += 1) {
  const expectedTurn = expected.turns[index]
  const turn = parsed.turns[index]
  if (
    !turn ||
    turn.turnIndex !== index ||
    turn.caseId !== expectedTurn.id ||
    turn.category !== expectedTurn.category ||
    turn.originalInput !== expectedTurn.prompt ||
    turn.dispatchedInput !== expectedTurn.prompt
  ) {
    throw new Error(`${sequenceId}: turn ${index + 1} identity, category, or input differs from the corpus`)
  }
  if (turn.timeout === true || turn.firstErrorSignature) {
    throw new Error(`${sequenceId}/${expectedTurn.id}: ${turn.firstErrorSignature || 'timeout'}`)
  }
  if (!Array.isArray(turn.orchestrations) || turn.orchestrations.length === 0) {
    throw new Error(`${sequenceId}/${expectedTurn.id}: reply never reached the orchestrator`)
  }
  if (!Array.isArray(turn.payloadCaptures) || !Array.isArray(turn.visibleMessages)) {
    throw new Error(`${sequenceId}/${expectedTurn.id}: outbound captures are missing`)
  }
  const terminalOrchestration = latestTerminalOrchestration(turn.orchestrations)
  if (!terminalOrchestration || turn.terminalStatus !== 'delivered') {
    throw new Error(`${sequenceId}/${expectedTurn.id}: reply did not reach successful final delivery`)
  }
  const finalVisibleText = turn.payloadCaptures
    .filter((capture) => isCaptureAfterOrchestration(capture, terminalOrchestration))
    .map((capture) => String(capture.visibleText ?? '').trim())
    .filter(Boolean)
    .join('\n')
  if (expectedTurn.mustInclude && !finalVisibleText.includes(expectedTurn.mustInclude)) {
    throw new Error(
      `${sequenceId}/${expectedTurn.id}: final reply did not preserve required conversation context`,
    )
  }
  const actions = Array.isArray(terminalOrchestration.result?.actions)
    ? terminalOrchestration.result.actions
    : []
  const typedStickerCount = actions.filter((action) => action?.kind === 'sticker').length
  const deliveredMedia = classifyDeliveredTypedMedia(turn.orchestrations, turn.payloadCaptures)
  if (deliveredMedia.ambiguous) {
    throw new Error(
      `${sequenceId}/${expectedTurn.id}: delivered image cannot be attributed to both sticker and image actions`,
    )
  }
  const deliveredStickerPayloadCount = typedStickerCount > 0
    ? turn.payloadCaptures.filter(
        (capture) => isSuccessfulDeliveryCapture(capture)
          && isCaptureAfterOrchestration(capture, terminalOrchestration)
          && payloadHasKind(capture.payload, 'image'),
      ).length
    : 0
  if (typedStickerCount > 0 && !deliveredMedia.sticker) {
    throw new Error(`${sequenceId}/${expectedTurn.id}: typed sticker action had no successful sticker delivery`)
  }
  if (expectedTurn.category === 'explicit_sticker' && !deliveredMedia.sticker) {
    throw new Error(`${sequenceId}/${expectedTurn.id}: explicit sticker request was not delivered`)
  }
  const stickerCount = deliveredMedia.sticker
    ? Math.max(typedStickerCount, deliveredStickerPayloadCount)
    : 0
  if (stickerCount > expected.thresholds.maxStickersPerTurn) {
    sequenceWarnings.push(
      `${sequenceId}/${expectedTurn.id}: ${stickerCount} stickers exceeds ${expected.thresholds.maxStickersPerTurn}`,
    )
  }
  const stats = categoryStats.get(expectedTurn.category) || { turns: 0, stickerTurns: 0 }
  stats.turns += 1
  if (stickerCount > 0) stats.stickerTurns += 1
  categoryStats.set(expectedTurn.category, stats)
  turnSummaries.push({
    id: expectedTurn.id,
    category: expectedTurn.category,
    stickerCount,
    visibleMessageCount: turn.visibleMessages.length,
  })
}

function rate(category) {
  const stats = categoryStats.get(category)
  if (!stats || stats.turns === 0) throw new Error(`${sequenceId}: category ${category} is absent`)
  return stats.stickerTurns / stats.turns
}

const rates = {
  casual: rate('casual_opportunity'),
  serious: rate('serious_negative'),
  informational: rate('informational_negative'),
  explicit: rate('explicit_sticker'),
}
const thresholds = expected.thresholds
const evaluation = evaluateStatefulStickerRates(rates, thresholds)
const warnings = [...sequenceWarnings, ...evaluation.warnings]

const counts = Object.fromEntries(
  [...categoryStats].map(([category, stats]) => [category, stats]),
)
const result = {
  type: 'full_pipeline_stateful_probe_result',
  sequenceId,
  repetition,
  status: 'passed',
  verdict: warnings.length > 0 ? 'passed_with_warnings' : 'passed',
  warnings,
  turnCount: parsed.turns.length,
  effectiveModel: probeRoom.effectiveModel,
  mainModel: probeRoom.mainModel,
  connectionId: probeRoom.connectionId ?? null,
  modelId: probeRoom.modelId,
  transportModel: probeRoom.transportModel,
  reasoningEffort: probeRoom.reasoningEffort,
  requestDefaults: probeRoom.requestDefaults,
  effectivePreset: probeRoom.effectivePreset,
  modelConfigRevision: probeRoom.modelConfigRevision,
  probeGroupId: parsed.targetGroupId,
  isolated: true,
  rates,
  counts,
  turnSummaries,
}
console.log(`RATES: casual=${rates.casual.toFixed(3)} explicit=${rates.explicit.toFixed(3)} serious=${rates.serious.toFixed(3)} informational=${rates.informational.toFixed(3)}`)
for (const warning of warnings) console.log(`WARNING: ${warning}`)
console.log(`PROBE_RESULT_JSON: ${JSON.stringify(result)}`)
NODE

  rm -f "$PROBE_JSON_FILE"
  PROBE_JSON_FILE=""
  echo "RESULT: PASS"
  echo
}

if [[ "$PROBE_MODE" == "cases" || "$PROBE_MODE" == "all" ]]; then
  while IFS=$'\t' read -r case_id preset_b64 prompt_b64 dimensions_b64 expectations_b64 expected_model_b64 expected_transport_b64 expected_reasoning gate; do
    [[ -n "$case_id" ]] || continue

    preset_id="$(printf '%s' "$preset_b64" | base64 --decode)"
    prompt="$(printf '%s' "$prompt_b64" | base64 --decode)"
    dimensions_json="$(printf '%s' "$dimensions_b64" | base64 --decode)"
    expectations_json="$(printf '%s' "$expectations_b64" | base64 --decode)"
    expected_model_id="$(printf '%s' "$expected_model_b64" | base64 --decode)"
    expected_transport_model="$(printf '%s' "$expected_transport_b64" | base64 --decode)"
    for (( repetition = 1; repetition <= PROBE_REPETITIONS; repetition += 1 )); do
      if [[ "$gate" == "voice_output" && "${QQBOT_RUN_VOICE_SMOKE:-0}" != "1" && "${QQ_VOICE_OUTPUT_ENABLED:-}" != "true" ]]; then
        echo "[error] $case_id requires voice output; set QQBOT_RUN_VOICE_SMOKE=1 or exclude the case explicitly." >&2
        exit 2
      fi
      run_case \
        "$case_id" \
        "$repetition" \
        "$preset_id" \
        "$prompt" \
        "$dimensions_json" \
        "$expectations_json" \
        "$expected_model_id" \
        "$expected_transport_model" \
        "$expected_reasoning"
    done
  done <<<"$CASE_ROWS"
fi

if [[ "$PROBE_MODE" == "stateful" || "$PROBE_MODE" == "all" ]]; then
  while IFS=$'\t' read -r sequence_id preset_b64 expected_model_b64 expected_transport_b64 expected_reasoning sequence_b64; do
    [[ -n "$sequence_id" ]] || continue

    preset_id="$(printf '%s' "$preset_b64" | base64 --decode)"
    expected_model_id="$(printf '%s' "$expected_model_b64" | base64 --decode)"
    expected_transport_model="$(printf '%s' "$expected_transport_b64" | base64 --decode)"
    sequence_json="$(printf '%s' "$sequence_b64" | base64 --decode)"
    for (( repetition = 1; repetition <= PROBE_REPETITIONS; repetition += 1 )); do
      run_sequence \
        "$sequence_id" \
        "$repetition" \
        "$preset_id" \
        "$expected_model_id" \
        "$expected_transport_model" \
        "$expected_reasoning" \
        "$sequence_json"
    done
  done <<<"$SEQUENCE_ROWS"
fi

echo "All selected chat reply probes passed."

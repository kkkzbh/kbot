const LIVE_ACCEPTANCE_GROUP_ID = '829573670'
const TEMP_PROBE_GROUP_PREFIX = '880000'
const TEMP_PROBE_USER_PREFIX = '890000'
const DEFAULT_PROBE_GROUP_ID = `${TEMP_PROBE_GROUP_PREFIX}000000001`
const DEFAULT_PROBE_GROUP_NAME = 'codex-probe-group'
const DEFAULT_PROBE_GROUP_CARD = 'codex-probe'
const PROBE_LOCK_FILE = '.tmp/probe-runtime/group-probe.lock'

function isOwnedTemporaryProbeGroupId(value) {
  return new RegExp(`^${TEMP_PROBE_GROUP_PREFIX}\\d{9}$`).test(String(value ?? ''))
}

function isOwnedTemporaryProbeUserId(value) {
  return new RegExp(`^${TEMP_PROBE_USER_PREFIX}\\d{9}$`).test(String(value ?? ''))
}

function resolveOwnedProbeTurnCapture({
  channelId,
  fakeChannelId,
  fakeUserId,
  options,
  activeTurnCapture,
  turnCapturesByMessageId,
}) {
  if (String(channelId) !== String(fakeChannelId)) return null

  const session = options && typeof options === 'object' ? options.session : null
  if (session == null) return activeTurnCapture || null
  if (typeof session !== 'object') return null
  if (String(session.channelId ?? '') !== String(fakeChannelId)) return null
  if (String(session.userId ?? '') !== String(fakeUserId)) return null

  return turnCapturesByMessageId.get(Number(session.messageId ?? 0)) || null
}

function normalizeVisibleContent(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(normalizeVisibleContent).join('')
  if (!content || typeof content !== 'object') return String(content ?? '')

  const node = content
  const type = typeof node.type === 'string' ? node.type : ''
  const attrs = node.attrs && typeof node.attrs === 'object' ? node.attrs : {}
  const data = node.data && typeof node.data === 'object' ? node.data : {}
  const merged = { ...data, ...attrs }
  const ownText =
    typeof merged.content === 'string'
      ? merged.content
      : typeof node.content === 'string'
        ? node.content
        : ''
  const childText = Array.isArray(node.children) ? node.children.map(normalizeVisibleContent).join('') : ''

  if (type === 'text') return ownText
  if (type === 'at') {
    const rawId = merged.id ?? merged.qq ?? merged.userId ?? merged.uid
    const userId = typeof rawId === 'string' || typeof rawId === 'number' ? String(rawId).trim() : ''
    return userId ? `@${userId}` : '@'
  }
  if (type === 'image' || type === 'img') return '（图片）'
  if (type === 'audio' || type === 'record' || type === 'voice') return '（语音）'
  if (type === 'face' || type === 'sticker') return '（表情包）'
  if (type === 'quote') return ''

  if (ownText || childText) return `${ownText}${childText}`
  return type ? `（${type}）` : ''
}

function serializePayload(content) {
  if (content == null) return content
  if (typeof content === 'string' || typeof content === 'number' || typeof content === 'boolean') {
    return content
  }
  if (Array.isArray(content)) return content.map(serializePayload)
  if (typeof content === 'object') {
    return JSON.parse(
      JSON.stringify(content, (_key, value) => {
        if (typeof value === 'function') return undefined
        if (typeof value === 'bigint') return String(value)
        return value
      }),
    )
  }
  return String(content)
}

function payloadHasKind(value, target, allowMarkup = true) {
  if (value == null) return false
  if (Array.isArray(value)) return value.some((item) => payloadHasKind(item, target, true))
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (allowMarkup && target === 'voice' && /^(?:<quote\b[^>]*>\s*)?<(?:audio|voice|record)\b/i.test(trimmed)) return true
    if (allowMarkup && target === 'image' && /^(?:<quote\b[^>]*>\s*)?<(?:img|image|sticker)\b/i.test(trimmed)) return true
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        return payloadHasKind(JSON.parse(trimmed), target, false)
      } catch {}
    }
    return false
  }
  if (typeof value !== 'object') return false
  const type = String(value.type ?? value.kind ?? '').toLowerCase()
  if (target === 'voice' && ['audio', 'voice', 'record'].includes(type)) return true
  if (target === 'image' && ['image', 'img', 'sticker', 'face'].includes(type)) return true
  return Array.isArray(value.children) && value.children.some((item) => payloadHasKind(item, target, true))
}

function latestTerminalOrchestration(orchestrations) {
  if (!Array.isArray(orchestrations)) return null
  for (let index = orchestrations.length - 1; index >= 0; index -= 1) {
    const item = orchestrations[index]
    const status = item && item.result && item.result.status
    if (status === 'ready' || status === 'no_reply' || status === 'error') return item
  }
  return null
}

function isSuccessfulDeliveryCapture(capture) {
  return Boolean(
    capture
    && capture.delivered === true
    && capture.receipt != null
    && Number.isFinite(capture.at)
    && Number.isInteger(capture.ordinal),
  )
}

function isCaptureAfterOrchestration(capture, orchestration) {
  return Boolean(
    isSuccessfulDeliveryCapture(capture)
    && orchestration
    && Number.isInteger(orchestration.ordinal)
    && capture.ordinal > orchestration.ordinal,
  )
}

function evaluateTurnTerminal(orchestrations, captures, deliveryCompletions) {
  const terminal = latestTerminalOrchestration(orchestrations)
  if (!terminal || !Number.isFinite(terminal.at) || !Number.isInteger(terminal.ordinal)) {
    return { terminal: false, status: null, at: null }
  }
  if (terminal.result.status === 'no_reply') {
    return { terminal: true, status: 'no_reply', at: terminal.at }
  }
  if (terminal.result.status === 'error') {
    return { terminal: true, status: 'error', at: terminal.at }
  }
  const actions = Array.isArray(terminal.result.actions) ? terminal.result.actions : []
  if (actions.length === 1 && actions[0] && actions[0].kind === 'no_reply') {
    return { terminal: true, status: 'no_reply', at: terminal.at }
  }
  const completion = Array.isArray(deliveryCompletions)
    ? [...deliveryCompletions].reverse().find((item) => (
        item
        && Number.isInteger(item.ordinal)
        && item.ordinal > terminal.ordinal
      ))
    : null
  if (!completion) {
    return { terminal: false, status: 'awaiting_delivery', at: terminal.at }
  }
  if (completion.completed !== true) {
    return { terminal: true, status: 'incomplete_delivery', at: terminal.at }
  }
  const expectedDeliveryCount = Number(completion.plannedUnitCount)
  if (!Number.isSafeInteger(expectedDeliveryCount) || expectedDeliveryCount < 1) {
    return { terminal: false, status: 'awaiting_delivery', at: terminal.at }
  }
  const deliveredCaptureCount = Array.isArray(captures)
    ? captures.filter((capture) => isCaptureAfterOrchestration(capture, terminal)).length
    : 0
  const delivered = deliveredCaptureCount >= expectedDeliveryCount
  return { terminal: delivered, status: delivered ? 'delivered' : 'awaiting_delivery', at: terminal.at }
}

function classifyDeliveredTypedMedia(orchestrations, captures) {
  const terminal = latestTerminalOrchestration(orchestrations)
  if (
    !terminal
    || terminal.result.status !== 'ready'
    || !Number.isFinite(terminal.at)
    || !Number.isInteger(terminal.ordinal)
  ) {
    return { voice: false, sticker: false, image: false, ambiguous: false }
  }
  const actions = Array.isArray(terminal.result.actions) ? terminal.result.actions : []
  const stickerActionCount = actions.filter((action) => action && action.kind === 'sticker').length
  const imageActionCount = actions.filter((action) => action && action.kind === 'image').length
  const voiceActionCount = actions.filter((action) => action && action.kind === 'voice').length
  const deliveredCaptures = Array.isArray(captures)
    ? captures.filter((capture) => isCaptureAfterOrchestration(capture, terminal))
    : []
  const deliveredVoice = deliveredCaptures.some((capture) => payloadHasKind(capture.payload, 'voice'))
  const deliveredImage = deliveredCaptures.some((capture) => payloadHasKind(capture.payload, 'image'))
  const imageActionAmbiguous = stickerActionCount > 0 && imageActionCount > 0
  return {
    voice: voiceActionCount > 0 && deliveredVoice,
    sticker: !imageActionAmbiguous && stickerActionCount > 0 && deliveredImage,
    image: !imageActionAmbiguous && imageActionCount > 0 && deliveredImage,
    ambiguous: imageActionAmbiguous,
  }
}

function evaluateVisualDeliveryExpectation(mode, deliveredMedia) {
  if (!['allowed', 'forbidden', 'required'].includes(mode)) {
    throw new Error(`invalid visual delivery expectation: ${String(mode)}`)
  }
  if (deliveredMedia && deliveredMedia.ambiguous === true) {
    return { ok: false, reason: 'ambiguous_image_attribution' }
  }
  const sticker = Boolean(deliveredMedia && deliveredMedia.sticker)
  const image = Boolean(deliveredMedia && deliveredMedia.image)
  if (mode === 'required') {
    return { ok: sticker, reason: sticker ? null : 'sticker_required' }
  }
  if (mode === 'forbidden' && (sticker || image)) {
    return { ok: false, reason: 'visual_forbidden' }
  }
  return { ok: true, reason: null }
}

module.exports = {
  DEFAULT_PROBE_GROUP_CARD,
  DEFAULT_PROBE_GROUP_ID,
  DEFAULT_PROBE_GROUP_NAME,
  LIVE_ACCEPTANCE_GROUP_ID,
  PROBE_LOCK_FILE,
  TEMP_PROBE_GROUP_PREFIX,
  TEMP_PROBE_USER_PREFIX,
  classifyDeliveredTypedMedia,
  evaluateVisualDeliveryExpectation,
  evaluateTurnTerminal,
  isCaptureAfterOrchestration,
  isOwnedTemporaryProbeGroupId,
  isOwnedTemporaryProbeUserId,
  isSuccessfulDeliveryCapture,
  latestTerminalOrchestration,
  normalizeVisibleContent,
  payloadHasKind,
  resolveOwnedProbeTurnCapture,
  serializePayload,
}

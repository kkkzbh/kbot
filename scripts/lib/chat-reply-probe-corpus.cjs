const fs = require('fs')

const ALLOWED_MEDIA_EXPECTATIONS = new Set(['required', 'allowed', 'forbidden'])
const ALLOWED_GATES = new Set(['voice_output'])
const ALLOWED_REASONING_EFFORTS = new Set(['low', 'medium', 'high'])
const ALLOWED_SEQUENCE_CATEGORIES = new Set([
  'casual_opportunity',
  'explicit_sticker',
  'informational_negative',
  'neutral',
  'serious_negative',
])
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim() !== value || !value) {
    throw new Error(`${label} must be a non-empty trimmed string`)
  }
}

function requireRateThreshold(value, label, expectedField) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  const keys = Object.keys(value)
  if (keys.length !== 1 || keys[0] !== expectedField) {
    throw new Error(`${label} must declare only ${expectedField}`)
  }
  if (typeof value[expectedField] !== 'number' || value[expectedField] < 0 || value[expectedField] > 1) {
    throw new Error(`${label}.${expectedField} must be a rate from 0 to 1`)
  }
}

function loadProbeManifest(filePath) {
  const manifest = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.cases) || manifest.cases.length === 0) {
    throw new Error('probe manifest must use schemaVersion 1 and contain cases')
  }
  if (!SLUG_PATTERN.test(manifest.presetId || '')) {
    throw new Error('probe manifest presetId must be a lowercase slug')
  }
  requireNonEmptyString(manifest.expectedModelId, 'probe manifest expectedModelId')
  requireNonEmptyString(manifest.expectedTransportModel, 'probe manifest expectedTransportModel')
  if (!ALLOWED_REASONING_EFFORTS.has(manifest.expectedReasoningEffort)) {
    throw new Error('probe manifest expectedReasoningEffort must be low, medium, or high')
  }

  const ids = new Set()
  for (const probeCase of manifest.cases) {
    if (!probeCase || typeof probeCase !== 'object') throw new Error('every probe case must be an object')
    if (!SLUG_PATTERN.test(probeCase.id || '')) {
      throw new Error(`invalid probe case id: ${String(probeCase.id)}`)
    }
    if (ids.has(probeCase.id)) throw new Error(`duplicate probe case id: ${probeCase.id}`)
    ids.add(probeCase.id)
    requireNonEmptyString(probeCase.prompt, `${probeCase.id}: prompt`)
    if (!probeCase.prompt.startsWith('saki ')) {
      throw new Error(`${probeCase.id}: prompt must include the real group trigger so direct and full-pipeline inputs match`)
    }
    if (!Array.isArray(probeCase.dimensions) || probeCase.dimensions.length === 0) {
      throw new Error(`${probeCase.id}: dimensions must be a non-empty array`)
    }
    if (probeCase.dimensions.some((value) => typeof value !== 'string' || !value)) {
      throw new Error(`${probeCase.id}: dimensions must contain non-empty strings`)
    }
    if (probeCase.gate !== undefined && !ALLOWED_GATES.has(probeCase.gate)) {
      throw new Error(`${probeCase.id}: unsupported gate ${String(probeCase.gate)}`)
    }
    const expect = probeCase.expect
    if (!expect || typeof expect !== 'object') throw new Error(`${probeCase.id}: expect is required`)
    for (const field of ['text', 'voice', 'image']) {
      if (!ALLOWED_MEDIA_EXPECTATIONS.has(expect[field])) {
        throw new Error(`${probeCase.id}: expect.${field} must be required, allowed, or forbidden`)
      }
    }
    for (const field of ['requireOrchestration', 'requireProgress', 'forbidMeta', 'forbidSpeakerLabels', 'forbidAssistantBoilerplate']) {
      if (expect[field] !== undefined && typeof expect[field] !== 'boolean') {
        throw new Error(`${probeCase.id}: expect.${field} must be boolean`)
      }
    }
    for (const field of ['maxVisibleTextChars', 'maxVisibleMessages']) {
      if (expect[field] !== undefined && (!Number.isInteger(expect[field]) || expect[field] <= 0)) {
        throw new Error(`${probeCase.id}: expect.${field} must be a positive integer`)
      }
    }
    if (expect.requireProgress === true && expect.requireOrchestration !== true) {
      throw new Error(`${probeCase.id}: progress assertions require orchestration captures`)
    }
    if (probeCase.gate === 'voice_output' && expect.voice !== 'required') {
      throw new Error(`${probeCase.id}: voice_output gate requires voice output`)
    }
  }

  if (!Array.isArray(manifest.statefulSequences) || manifest.statefulSequences.length === 0) {
    throw new Error('probe manifest must contain statefulSequences')
  }
  const sequenceIds = new Set()
  for (const probeSequence of manifest.statefulSequences) {
    if (!probeSequence || typeof probeSequence !== 'object' || Array.isArray(probeSequence)) {
      throw new Error('every stateful probe sequence must be an object')
    }
    if (!SLUG_PATTERN.test(probeSequence.id || '')) {
      throw new Error(`invalid stateful probe sequence id: ${String(probeSequence.id)}`)
    }
    if (sequenceIds.has(probeSequence.id)) {
      throw new Error(`duplicate stateful probe sequence id: ${probeSequence.id}`)
    }
    sequenceIds.add(probeSequence.id)
    if (!Array.isArray(probeSequence.turns) || probeSequence.turns.length < 20 || probeSequence.turns.length > 100) {
      throw new Error(`${probeSequence.id}: stateful sequence must contain 20 to 100 turns`)
    }
    const turnIds = new Set()
    const categoryCounts = new Map()
    for (const turn of probeSequence.turns) {
      if (!turn || typeof turn !== 'object' || Array.isArray(turn)) {
        throw new Error(`${probeSequence.id}: sequence turns must be objects`)
      }
      if (!SLUG_PATTERN.test(turn.id || '') || turnIds.has(turn.id)) {
        throw new Error(`${probeSequence.id}: turn ids must be unique lowercase slugs`)
      }
      turnIds.add(turn.id)
      requireNonEmptyString(turn.prompt, `${probeSequence.id}/${turn.id}: prompt`)
      if (!turn.prompt.startsWith('saki ')) {
        throw new Error(`${probeSequence.id}/${turn.id}: prompt must include the real group trigger`)
      }
      if (!ALLOWED_SEQUENCE_CATEGORIES.has(turn.category)) {
        throw new Error(`${probeSequence.id}/${turn.id}: unsupported category ${String(turn.category)}`)
      }
      categoryCounts.set(turn.category, (categoryCounts.get(turn.category) || 0) + 1)
    }
    for (const [category, minimum] of [
      ['casual_opportunity', 4],
      ['explicit_sticker', 2],
      ['informational_negative', 2],
      ['serious_negative', 2],
    ]) {
      if ((categoryCounts.get(category) || 0) < minimum) {
        throw new Error(`${probeSequence.id}: requires at least ${minimum} ${category} turns`)
      }
    }

    const thresholds = probeSequence.thresholds
    if (!thresholds || typeof thresholds !== 'object' || Array.isArray(thresholds)) {
      throw new Error(`${probeSequence.id}: thresholds are required`)
    }
    const casualThreshold = thresholds.casualStickerRate
    if (
      !casualThreshold ||
      typeof casualThreshold !== 'object' ||
      Array.isArray(casualThreshold) ||
      Object.keys(casualThreshold).length !== 2 ||
      typeof casualThreshold.minExclusive !== 'number' ||
      typeof casualThreshold.maxExclusive !== 'number' ||
      casualThreshold.minExclusive < 0 ||
      casualThreshold.maxExclusive > 1 ||
      casualThreshold.minExclusive >= casualThreshold.maxExclusive
    ) {
      throw new Error(`${probeSequence.id}: casualStickerRate requires ordered minExclusive and maxExclusive rates`)
    }
    requireRateThreshold(thresholds.seriousStickerRate, `${probeSequence.id}: seriousStickerRate`, 'equals')
    requireRateThreshold(thresholds.informationalStickerRate, `${probeSequence.id}: informationalStickerRate`, 'equals')
    requireRateThreshold(thresholds.explicitStickerRate, `${probeSequence.id}: explicitStickerRate`, 'equals')
    if (!Number.isInteger(thresholds.maxStickersPerTurn) || thresholds.maxStickersPerTurn < 0) {
      throw new Error(`${probeSequence.id}: maxStickersPerTurn must be a non-negative integer`)
    }
  }

  return manifest
}

function selectProbeCases(manifest, rawCaseIds = '') {
  const selectedIds = String(rawCaseIds)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  if (selectedIds.length === 0) return manifest.cases
  if (new Set(selectedIds).size !== selectedIds.length) {
    throw new Error('PROBE_CASE_IDS cannot contain duplicates')
  }
  const byId = new Map(manifest.cases.map((probeCase) => [probeCase.id, probeCase]))
  const missing = selectedIds.filter((id) => !byId.has(id))
  if (missing.length > 0) throw new Error(`unknown probe case id(s): ${missing.join(', ')}`)
  return selectedIds.map((id) => byId.get(id))
}

function selectProbeSequences(manifest, rawSequenceIds = '') {
  const selectedIds = String(rawSequenceIds)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  if (selectedIds.length === 0) return manifest.statefulSequences
  if (new Set(selectedIds).size !== selectedIds.length) {
    throw new Error('PROBE_SEQUENCE_IDS cannot contain duplicates')
  }
  const byId = new Map(manifest.statefulSequences.map((sequence) => [sequence.id, sequence]))
  const missing = selectedIds.filter((id) => !byId.has(id))
  if (missing.length > 0) throw new Error(`unknown probe sequence id(s): ${missing.join(', ')}`)
  return selectedIds.map((id) => byId.get(id))
}

function evaluateStatefulStickerRates(rates, thresholds) {
  const warnings = []
  const hardFailures = []
  if (
    rates.casual <= thresholds.casualStickerRate.minExclusive ||
    rates.casual >= thresholds.casualStickerRate.maxExclusive
  ) {
    warnings.push(
      `casual sticker rate ${rates.casual} is outside the recommended >${thresholds.casualStickerRate.minExclusive} and <${thresholds.casualStickerRate.maxExclusive} range`,
    )
  }
  if (rates.explicit !== thresholds.explicitStickerRate.equals) {
    warnings.push(
      `explicit sticker rate ${rates.explicit} is below the recommended ${thresholds.explicitStickerRate.equals}`,
    )
  }
  if (rates.serious !== thresholds.seriousStickerRate.equals) {
    hardFailures.push(
      `serious sticker rate ${rates.serious} must equal ${thresholds.seriousStickerRate.equals}`,
    )
  }
  if (rates.informational !== thresholds.informationalStickerRate.equals) {
    hardFailures.push(
      `informational sticker rate ${rates.informational} must equal ${thresholds.informationalStickerRate.equals}`,
    )
  }
  return {
    hardFailures,
    warnings,
    verdict: warnings.length > 0 ? 'passed_with_warnings' : 'passed',
  }
}

module.exports = {
  evaluateStatefulStickerRates,
  loadProbeManifest,
  selectProbeCases,
  selectProbeSequences,
}

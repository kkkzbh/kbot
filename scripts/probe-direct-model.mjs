import http from 'node:http'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const require = createRequire(import.meta.url)
const WebSocket = require('ws')
const { loadProbeManifest, selectProbeCases } = require('./lib/chat-reply-probe-corpus.cjs')

function positiveInteger(name, rawValue, maximum) {
  const value = Number(rawValue)
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${maximum}`)
  }
  return value
}

function getJson(url) {
  return new Promise((resolveRequest, reject) => {
    http.get(url, (response) => {
      let data = ''
      response.on('data', (chunk) => {
        data += chunk
      })
      response.on('end', () => {
        try {
          resolveRequest(JSON.parse(data))
        } catch (error) {
          reject(error)
        }
      })
    }).on('error', reject)
  })
}

const manifestPath = resolve(process.env.PROBE_MANIFEST_FILE || 'scripts/chat-reply-probe-cases.json')
const manifest = loadProbeManifest(manifestPath)
const cases = selectProbeCases(manifest, process.env.PROBE_CASE_IDS)
const repetitions = positiveInteger('PROBE_REPETITIONS', process.env.PROBE_REPETITIONS || '1', 50)
const maxTokens = positiveInteger('PROBE_MAX_TOKENS', process.env.PROBE_MAX_TOKENS || '1024', 4096)
const reasoningEffortOverride = process.env.PROBE_REASONING_EFFORT || ''
if (reasoningEffortOverride && !['low', 'medium', 'high'].includes(reasoningEffortOverride)) {
  throw new Error('PROBE_REASONING_EFFORT must be low, medium, or high')
}
let reasoningEffort = reasoningEffortOverride || null

const targets = await getJson('http://127.0.0.1:9229/json/list')
const target = targets.find((item) => item.webSocketDebuggerUrl)
if (!target) throw new Error('no inspector target found')

const ws = new WebSocket(target.webSocketDebuggerUrl)
const pending = new Map()
let sequence = 0

function send(method, params = {}) {
  return new Promise((resolveRequest, reject) => {
    const id = ++sequence
    pending.set(id, { resolve: resolveRequest, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

ws.on('message', (buffer) => {
  const message = JSON.parse(buffer.toString())
  if (!message.id) return
  const task = pending.get(message.id)
  if (!task) return
  pending.delete(message.id)
  if (message.error) {
    task.reject(new Error(message.error.message || JSON.stringify(message.error)))
    return
  }
  task.resolve(message.result)
})

await new Promise((resolveRequest, reject) => {
  ws.once('open', resolveRequest)
  ws.once('error', reject)
})

let exitCode = 0
try {
  await send('Runtime.enable')
  const prototype = await send('Runtime.evaluate', {
    expression: "(() => { const m = process.mainModule.require('@koishijs/loader'); const C = m.default || m; return C.prototype })()",
  })
  const queried = await send('Runtime.queryObjects', {
    prototypeObjectId: prototype.result.objectId,
  })
  const activeLoader = await send('Runtime.callFunctionOn', {
    objectId: queried.objects.objectId,
    functionDeclaration: `function() {
      return Array.from(this || []).find((loader) =>
        loader && loader.app && loader.app.chatluna && loader.app.modelConfig
      ) || null
    }`,
  })
  const loader = activeLoader.result.objectId
  if (!loader) throw new Error('failed to resolve active Koishi loader')

  const metadataCall = await send('Runtime.callFunctionOn', {
    objectId: loader,
    functionDeclaration: `async function(presetId, reasoningEffortOverride, maxTokens, caseIds, repetitions) {
      const crypto = process.mainModule.require('crypto')
      const chatluna = this.app && this.app.chatluna
      const modelConfig = this.app && this.app.modelConfig
      if (!chatluna || !modelConfig) throw new Error('chatluna/modelConfig unavailable')
      const snapshot = modelConfig.getRedactedRuntimeSnapshot()
      const binding = await chatluna.resolveModelBinding({
        workload: 'main.chat',
        requestId: 'qqbot-direct-probe-metadata',
      })
      if (binding.mode !== 'dedicated' || typeof binding.model !== 'string' || !binding.model) {
        throw new Error('main.chat binding is not a dedicated model')
      }
      const preset = chatluna.preset.getContextPreset(presetId).value
      if (!preset) throw new Error('probe preset unavailable: ' + presetId)
      const systemMessages = preset.messages.map((message) => ({
        role: typeof message._getType === 'function' ? message._getType() : 'unknown',
        content: message.content,
      }))
      const profile = snapshot.models.find(
        (item) => 'qqbot-' + item.connectionId + '/' + item.id === binding.model
      ) || null
      const configuredReasoningEffort =
        profile && profile.requestDefaults && typeof profile.requestDefaults.reasoningEffort === 'string'
          ? profile.requestDefaults.reasoningEffort
          : null
      const reasoningEffort = reasoningEffortOverride || configuredReasoningEffort
      if (!['low', 'medium', 'high'].includes(reasoningEffort)) {
        throw new Error('main.chat has no supported reasoning effort')
      }
      return JSON.stringify({
        type: 'direct_probe_metadata',
        probeScope: 'persona_pre_screen_without_tools_or_transport',
        status: 'ready',
        caseIds,
        repetitions,
        reasoningEffort,
        reasoningEffortOverride: reasoningEffortOverride || null,
        maxTokens,
        effectiveModel: binding.model,
        mainBinding: binding.model,
        effectivePreset: presetId,
        presetRevision: preset.revision ?? null,
        modelConfigRevision: snapshot.revision,
        connectionId: profile ? profile.connectionId : null,
        modelId: profile ? profile.id : null,
        transportModel: profile ? profile.transportModel : null,
        requestMode: profile ? profile.requestMode : null,
        requestDefaults: profile ? profile.requestDefaults : null,
        configuredReasoningEffort,
        systemPromptSha256: crypto.createHash('sha256').update(JSON.stringify(systemMessages)).digest('hex'),
      })
    }`,
    arguments: [
      { value: manifest.presetId },
      { value: reasoningEffortOverride },
      { value: maxTokens },
      { value: cases.map((probeCase) => probeCase.id) },
      { value: repetitions },
    ],
    awaitPromise: true,
    returnByValue: true,
  })
  const metadata = JSON.parse(metadataCall.result.value)
  if (metadata.modelId !== manifest.expectedModelId) {
    throw new Error(
      `direct probe model mismatch: expected ${manifest.expectedModelId}, received ${String(metadata.modelId)}`,
    )
  }
  if (metadata.transportModel !== manifest.expectedTransportModel) {
    throw new Error(
      `direct probe transport model mismatch: expected ${manifest.expectedTransportModel}, received ${String(metadata.transportModel)}`,
    )
  }
  if (!reasoningEffortOverride && metadata.reasoningEffort !== manifest.expectedReasoningEffort) {
    throw new Error(
      `direct probe reasoning mismatch: expected ${manifest.expectedReasoningEffort}, received ${String(metadata.reasoningEffort)}`,
    )
  }
  reasoningEffort = metadata.reasoningEffort
  console.log(JSON.stringify({
    ...metadata,
    expectedModelId: manifest.expectedModelId,
    expectedTransportModel: manifest.expectedTransportModel,
    expectedReasoningEffort: manifest.expectedReasoningEffort,
  }))

  for (const probeCase of cases) {
    for (let repetition = 1; repetition <= repetitions; repetition += 1) {
      const sampleCall = await send('Runtime.callFunctionOn', {
        objectId: loader,
        functionDeclaration: `async function(probeCase, repetition, presetId, reasoningEffort, maxTokens) {
          const contentToText = (content) => {
            if (typeof content === 'string') return content
            if (!Array.isArray(content)) return String(content ?? '')
            return content.map((part) => {
              if (typeof part === 'string') return part
              if (!part || typeof part !== 'object') return ''
              if (typeof part.text === 'string') return part.text
              if (typeof part.content === 'string') return part.content
              return ''
            }).join('')
          }
          const safeError = (error) => ({
            name: error && typeof error.name === 'string' ? error.name : 'Error',
            message: String((error && error.message) || error),
            code: error && (typeof error.code === 'string' || typeof error.code === 'number')
              ? error.code
              : null,
          })
          let effectiveModel = null
          let modelConfigRevision = null
          try {
            const chatluna = this.app && this.app.chatluna
            const modelConfig = this.app && this.app.modelConfig
            if (!chatluna || !modelConfig) throw new Error('chatluna/modelConfig unavailable')
            const snapshot = modelConfig.getRedactedRuntimeSnapshot()
            modelConfigRevision = snapshot.revision
            const binding = await chatluna.resolveModelBinding({
              workload: 'main.chat',
              requestId: 'qqbot-direct-probe-' + probeCase.id + '-' + repetition,
            })
            if (binding.mode !== 'dedicated' || typeof binding.model !== 'string' || !binding.model) {
              throw new Error('main.chat binding is not a dedicated model')
            }
            effectiveModel = binding.model
            const preset = chatluna.preset.getContextPreset(presetId).value
            if (!preset) throw new Error('probe preset unavailable: ' + presetId)
            const modelReference = await chatluna.createChatModel(binding.model)
            const model = modelReference && modelReference.value
            if (!model) throw new Error('main.chat model unavailable')
            const { SystemMessage, HumanMessage } = process.mainModule.require('@langchain/core/messages')
            const messages = preset.messages.map((message) => {
              const role = typeof message._getType === 'function' ? message._getType() : 'unknown'
              if (role !== 'system') throw new Error('direct probe preset messages must be system messages')
              return new SystemMessage({
                content: message.content,
                additional_kwargs: { ...(message.additional_kwargs || {}) },
                response_metadata: { ...(message.response_metadata || {}) },
              })
            })
            messages.push(new HumanMessage(probeCase.prompt))
            const startedAt = Date.now()
            const response = await model.invoke(messages, { reasoningEffort, maxTokens })
            const totalMs = Date.now() - startedAt
            const assistant = contentToText(response.content).trim()
            if (!assistant) throw new Error('direct model probe produced an empty response')
            const speakerLabel = /(^|\n)\s*(?:sakiko|saki|祥子|assistant|user|群友|用户|助手)\s*[：:]/iu.test(assistant)
            const assistantBoilerplate = /作为(?:一个)?AI|希望以上(?:内容|建议)|请问还有什么|很高兴(?:为你|能帮)/u.test(assistant)
            const profile = snapshot.models.find(
              (item) => 'qqbot-' + item.connectionId + '/' + item.id === binding.model
            ) || null
            const maxVisibleTextChars = Number.isInteger(probeCase.expect.maxVisibleTextChars)
              ? probeCase.expect.maxVisibleTextChars
              : null
            const assistantChars = Array.from(assistant).length
            const forbiddenMeta = [
              'ReplyPlan',
              '<qqbot-',
              '系统提示词',
              '内部回复协议',
              'WorkingState',
              'submit_working_state',
              'qqbot_reply_plan_executor',
              'protocol violation',
            ].find((token) => assistant.includes(token))
            const hardFailures = []
            const warnings = []
            if (probeCase.expect.forbidSpeakerLabels && speakerLabel) warnings.push('speaker_label')
            if (probeCase.expect.forbidAssistantBoilerplate && assistantBoilerplate) {
              warnings.push('assistant_boilerplate')
            }
            if (probeCase.expect.forbidMeta && forbiddenMeta) hardFailures.push('internal_metadata')
            if (maxVisibleTextChars !== null && assistantChars > maxVisibleTextChars) {
              warnings.push('visible_text_too_long')
            }
            return JSON.stringify({
              type: 'direct_probe_result',
              status: hardFailures.length === 0 ? 'passed' : 'failed',
              verdict: hardFailures.length > 0
                ? 'failed'
                : warnings.length > 0
                  ? 'passed_with_warnings'
                  : 'passed',
              caseId: probeCase.id,
              repetition,
              originalInput: probeCase.prompt,
              dimensions: probeCase.dimensions,
              effectiveModel,
              mainBinding: binding.model,
              effectivePreset: presetId,
              presetRevision: preset.revision ?? null,
              modelConfigRevision,
              requestDefaults: profile ? profile.requestDefaults : null,
              configuredReasoningEffort:
                profile && profile.requestDefaults && typeof profile.requestDefaults.reasoningEffort === 'string'
                  ? profile.requestDefaults.reasoningEffort
                  : null,
              reasoningEffort,
              maxTokens,
              assistant,
              assistantChars,
              latencyMs: totalMs,
              usage: response.usage_metadata || null,
              signals: {
                speakerLabel,
                assistantBoilerplate,
                withinVisibleTextLimit: maxVisibleTextChars === null
                  ? null
                  : assistantChars <= maxVisibleTextChars,
              },
              hardFailures,
              warnings,
            })
          } catch (error) {
            return JSON.stringify({
              type: 'direct_probe_result',
              status: 'failed',
              caseId: probeCase && probeCase.id,
              repetition,
              originalInput: probeCase && probeCase.prompt,
              dimensions: probeCase && probeCase.dimensions,
              effectiveModel,
              mainBinding: effectiveModel,
              effectivePreset: presetId,
              modelConfigRevision,
              reasoningEffort,
              maxTokens,
              error: safeError(error),
            })
          }
        }`,
        arguments: [
          { value: probeCase },
          { value: repetition },
          { value: manifest.presetId },
          { value: reasoningEffort },
          { value: maxTokens },
        ],
        awaitPromise: true,
        returnByValue: true,
      })
      const sample = JSON.parse(sampleCall.result.value)
      console.log(JSON.stringify(sample))
      if (sample.status !== 'passed') exitCode = 1
    }
  }
} finally {
  if (process.env.QQBOT_DIRECT_OPENED_INSPECTOR === '1') {
    await Promise.race([
      send('Runtime.evaluate', {
        expression: "process.mainModule.require('inspector').close()",
      }).catch(() => undefined),
      new Promise((resolveRequest) => setTimeout(resolveRequest, 500)),
    ])
  }
  ws.close()
}

process.exitCode = exitCode

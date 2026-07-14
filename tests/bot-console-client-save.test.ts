import { beforeEach, describe, expect, it, vi } from 'vitest'

const { sendMock } = vi.hoisted(() => ({
  sendMock: vi.fn(),
}))

vi.mock('@koishijs/client', () => ({
  send: sendMock,
}))

import {
  GENSHIN_ENV_KEYS,
  HBU_JW_ENV_KEYS,
  TTS_LOCAL_ENV_KEYS,
  useBotConsole,
} from '../src/plugins/bot-console/client/composables/useBotConsole.js'

const hbuKey = HBU_JW_ENV_KEYS[0]
const genshinKey = GENSHIN_ENV_KEYS[0]
const ttsLocalKey = TTS_LOCAL_ENV_KEYS[0]

function createTtsState(localEnv: Record<string, string>) {
  return {
    localGateway: { env: localEnv },
    health: {
      status: 'unknown',
      checkedAt: null,
      latencyMs: null,
      error: null,
      targetBaseUrl: '',
      running: null,
      upstreamHost: null,
      upstreamPort: null,
      device: null,
      isHalf: null,
      rawStatus: null,
    },
  }
}

describe('bot console cross-tab settings saves', () => {
  beforeEach(() => {
    sendMock.mockReset()
  })

  it('keeps another tab draft pending after saving the current tab', async () => {
    const bc = useBotConsole()
    bc.originalEnv.value = {
      [hbuKey]: 'saved-hbu',
      [genshinKey]: 'saved-genshin',
    }
    Object.assign(bc.envDraft, bc.originalEnv.value)
    bc.envDraft[hbuKey] = 'next-hbu'
    bc.envDraft[genshinKey] = 'next-genshin'

    sendMock.mockResolvedValueOnce({
      env: {
        [hbuKey]: 'next-hbu',
        [genshinKey]: 'saved-genshin',
      },
    })

    await bc.saveEnvPatch(HBU_JW_ENV_KEYS)

    expect(sendMock).toHaveBeenCalledWith('bot-console/save-env', {
      [hbuKey]: 'next-hbu',
    })
    expect(bc.envDraft[hbuKey]).toBe('next-hbu')
    expect(bc.envDraft[genshinKey]).toBe('next-genshin')
    expect(bc.changedKeys.value).toEqual(new Set([genshinKey]))
  })

  it('saves drafts from multiple tabs before restarting once', async () => {
    const bc = useBotConsole()
    const savedEnv = {
      [hbuKey]: 'saved-hbu',
      [genshinKey]: 'saved-genshin',
    }
    const nextEnv = {
      [hbuKey]: 'next-hbu',
      [genshinKey]: 'next-genshin',
    }
    const nextLocalEnv = { [ttsLocalKey]: '127.0.0.2' }
    const tts = createTtsState(nextLocalEnv)

    bc.originalEnv.value = savedEnv
    Object.assign(bc.envDraft, savedEnv, nextEnv)
    bc.originalTtsEnv.value = { [ttsLocalKey]: '127.0.0.1' }
    Object.assign(bc.ttsEnvDraft, nextLocalEnv)

    sendMock.mockImplementation(async (command: string) => {
      if (command === 'bot-console/save-env') return { env: nextEnv }
      if (command === 'bot-console/save-tts-settings') return { env: nextEnv, tts }
      if (command === 'bot-console/service-action') return { ok: true }
      if (command === 'bot-console/get-tool-policy-state') return null
      if (command === 'bot-console/get-state') {
        return {
          env: nextEnv,
          presets: [],
          featureScopes: [],
          featureOverrides: [],
          conversationTargets: [],
          modelTabs: null,
          toolPolicy: null,
          tts,
        }
      }
      throw new Error(`Unexpected command: ${command}`)
    })

    expect(bc.pendingSettingsCount.value).toBe(3)

    await bc.saveAllSettingsAndRestart()

    expect(sendMock).toHaveBeenCalledWith('bot-console/save-env', nextEnv)
    expect(sendMock).toHaveBeenCalledWith('bot-console/save-tts-settings', {
      botEnv: {},
      localEnv: nextLocalEnv,
    })
    expect(sendMock).toHaveBeenCalledWith(
      'bot-console/service-action',
      'qqbot-koishi.service',
      'restart',
    )
    expect(sendMock.mock.calls.filter(([command]) => command === 'bot-console/service-action')).toHaveLength(1)
    expect(bc.pendingSettingsCount.value).toBe(0)
  })
})

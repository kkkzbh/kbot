import { onMounted, onUnmounted, type Ref } from 'vue'
import {
  BASIC_KEYS,
  FILE_SYSTEM_CONTROL_KEYS,
  HBU_SECOND_CLASS_ENV_KEYS,
  ZYH_ENV_KEYS,
  type useBotConsole,
} from './useBotConsole'
import type { useToast } from './useToast'

export function useKeyboard(
  bc: ReturnType<typeof useBotConsole>,
  toast: ReturnType<typeof useToast>,
  activeTab: Ref<string>,
) {
  async function handler(e: KeyboardEvent) {
    // Only intercept Ctrl+S / Cmd+S
    if (!(e.ctrlKey || e.metaKey) || e.key !== 's') return

    // Let native save work inside textareas (e.g. prompt content editing)
    const target = e.target as HTMLElement
    if (target.tagName === 'TEXTAREA') return

    e.preventDefault()

    try {
      const tab = activeTab.value

      if (tab === 'features') {
        if (!bc.canSaveFeatureSettings.value) return
        await bc.saveFeatureSettings()
        toast.add('配置已保存', 'success')
        return
      }

      if (tab === 'hbu-jw') {
        if (!bc.canSaveHbuJwSettings.value) return
        await bc.saveHbuJwSettings()
        toast.add('配置已保存', 'success')
        return
      }

      if (tab === 'genshin') {
        if (!bc.canSaveGenshinSettings.value) return
        await bc.saveGenshinSettings()
        toast.add('配置已保存', 'success')
        return
      }

      if (tab === 'zyh' || tab === 'hbu-second-class') {
        const keys = tab === 'zyh' ? ZYH_ENV_KEYS : HBU_SECOND_CLASS_ENV_KEYS
        if (!keys.some(key => bc.changedKeys.value.has(key))) return
        await bc.saveEnvPatch(keys)
        toast.add('配置已保存', 'success')
        return
      }

      if (tab === 'models') {
        if (!bc.canSaveModelSettings.value) return
        await bc.saveModelSettings()
        toast.add('配置已保存', 'success')
        return
      }

      if (tab === 'tts') {
        if (!bc.canSaveTtsSettings.value) return
        await bc.saveTtsSettings()
        toast.add('配置已保存', 'success')
        return
      }

      if (tab === 'tools') {
        const hasFileSystemChanges = FILE_SYSTEM_CONTROL_KEYS.some(key => bc.changedKeys.value.has(key))
        if (!hasFileSystemChanges && !bc.canSaveToolPolicyOverrides.value) return
        if (hasFileSystemChanges) await bc.saveEnvPatch(FILE_SYSTEM_CONTROL_KEYS)
        if (bc.canSaveToolPolicyOverrides.value) await bc.saveToolOverrides()
        toast.add('配置已保存', 'success')
        return
      }

      if (tab === 'basic') {
        if (!BASIC_KEYS.some(key => bc.changedKeys.value.has(key))) return
        await bc.saveEnvPatch(BASIC_KEYS)
        toast.add('配置已保存', 'success')
        return
      }

      if (tab === 'presets') {
        if (!bc.canSavePreset.value) return
        await bc.saveCurrentPreset()
        toast.add('预设已保存', 'success')
        return
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      toast.add(message || '保存失败', 'error')
    }
  }

  onMounted(() => window.addEventListener('keydown', handler))
  onUnmounted(() => window.removeEventListener('keydown', handler))
}

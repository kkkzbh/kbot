import { onMounted, onUnmounted, type Ref } from 'vue'
import type { useBotConsole } from './useBotConsole'
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
        await bc.saveFeatureSettings(false)
        toast.add('配置已保存', 'success')
        return
      }

      if (tab === 'hbu-jw') {
        if (!bc.canSaveHbuJwSettings.value) return
        await bc.saveHbuJwSettings(false)
        toast.add('配置已保存', 'success')
        return
      }

      if (tab === 'genshin') {
        if (!bc.canSaveGenshinSettings.value) return
        await bc.saveGenshinSettings(false)
        toast.add('配置已保存', 'success')
        return
      }

      if (tab === 'models' || tab === 'basic') {
        if (!bc.canSaveEnv.value) return
        await bc.saveEnv(false)
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

import { useCallback, useEffect, useState } from 'react'
import type { LibraryHook } from '@shared/plugin'

// Single source of truth for the global reusable hook library. Called once at App top-level and fed to
// both the settings pane (设置 → Hook 库) and the create-workspace wizard (从库选择 / 回存).
export function useHookLibrary() {
  const [hooks, setHooks] = useState<LibraryHook[]>([])

  // Guarded against a partial window.forge (e.g. test harnesses that mock only a subset of the API):
  // absent methods degrade to a no-op empty library rather than crashing App on mount.
  useEffect(() => { void window.forge.listHookLibrary?.().then(setHooks) }, [])

  const save = useCallback(async (hook: LibraryHook) => { const r = await window.forge.saveHookLibrary?.(hook); if (r) setHooks(r) }, [])
  const remove = useCallback(async (id: string) => { const r = await window.forge.deleteHookLibrary?.(id); if (r) setHooks(r) }, [])
  const setAll = useCallback(async (list: LibraryHook[]) => { const r = await window.forge.setHookLibrary?.(list); if (r) setHooks(r) }, [])

  return { hooks, save, remove, setAll }
}

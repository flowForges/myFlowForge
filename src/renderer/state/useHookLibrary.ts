import { useCallback, useEffect, useState } from 'react'
import type { LibraryHook } from '@shared/plugin'

// Single source of truth for the global reusable hook library. Called once at App top-level and fed to
// both the settings pane (设置 → Hook 库) and the create-workspace wizard (从库选择 / 回存).
export function useHookLibrary() {
  const [hooks, setHooks] = useState<LibraryHook[]>([])

  useEffect(() => { void window.forge.listHookLibrary().then(setHooks) }, [])

  const save = useCallback(async (hook: LibraryHook) => { setHooks(await window.forge.saveHookLibrary(hook)) }, [])
  const remove = useCallback(async (id: string) => { setHooks(await window.forge.deleteHookLibrary(id)) }, [])
  const setAll = useCallback(async (list: LibraryHook[]) => { setHooks(await window.forge.setHookLibrary(list)) }, [])

  return { hooks, save, remove, setAll }
}

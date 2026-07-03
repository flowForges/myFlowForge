import { useCallback, useEffect, useRef, useState } from 'react'

export interface TermTab { id: string; title: string; cwd: string; wsCwd: string; exited: boolean; error?: string }
export interface TerminalsApi {
  tabs: TermTab[]; activeId: string | null
  newTab(cwd?: string, wsCwd?: string): Promise<void> | void; closeTab(id: string): void; selectTab(id: string): void
  /** Focus (or create) a terminal rooted at the given workspace dir. Called when the panel opens
   *  so the terminal always reflects the active workspace instead of a stale tab stuck at ~. */
  openForWorkspace(cwd: string | undefined): void
}

let counter = 0
const titleFromCwd = (cwd: string) => cwd.split('/').filter(Boolean).pop() || cwd || 'shell'

export function useTerminals(defaultCwd: () => string | undefined): TerminalsApi {
  const [tabs, setTabs] = useState<TermTab[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const api = useRef(window.forge)

  useEffect(() => {
    const offCwd = api.current.onTermCwd?.(({ termId, cwd }) =>
      setTabs(t => t.map(x => x.id === termId ? { ...x, cwd, title: titleFromCwd(cwd) } : x)))
    const offExit = api.current.onTermExit?.(({ termId }) =>
      setTabs(t => t.map(x => x.id === termId ? { ...x, exited: true } : x)))
    return () => { offCwd?.(); offExit?.() }
  }, [])

  const newTab = useCallback(async (cwd?: string, wsCwd?: string) => {
    if (tabs.length >= 12) return
    const id = `term-${++counter}`
    const start = cwd ?? defaultCwd() ?? ''
    // Tag the tab with the workspace it belongs to so openForWorkspace can dedupe/re-focus it.
    const ws = wsCwd ?? defaultCwd() ?? ''
    const t: TermTab = { id, title: titleFromCwd(start), cwd: start, wsCwd: ws, exited: false }
    setTabs(prev => [...prev, t])
    setActiveId(id)
    const res = await api.current.termCreate?.({ termId: id, cwd: start || undefined, cols: 80, rows: 24 })
    if (res && res.ok === false) {
      setTabs(prev => prev.map(x => x.id === id ? { ...x, exited: true, error: res.error } : x))
    }
  }, [tabs.length, defaultCwd])

  const openForWorkspace = useCallback((cwd: string | undefined) => {
    if (cwd) {
      const existing = tabs.find(t => t.wsCwd === cwd && !t.exited)
      if (existing) { setActiveId(existing.id); return }
      void newTab(cwd, cwd)
      return
    }
    // No active workspace (e.g. home view): keep one default tab, don't spawn duplicates.
    if (tabs.length === 0) void newTab()
  }, [tabs, newTab])

  const closeTab = useCallback((id: string) => {
    api.current.termKill?.(id)
    setTabs(t => {
      const next = t.filter(x => x.id !== id)
      setActiveId(a => a === id ? (next.length ? next[next.length - 1].id : null) : a)
      return next
    })
  }, [])

  const selectTab = useCallback((id: string) => setActiveId(id), [])
  return { tabs, activeId, newTab, closeTab, selectTab, openForWorkspace }
}

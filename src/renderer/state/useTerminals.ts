import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { baseName } from '@shared/pathName'

export interface TermTab {
  id: string; title: string; cwd: string; wsCwd: string; exited: boolean; error?: string
  /** 这个终端开在哪台机器上(`'local'` = 本机)。★shell 长在 host 上,标签页必须跟着它分组。 */
  host: string
}
export interface TerminalsApi {
  /** 当前这台机器上的标签页 */
  tabs: TermTab[]
  /**
   * **所有**机器上的标签页。给渲染 xterm 实例用:切走的那台不能卸载,
   * 否则回滚缓冲(scrollback)整个丢掉 —— 切过去看一眼再切回来,屏幕是空的。
   */
  allTabs: TermTab[]
  activeId: string | null
  newTab(cwd?: string, wsCwd?: string): Promise<void> | void; closeTab(id: string): void; selectTab(id: string): void
  /** Focus (or create) a terminal rooted at the given workspace dir. Called when the panel opens
   *  so the terminal always reflects the active workspace instead of a stale tab stuck at ~. */
  openForWorkspace(cwd: string | undefined): void
}

/** 当前连着哪台、以及「这条连接是第几次 ready」。后者用来识别断线重连 —— 见下面 useEffect。 */
export type TermHost = { key: string; seq: number }

let counter = 0
const titleFromCwd = (cwd: string) => baseName(cwd) || cwd || 'shell'

export function useTerminals(defaultCwd: () => string | undefined, host: TermHost = { key: 'local', seq: 0 }): TerminalsApi {
  const [all, setAll] = useState<TermTab[]>([])
  // active 按 host 分开存:切回去应该还停在你上次看的那个标签,而不是重新挑一个。
  const [activeByHost, setActiveByHost] = useState<Record<string, string | null>>({})
  const api = useRef(window.forge)
  const hostKey = host.key

  const tabs = useMemo(() => all.filter(t => t.host === hostKey), [all, hostKey])
  const activeId = activeByHost[hostKey] ?? null
  const setActiveId = useCallback(
    (fn: string | null | ((prev: string | null) => string | null)) =>
      setActiveByHost(m => ({ ...m, [hostKey]: typeof fn === 'function' ? fn(m[hostKey] ?? null) : fn })),
    [hostKey],
  )

  useEffect(() => {
    const offCwd = api.current.onTermCwd?.(({ termId, cwd }) =>
      setAll(t => t.map(x => x.id === termId ? { ...x, cwd, title: titleFromCwd(cwd) } : x)))
    const offExit = api.current.onTermExit?.(({ termId }) =>
      setAll(t => t.map(x => x.id === termId ? { ...x, exited: true } : x)))
    return () => { offCwd?.(); offExit?.() }
  }, [])

  /**
   * 远程主机上的终端**跟着那条连接一起死**(host 侧在连接关闭时把 pty 收掉,
   * 见 `InvokeCtx.onClose` —— 不收的话服务器上会攒下一堆永不退出的 shell)。
   * 所以这两种情况下,那台机器的标签页必须就地标成「已退出」,不能让它看起来还能用:
   *
   * - **切走**:去别的主机 = 那条连接被拆掉。
   * - **重连**:同一台机器,但 `seq` 变了 = 中间断过一次,pty 已经没了。
   *
   * 本机的不受影响 —— 进程还在,切出去再切回来接着用。
   */
  const seq = host.seq
  const prev = useRef<TermHost>({ key: hostKey, seq })
  useEffect(() => {
    const was = prev.current
    prev.current = { key: hostKey, seq }
    const dead = was.key !== hostKey ? was.key : (was.seq !== seq ? hostKey : null)
    if (!dead || dead === 'local') return
    setAll(t => t.map(x => x.host === dead && !x.exited ? { ...x, exited: true } : x))
  }, [hostKey, seq])

  const newTab = useCallback(async (cwd?: string, wsCwd?: string) => {
    if (tabs.length >= 12) return
    const id = `term-${++counter}`
    const start = cwd ?? defaultCwd() ?? ''
    // Tag the tab with the workspace it belongs to so openForWorkspace can dedupe/re-focus it.
    const ws = wsCwd ?? defaultCwd() ?? ''
    const t: TermTab = { id, title: titleFromCwd(start), cwd: start, wsCwd: ws, exited: false, host: hostKey }
    setAll(prevAll => [...prevAll, t])
    setActiveId(id)
    const res = await api.current.termCreate?.({ termId: id, cwd: start || undefined, cols: 80, rows: 24 })
    if (res && res.ok === false) {
      setAll(prevAll => prevAll.map(x => x.id === id ? { ...x, exited: true, error: res.error } : x))
    }
  }, [tabs.length, defaultCwd, hostKey, setActiveId])

  const openForWorkspace = useCallback((cwd: string | undefined) => {
    if (cwd) {
      const existing = tabs.find(t => t.wsCwd === cwd && !t.exited)
      if (existing) { setActiveId(existing.id); return }
      void newTab(cwd, cwd)
      return
    }
    // No active workspace (e.g. home view): keep one default tab, don't spawn duplicates.
    if (tabs.length === 0) void newTab()
  }, [tabs, newTab, setActiveId])

  const closeTab = useCallback((id: string) => {
    api.current.termKill?.(id)
    setAll(t => {
      const next = t.filter(x => x.id !== id)
      setActiveId(a => a === id ? (next.filter(x => x.host === hostKey).at(-1)?.id ?? null) : a)
      return next
    })
  }, [hostKey, setActiveId])

  const selectTab = useCallback((id: string) => setActiveId(id), [setActiveId])
  return { tabs, allTabs: all, activeId, newTab, closeTab, selectTab, openForWorkspace }
}

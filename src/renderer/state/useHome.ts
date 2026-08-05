import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorkspaceMeta, HomeStats } from '@shared/types'

// 首页工作区排序按 stats 里的「最近对话时间」(lastMessageAt)降序。stats 走 git-status 扫描,启动后要几秒才回来
// (见 homeStats.ts),期间 stats 为空 → 所有工作区 recency 并列 0 → 退回 listWorkspaces 顺序;stats 回来后再
// 按真实时间重排 → 顶部工作区「A 跳成 B」。把上次的 stats 缓存到 localStorage 并作为初始值,首屏就已经是最终顺序,
// 消除这次跳变。缓存只是排序热启动;真实 stats 回来后照常刷新数值。
const STATS_CACHE_KEY = 'forge.homeStats.v1'
function loadCachedStats(): HomeStats {
  try { const raw = localStorage.getItem(STATS_CACHE_KEY); return raw ? (JSON.parse(raw) as HomeStats) : {} } catch { return {} }
}
function cacheStats(s: HomeStats): void {
  try { localStorage.setItem(STATS_CACHE_KEY, JSON.stringify(s)) } catch { /* 配额/禁用:忽略,退回无缓存的旧行为 */ }
}

export interface HomeApi {
  workspaces: WorkspaceMeta[]
  stats: HomeStats
  reload: () => void
  openDir: () => Promise<void>
  setPinned: (path: string, pinned: boolean) => Promise<void>
  setOrder: (order: string[]) => Promise<void>
  archive: (path: string) => Promise<void>
  restore: (path: string) => Promise<void>
  remove: (path: string) => Promise<{ purged: boolean }>
  removeFromList: (path: string) => Promise<void>
  reveal: (path: string) => Promise<{ ok: boolean; error?: string }>
}

export function useHome(): HomeApi {
  const [workspaces, setWorkspaces] = useState<WorkspaceMeta[]>([])
  // 用上次缓存的 stats 作初始值:首屏排序即最终顺序,不会等 stats 回来才「A 跳成 B」。
  const [stats, setStats] = useState<HomeStats>(loadCachedStats)
  const api = useRef(window.forge)

  const reload = useCallback(() => {
    void api.current.listWorkspaces().then(setWorkspaces)
    // Branch / change counts / last-activity per workspace — async (git status per worktree), so it
    // streams in after the cheap workspace list. Failures degrade to no enrichment, never throw.
    // 成功 → 刷新并回写缓存(下次热启动用);失败 → 保留已有(缓存)的 stats,别清空成 {} 触发重排。
    void api.current.homeStats().then(s => { setStats(s); cacheStats(s) }).catch(() => { /* keep seeded/last stats */ })
  }, [])
  useEffect(() => { reload() }, [reload])

  const openDir = useCallback(async () => { setWorkspaces(await api.current.openWorkspaceDir()) }, [])

  const setPinned = useCallback(async (path: string, pinned: boolean) => {
    setWorkspaces(await api.current.setWorkspacePinned(path, pinned))
  }, [])

  // Persist the user's manual drag order for the (non-pinned) workspace list.
  const setOrder = useCallback(async (order: string[]) => {
    setWorkspaces(await api.current.setWorkspaceOrder(order))
  }, [])

  const archive = useCallback(async (path: string) => {
    await api.current.archiveWorkspace(path)
    reload()
  }, [reload])

  const restore = useCallback(async (path: string) => {
    await api.current.restoreWorkspace(path)
    reload()
  }, [reload])

  const remove = useCallback(async (path: string) => {
    const result = await api.current.deleteWorkspace(path)
    reload()
    return result
  }, [reload])

  // 移除:仅从列表移除,保留磁盘文件。
  const removeFromList = useCallback(async (path: string) => {
    setWorkspaces(await api.current.removeWorkspaceFromList(path))
  }, [])

  // 在系统文件管理器中打开该工作区目录(Finder / 资源管理器 / 文件管理器)。
  const reveal = useCallback((path: string) => api.current.revealPath(path), [])

  useEffect(() => {
    if (!api.current.onWorkspacesChanged) return
    const unsubscribe = api.current.onWorkspacesChanged(() => reload())
    return () => { unsubscribe() }
  }, [reload])

  return { workspaces, stats, reload, openDir, setPinned, setOrder, archive, restore, remove, removeFromList, reveal }
}

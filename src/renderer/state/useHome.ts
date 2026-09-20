import { useCallback, useEffect, useRef, useState } from 'react'
import { useHost, useHostReadySeq } from './useHostKey'
import { usePathPicker } from './PathPicker'
import type { WorkspaceMeta, HomeStats } from '@shared/types'

// 首页工作区排序按 stats 里的「最近对话时间」(lastMessageAt)降序。stats 走 git-status 扫描,启动后要几秒才回来
// (见 homeStats.ts),期间 stats 为空 → 所有工作区 recency 并列 0 → 退回 listWorkspaces 顺序;stats 回来后再
// 按真实时间重排 → 顶部工作区「A 跳成 B」。把上次的 stats 缓存到 localStorage 并作为初始值,首屏就已经是最终顺序,
// 消除这次跳变。缓存只是排序热启动;真实 stats 回来后照常刷新数值。
// ★缓存**按主机分键**。工作区路径在两台机器上可以完全一样(自测时甚至就是同一台),
// 共用一份缓存的话切过去那一刻会拿上一台的时间戳给这一台的工作区排序 —— 顺序看着正常,其实是错的。
const STATS_CACHE_KEY = (hostKey: string) => `forge.homeStats.v1.${hostKey}`
function loadCachedStats(hostKey: string): HomeStats {
  try { const raw = localStorage.getItem(STATS_CACHE_KEY(hostKey)); return raw ? (JSON.parse(raw) as HomeStats) : {} } catch { return {} }
}
function cacheStats(hostKey: string, s: HomeStats): void {
  try { localStorage.setItem(STATS_CACHE_KEY(hostKey), JSON.stringify(s)) } catch { /* 配额/禁用:忽略,退回无缓存的旧行为 */ }
}

export interface HomeApi {
  workspaces: WorkspaceMeta[]
  stats: HomeStats
  /** 正在拉这台机器的列表。★空列表 + loading 和空列表 + 拉完了是两件事,界面上必须分得开。 */
  loading: boolean
  /** 拉不到时的原话(远程主机连不上、版本不兼容…)。空串 = 没出错。 */
  error: string
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
  const { key: hostKey } = useHost()
  // 重连成功也要重拉:断线期间那台机器上可能已经多了/少了工作区(设计文档 7.2 第 3 条:以服务端为准)。
  const readySeq = useHostReadySeq()
  const { pick: pickPath } = usePathPicker()
  const [workspaces, setWorkspaces] = useState<WorkspaceMeta[]>([])
  // 用上次缓存的 stats 作初始值:首屏排序即最终顺序,不会等 stats 回来才「A 跳成 B」。
  const [stats, setStats] = useState<HomeStats>(() => loadCachedStats('local'))
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const api = useRef(window.forge)
  // ★迟到的响应必须丢掉:切主机 → 上一台那次 listWorkspaces 可能在新的这次之后才回来,
  //  不认令牌的话它会把新主机的列表覆盖成旧主机的 —— 而且只在网络慢的时候偶发。
  const gen = useRef(0)

  const reload = useCallback((hk: string) => {
    const mine = ++gen.current
    setLoading(true)
    setError('')
    void api.current.listWorkspaces()
      .then(ws => { if (gen.current === mine) { setWorkspaces(ws); setError('') } })
      // ★绝不静默留空:空列表在界面上等于「这台机器没有工作区」,而真相是「没拉到」。
      .catch(e => { if (gen.current === mine) { setWorkspaces([]); setError(e instanceof Error ? e.message : String(e)) } })
      .finally(() => { if (gen.current === mine) setLoading(false) })
    // Branch / change counts / last-activity per workspace — async (git status per worktree), so it
    // streams in after the cheap workspace list. Failures degrade to no enrichment, never throw.
    // 成功 → 刷新并回写缓存(下次热启动用);失败 → 保留已有(缓存)的 stats,别清空成 {} 触发重排。
    void api.current.homeStats()
      .then(s => { if (gen.current === mine) { setStats(s); cacheStats(hk, s) } })
      .catch(() => { /* keep seeded/last stats */ })
  }, [])

  /**
   * ★★换了一台机器 = 换了一整份数据。清空**再**拉,不是拉完再换:
   *  中间那几百毫秒(远程还要等握手)里留着上一台的列表,而侧栏那枚徽章已经是新主机的名字 ——
   *  用户看到的是「本机的工作区顶着远程主机的名牌」,他会照着它点进去。
   *  主进程 `remote/router.ts` 里「绝不回落到本机」守的是同一条不变式,渲染层这边原来是漏的。
   */
  useEffect(() => {
    setWorkspaces([])
    setStats(loadCachedStats(hostKey))
    reload(hostKey)
  }, [hostKey, readySeq, reload])

  // 「打开已有工作区」选的是**那台机器**上的目录。本机时 openWorkspaceDir 自己弹原生对话框;
  // 连着远程时先用服务端目录选择器选好,再把路径传进去 —— 无头机器上没有对话框这回事。
  const openDir = useCallback(async () => {
    if (hostKey === 'local') { setWorkspaces(await api.current.openWorkspaceDir()); return }
    const dir = await pickPath('directory', '选择已有工作区目录')
    if (!dir) return
    setWorkspaces(await api.current.openWorkspaceDir(dir))
  }, [hostKey, pickPath])

  const setPinned = useCallback(async (path: string, pinned: boolean) => {
    setWorkspaces(await api.current.setWorkspacePinned(path, pinned))
  }, [])

  // Persist the user's manual drag order for the (non-pinned) workspace list.
  const setOrder = useCallback(async (order: string[]) => {
    setWorkspaces(await api.current.setWorkspaceOrder(order))
  }, [])

  const archive = useCallback(async (path: string) => {
    await api.current.archiveWorkspace(path)
    reload(hostKey)
  }, [reload, hostKey])

  const restore = useCallback(async (path: string) => {
    await api.current.restoreWorkspace(path)
    reload(hostKey)
  }, [reload, hostKey])

  const remove = useCallback(async (path: string) => {
    const result = await api.current.deleteWorkspace(path)
    reload(hostKey)
    return result
  }, [reload, hostKey])

  // 移除:仅从列表移除,保留磁盘文件。
  const removeFromList = useCallback(async (path: string) => {
    setWorkspaces(await api.current.removeWorkspaceFromList(path))
  }, [])

  // 在系统文件管理器中打开该工作区目录(Finder / 资源管理器 / 文件管理器)。
  const reveal = useCallback((path: string) => api.current.revealPath(path), [])

  useEffect(() => {
    if (!api.current.onWorkspacesChanged) return
    const unsubscribe = api.current.onWorkspacesChanged(() => reload(hostKey))
    return () => { unsubscribe() }
  }, [reload, hostKey])

  return { workspaces, stats, loading, error, reload: () => reload(hostKey), openDir, setPinned, setOrder, archive, restore, remove, removeFromList, reveal }
}

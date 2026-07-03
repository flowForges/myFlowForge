import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorkspaceMeta, HomeStats } from '@shared/types'

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
  const [stats, setStats] = useState<HomeStats>({})
  const api = useRef(window.forge)

  const reload = useCallback(() => {
    void api.current.listWorkspaces().then(setWorkspaces)
    // Branch / change counts / last-activity per workspace — async (git status per worktree), so it
    // streams in after the cheap workspace list. Failures degrade to no enrichment, never throw.
    void api.current.homeStats().then(setStats).catch(() => setStats({}))
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

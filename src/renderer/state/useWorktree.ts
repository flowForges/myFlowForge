import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChangesEvent, ChangeItem, TreeNode } from '@shared/types'

export interface WorktreeApi {
  changes: ChangeItem[]
  tree: TreeNode[]
  /** Force an immediate re-read of git changes + the file tree (manual 刷新 button). */
  refresh: () => void
}

export function useWorktree(cwd: string | undefined): WorktreeApi {
  const [changes, setChanges] = useState<ChangeItem[]>([])
  const [tree, setTree] = useState<TreeNode[]>([])
  const api = useRef(window.forge)

  const refresh = useCallback(() => {
    if (!cwd) return
    void api.current.watchChanges(cwd).then(setChanges)
    void api.current.fsTree(cwd).then(setTree)
  }, [cwd])

  useEffect(() => {
    if (!cwd) { setChanges([]); setTree([]); void api.current.watchStop(); return }
    let live = true
    void api.current.watchChanges(cwd).then((c: ChangeItem[]) => { if (live) setChanges(c) })
    void api.current.fsTree(cwd).then((t: TreeNode[]) => { if (live) setTree(t) })
    return () => { live = false; void api.current.watchStop() }
  }, [cwd])

  useEffect(() => {
    const off = api.current.onChangesEvent((e: ChangesEvent) => {
      if (e.cwd !== cwd) return
      setChanges(e.changes)
      void api.current.fsTree(e.cwd).then(setTree)
    })
    return () => { off() }
  }, [cwd])

  return { changes, tree, refresh }
}

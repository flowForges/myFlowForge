import { useEffect, useRef, useState } from 'react'
import type { ChangesEvent, ChangeItem, TreeNode } from '@shared/types'

export interface WorktreeApi {
  changes: ChangeItem[]
  tree: TreeNode[]
}

export function useWorktree(cwd: string | undefined): WorktreeApi {
  const [changes, setChanges] = useState<ChangeItem[]>([])
  const [tree, setTree] = useState<TreeNode[]>([])
  const api = useRef(window.forge)

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

  return { changes, tree }
}

import { useCallback, useEffect, useState } from 'react'
import { CH } from '../../../src/main/ipc/channels'
import type { ChangeItem, DiffLine, MultiChanges } from '../../../src/shared/types'
import { useConn } from '../net/conn'

/** 一个工作区里各项目的改动。`cwd` 是项目工作树,`name` 是显示名。 */
export type ChangeGroup = { name: string; cwd: string; changes: ChangeItem[] }

type WsInfo = { projects?: { name?: string; repoId?: string }[] }

export function useChanges(wsPath: string | null) {
  const { invoke, online } = useConn()
  const [groups, setGroups] = useState<ChangeGroup[]>([])
  const [total, setTotal] = useState({ total: 0, add: 0, del: 0 })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!wsPath || !online) return
    let alive = true
    setLoading(true)
    setError(null)
    void (async () => {
      try {
        const info = (await invoke(CH.workspaceGet, [wsPath])) as WsInfo
        // 项目工作树就是 `<工作区>/<项目名>` —— 桌面端 WorkspaceView 也是这么推的,
        // 别再发明第二套推法,否则两边对同一个工作区会看到不同的项目。
        const names = (info?.projects ?? []).map((p) => p.name || p.repoId || '').filter(Boolean) as string[]
        const cwds = names.map((n) => `${wsPath}/${n}`)
        if (!cwds.length) {
          if (alive) {
            setGroups([])
            setTotal({ total: 0, add: 0, del: 0 })
            setLoading(false)
          }
          return
        }
        const m = (await invoke(CH.changesMulti, [cwds])) as MultiChanges
        if (!alive) return
        const nameByCwd = new Map(cwds.map((c, i) => [c, names[i]]))
        setGroups(m.byProject.map((b) => ({ name: nameByCwd.get(b.cwd) ?? b.cwd, cwd: b.cwd, changes: b.changes })))
        setTotal({ total: m.total, add: m.add, del: m.del })
        setLoading(false)
      } catch (e) {
        if (!alive) return
        setError(e instanceof Error ? e.message : String(e))
        setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [wsPath, online, invoke, tick])

  const diff = useCallback(
    async (cwd: string, file: string): Promise<DiffLine[]> =>
      (await invoke(CH.gitDiff, [{ cwd, file }])) as DiffLine[],
    [invoke],
  )

  return { groups, total, loading, error, diff, refresh: () => setTick((t) => t + 1) }
}

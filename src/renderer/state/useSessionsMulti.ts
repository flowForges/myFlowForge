import { useEffect, useRef, useState } from 'react'
import type { ChatSession, SessionsFile } from '@shared/types'
import type { ForgeApi } from '../../preload/index'

// 为「多个展开工作区」懒加载会话列表。键 = workspacePath。新出现的 path 拉一次；
// 订阅 onSessionsChanged 后按 workspacePath 精确更新；移出的 path 保留旧缓存（无害，避免抖动）。
export function useSessionsMulti(paths: string[]): Record<string, ChatSession[]> {
  const [map, setMap] = useState<Record<string, ChatSession[]>>({})
  const loaded = useRef<Set<string>>(new Set())
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const api = useRef((window as any).forge as ForgeApi)

  useEffect(() => {
    let live = true
    for (const p of paths) {
      if (!p || loaded.current.has(p) || !api.current.sessionList) continue
      loaded.current.add(p)
      void api.current.sessionList(p).then((f: SessionsFile) => {
        if (live) setMap(prev => ({ ...prev, [p]: f.sessions }))
      })
    }
    return () => { live = false }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paths.join('|')])

  useEffect(() => {
    if (!api.current.onSessionsChanged) return
    const off = api.current.onSessionsChanged((raw: unknown) => {
      const m = raw as { workspacePath: string; file: SessionsFile }
      setMap(prev => ({ ...prev, [m.workspacePath]: m.file.sessions }))
    })
    return () => { off() }
  }, [])

  return map
}

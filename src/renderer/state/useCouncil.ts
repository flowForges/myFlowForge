import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CouncilConfig, CouncilState } from '@shared/council'

export type CouncilLastConfig = Omit<CouncilConfig, 'topic' | 'attachments'>

export type CouncilApi = {
  /** 这个会话里的全部共商(进行中 + 已结束)。 */
  states: CouncilState[]
  /** 进行中的那一场(running / paused / finalizing);一个会话同时最多一场。 */
  active: CouncilState | undefined
  lastConfig: CouncilLastConfig | null
  start(cfg: CouncilConfig): Promise<void>
  pause(id: string): void
  resume(id: string): void
  stop(id: string, mode: 'finalize' | 'abort'): void
  interject(id: string, text: string): void
  followup(id: string, q: string, target: 'all' | string): void
  choose(id: string, name: string): void
  /** 当前工作区里可选作参考材料的项目。 */
  projects(): Promise<{ name: string; cwd: string }[]>
}

const LIVE = new Set<CouncilState['status']>(['running', 'paused', 'finalizing'])

function upsert(list: CouncilState[], s: CouncilState): CouncilState[] {
  const i = list.findIndex(x => x.id === s.id)
  if (i < 0) return [...list, s]
  const next = list.slice()
  next[i] = s
  return next
}

export function useCouncil(workspacePath?: string, sessionId?: string): CouncilApi {
  const [states, setStates] = useState<CouncilState[]>([])
  const [lastConfig, setLastConfig] = useState<CouncilLastConfig | null>(null)
  const api = useRef(window.forge)

  useEffect(() => {
    setStates([])
    if (!workspacePath || !sessionId) return
    let live = true
    // ★快照回来之前可能已经收到了 council:state 推送 —— 推送更新,快照不能把它盖回去
    // ★老 preload / 测试桩里可能没有共商 IPC:没有就当这个会话没有共商,不让整个工作区视图跟着崩。
    void api.current.councilList?.({ workspacePath, sessionId }).then(list => {
      if (!live) return
      setStates(cur => list.reduce((acc, s) => (acc.some(x => x.id === s.id) ? acc : [...acc, s]), cur))
    })
    const off = api.current.onCouncilState?.(s => {
      if (s.workspacePath !== workspacePath || s.sessionId !== sessionId) return
      setStates(cur => upsert(cur, s))
    })
    return () => { live = false; off?.() }
  }, [workspacePath, sessionId])

  useEffect(() => {
    setLastConfig(null)
    if (!workspacePath) return
    let live = true
    void api.current.councilLastConfig?.({ workspacePath }).then(c => { if (live) setLastConfig(c) })
    return () => { live = false }
  }, [workspacePath])

  const start = useCallback(async (cfg: CouncilConfig) => {
    if (!workspacePath || !sessionId) return
    await api.current.councilStart({ workspacePath, sessionId, config: cfg })
    const { topic: _topic, attachments: _attachments, ...rest } = cfg
    setLastConfig(rest)
  }, [workspacePath, sessionId])

  const pause = useCallback((id: string) => { void api.current.councilPause({ councilId: id }) }, [])
  const resume = useCallback((id: string) => { void api.current.councilResume({ councilId: id }) }, [])
  const stop = useCallback((id: string, mode: 'finalize' | 'abort') => { void api.current.councilStop({ councilId: id, mode }) }, [])
  const interject = useCallback((id: string, text: string) => { void api.current.councilInterject({ councilId: id, text }) }, [])
  const followup = useCallback((id: string, q: string, target: 'all' | string) => {
    void api.current.councilFollowup({ councilId: id, question: q, target })
  }, [])
  const choose = useCallback((id: string, name: string) => { void api.current.councilChoose({ councilId: id, candidate: name }) }, [])
  const projects = useCallback(async () => {
    if (!workspacePath) return []
    return api.current.councilProjects({ workspacePath })
  }, [workspacePath])

  const active = useMemo(() => states.find(s => LIVE.has(s.status)), [states])

  return { states, active, lastConfig, start, pause, resume, stop, interject, followup, choose, projects }
}

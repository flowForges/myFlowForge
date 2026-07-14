import { useEffect, useRef, useState } from 'react'
import type { EngineEvent, RunState, PendingAction, ResolvePayload } from '@shared/types'

export interface EngineApi {
  run: RunState | null
  pending: PendingAction[]
  resolve: (p: ResolvePayload) => void
  cancel: () => void
}

export function useEngine(): EngineApi {
  const [run, setRun] = useState<RunState | null>(null)
  const [pending, setPending] = useState<PendingAction[]>([])
  const apiRef = useRef(window.forge)
  useEffect(() => {
    const off = apiRef.current.onEngineEvent((e: EngineEvent) => {
      if (e.type === 'run:update') { setRun(e.run); setPending(e.run.pending) }
      else if (e.type === 'run:cleared') { setRun(r => (r && r.workspacePath === e.workspacePath ? null : r)); setPending([]) }
      else if (e.type === 'agent:heartbeat') {
        setRun(r => {
          if (!r) return r
          return {
            ...r,
            stages: r.stages.map(stage => ({
              ...stage,
              agents: stage.agents.map(agent => agent.id === e.agentId ? { ...agent, lastBeat: e.at } : agent),
            })),
          }
        })
      }
      else if (e.type === 'pending:add') setPending(p => [...p, e.action])
      else if (e.type === 'pending:resolve') setPending(p => p.filter(a => a.id !== e.id))
      else if (e.type === 'pending:annotate') setPending(p => p.map(a => a.id === e.id ? { ...a, note: e.note } : a))
    })
    return () => { off() }
  }, [])
  return { run, pending, resolve: (p) => apiRef.current.resolve(p), cancel: () => apiRef.current.cancelRun() }
}

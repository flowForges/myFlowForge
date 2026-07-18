import { useCallback, useEffect, useState } from 'react'
import type { RunControllerState, RunLogLine } from '../../main/run/controller'
import type { GateDecision, LaneDecision } from '../../main/run/decisions'

// Per-lane buffer cap for live log lines (see `laneLogs` below) — recent context only, not a
// full transcript (the bottom LogConsole is the full transcript).
const LANE_LOG_CAP = 40

export interface Run2Api {
  state: RunControllerState | null
  /** Recent think/tool/file/output lines per laneId, from the run2:log stream (P0), capped at
   *  ~40 lines/lane so the run view can show "what's happening right now" without unbounded growth. */
  laneLogs: Record<string, RunLogLine[]>
  resolveGate: (eventId: string, decision: GateDecision) => void
  resolveLane: (eventId: string, decision: LaneDecision) => void
  addFeedback: (text: string) => void
  editFeedback: (id: string, text: string) => void
  removeFeedback: (id: string) => void
  abort: () => void
}

function getRun2(): any {
  return typeof window !== 'undefined' ? (window as any).forge?.run2 : undefined
}

export function useRun2(workspacePath: string | undefined): Run2Api {
  const [state, setState] = useState<RunControllerState | null>(null)
  const [laneLogs, setLaneLogs] = useState<Record<string, RunLogLine[]>>({})
  const run2 = getRun2()

  useEffect(() => {
    if (!run2 || !workspacePath) { setState(null); return }
    let alive = true
    run2.getState(workspacePath).then((s: RunControllerState | null) => { if (alive) setState(s) })
    const offUpdate = run2.onUpdate((p: { workspacePath: string; state: RunControllerState }) => {
      if (p.workspacePath === workspacePath) setState(p.state)
    })
    return () => { alive = false; offUpdate?.() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspacePath])

  // Separate effect (own subscription lifecycle) buffering run2:log lines per lane. Reset on
  // workspacePath change so a previous workspace's buffered lines don't bleed into the new one.
  useEffect(() => {
    setLaneLogs({})
    if (!run2 || !workspacePath || !run2.onLog) return
    const offLog = run2.onLog((p: { workspacePath: string; log: RunLogLine }) => {
      if (p.workspacePath !== workspacePath) return
      setLaneLogs((prev) => {
        const existing = prev[p.log.laneId] ?? []
        const next = [...existing, p.log]
        const trimmed = next.length > LANE_LOG_CAP ? next.slice(next.length - LANE_LOG_CAP) : next
        return { ...prev, [p.log.laneId]: trimmed }
      })
    })
    return () => { offLog?.() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspacePath])

  const resolveGate = useCallback((eventId: string, decision: GateDecision) => {
    const r = getRun2()
    if (r && workspacePath) r.resolveGate({ workspacePath, eventId, decision })
  }, [workspacePath])

  const resolveLane = useCallback((eventId: string, decision: LaneDecision) => {
    const r = getRun2()
    if (r && workspacePath) r.resolveLane({ workspacePath, eventId, decision })
  }, [workspacePath])

  const addFeedback = useCallback((text: string) => {
    const r = getRun2()
    if (r && workspacePath) r.addFeedback({ workspacePath, text })
  }, [workspacePath])

  const editFeedback = useCallback((id: string, text: string) => {
    const r = getRun2()
    if (r && workspacePath) r.editFeedback({ workspacePath, id, text })
  }, [workspacePath])

  const removeFeedback = useCallback((id: string) => {
    const r = getRun2()
    if (r && workspacePath) r.removeFeedback({ workspacePath, id })
  }, [workspacePath])

  const abort = useCallback(() => {
    const r = getRun2()
    if (r && workspacePath) r.abort({ workspacePath })
  }, [workspacePath])

  return { state, laneLogs, resolveGate, resolveLane, addFeedback, editFeedback, removeFeedback, abort }
}

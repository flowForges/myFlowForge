import { useCallback, useEffect, useRef, useState } from 'react'
import type { RunControllerState, RunLogLine } from '../../main/run/controller'
import type { GateDecision, LaneDecision } from '../../main/run/decisions'
import type { LaunchStartConfig } from '../../main/run/launch'
import type { ResumableSummary } from '../../main/run/manager'

// Per-lane buffer cap for live log lines (see `laneLogs` below) — recent context only, not a
// full transcript (the bottom LogConsole is the full transcript).
const LANE_LOG_CAP = 40

export interface Run2Api {
  state: RunControllerState | null
  /** Recent think/tool/file/output lines per laneId, from the run2:log stream (P0), capped at
   *  ~40 lines/lane so the run view can show "what's happening right now" without unbounded growth. */
  laneLogs: Record<string, RunLogLine[]>
  /** This workspace's pending-run queue length from the run2:queue broadcast (0 when idle/empty). */
  queueLength: number
  /** P1-4: launch gate's 确认 button — resolves cfg (workflow + selected projects' provider/model +
   *  supplement/seed) into a RunPlan server-side (run2:launch-start) and starts run2. */
  start: (config: LaunchStartConfig) => Promise<void>
  resolveGate: (eventId: string, decision: GateDecision) => void
  resolveLane: (eventId: string, decision: LaneDecision) => void
  addFeedback: (text: string) => void
  editFeedback: (id: string, text: string) => void
  removeFeedback: (id: string) => void
  abort: () => void
  pause: () => void
  resume: () => void
  jumpBack: (targetKey: string) => void
  /** P-C2/T3 (disk-resume): a run left interrupted by a previous app exit/crash for this workspace —
   *  set from run2:resumable on mount/ws-change, null when there's nothing to offer (see
   *  Run2Manager.resumable's doc). Cleared locally (optimistic) the moment 继续/丢弃 is invoked, since
   *  either action makes the summary stale immediately (resumed → now a live run; discarded → gone). */
  resumable: ResumableSummary | null
  /** 继续: rebuild the interrupted run from disk and resume it (run2:resume-from-disk). */
  resumeFromDisk: () => Promise<void>
  /** 丢弃: clear the saved state so it stops being offered (run2:discard-resumable). */
  discardResumable: () => Promise<void>
}

function getRun2(): any {
  return typeof window !== 'undefined' ? (window as any).forge?.run2 : undefined
}

export function useRun2(workspacePath: string | undefined): Run2Api {
  const [state, setState] = useState<RunControllerState | null>(null)
  const [laneLogs, setLaneLogs] = useState<Record<string, RunLogLine[]>>({})
  const [queueLength, setQueueLength] = useState(0)
  const [resumable, setResumable] = useState<ResumableSummary | null>(null)
  // Last run identity we've buffered logs for. A NEW run in the SAME workspace reuses lane ids,
  // so we must clear stale lines when the runId changes (the workspacePath-keyed reset below only
  // fires on ws switch). Reset synchronously in onUpdate the moment a new non-null runId lands,
  // before that run's own log events arrive — so the current run's lines are never dropped.
  const lastRunIdRef = useRef<string | null>(null)
  const run2 = getRun2()

  useEffect(() => {
    if (!run2 || !workspacePath) { setState(null); setResumable(null); return }
    let alive = true
    run2.getState(workspacePath).then((s: RunControllerState | null) => {
      if (!alive) return
      // Seed the run-identity ref from the initial snapshot so the first onUpdate for this SAME
      // run doesn't mistake it for a new run and wipe logs already buffered for it.
      lastRunIdRef.current = s?.machine?.plan?.runId ?? null
      setState(s)
    })
    // P-C2/T3: check for an interrupted run left over from a previous app exit/crash — optional
    // chaining so older test doubles / a preload without this method (not every existing test mocks
    // it) degrade to "nothing resumable" instead of throwing.
    setResumable(null)
    run2.resumable?.(workspacePath)?.then((r: ResumableSummary | null) => {
      if (alive) setResumable(r ?? null)
    })
    const offUpdate = run2.onUpdate((p: { workspacePath: string; state: RunControllerState }) => {
      if (p.workspacePath !== workspacePath) return
      const runId = p.state?.machine?.plan?.runId ?? null
      if (runId && runId !== lastRunIdRef.current) {
        lastRunIdRef.current = runId
        setLaneLogs({})
      }
      setState(p.state)
    })
    return () => { alive = false; offUpdate?.() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspacePath])

  // Separate effect (own subscription lifecycle) buffering run2:log lines per lane. Reset on
  // workspacePath change so a previous workspace's buffered lines don't bleed into the new one.
  useEffect(() => {
    setLaneLogs({})
    lastRunIdRef.current = null
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

  // Task 2 (queue): mirrors the onLog subscription's shape/lifecycle. Reset to 0 on ws
  // change/unmount so a stale queue count from a previous workspace never lingers.
  useEffect(() => {
    setQueueLength(0)
    if (!run2 || !workspacePath || !run2.onQueue) return
    const offQueue = run2.onQueue((p: { workspacePath: string; length: number }) => {
      if (p.workspacePath !== workspacePath) return
      setQueueLength(p.length)
    })
    return () => { offQueue?.() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspacePath])

  const start = useCallback((config: LaunchStartConfig) => {
    const r = getRun2()
    if (!r) return Promise.resolve()
    return r.launchStart(config)
  }, [])

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

  const pause = useCallback(() => {
    const r = getRun2()
    if (r && workspacePath) r.pause({ workspacePath })
  }, [workspacePath])

  const resume = useCallback(() => {
    const r = getRun2()
    if (r && workspacePath) r.resume({ workspacePath })
  }, [workspacePath])

  const jumpBack = useCallback((targetKey: string) => {
    const r = getRun2()
    if (r && workspacePath) r.jumpBack({ workspacePath, targetKey })
  }, [workspacePath])

  const resumeFromDisk = useCallback(async () => {
    const r = getRun2()
    if (!r || !workspacePath || !r.resumeFromDisk) return
    setResumable(null) // optimistic: this call turns the interrupted run into a live one
    try {
      await r.resumeFromDisk(workspacePath)
    } catch (err) {
      // Restore the offer on failure (e.g. a stale/raced summary) instead of silently swallowing
      // it — re-querying is the safe source of truth rather than assuming the old summary still holds.
      console.error('[run2] resumeFromDisk failed', err)
      const restored = await r.resumable?.(workspacePath)
      setResumable(restored ?? null)
    }
  }, [workspacePath])

  const discardResumable = useCallback(async () => {
    const r = getRun2()
    if (!r || !workspacePath || !r.discardResumable) return
    setResumable(null) // optimistic: nothing left to offer once discarded
    try {
      await r.discardResumable(workspacePath)
    } catch (err) {
      console.error('[run2] discardResumable failed', err)
      const restored = await r.resumable?.(workspacePath)
      setResumable(restored ?? null)
    }
  }, [workspacePath])

  return { state, laneLogs, queueLength, start, resolveGate, resolveLane, addFeedback, editFeedback, removeFeedback, abort, pause, resume, jumpBack, resumable, resumeFromDisk, discardResumable }
}

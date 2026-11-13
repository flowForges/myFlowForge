// 电脑操作在渲染端的状态(spec §10.1 / §10.5):档位、挂着的门、本会话的动作记录。
// 事件只来自本机直推(V2);helper 状态不在挂载时查 —— 没开过电脑操作的人不该因为打开一个会话就拉起 helper。
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ComputerUseMode, CuSetModeCode, CuStatus } from '@shared/computerUse'
import type { CuGate, CuLogEntry, CuEvent } from '../../main/computerUse/types'

type SessionRow = { workspacePath: string; sessionId: string; mode: ComputerUseMode; title: string }
type Bridge = {
  state(): Promise<unknown>
  log(a: { workspacePath: string; sessionId: string }): Promise<unknown>
  status(): Promise<CuStatus>
  setMode(a: { workspacePath: string; sessionId: string; mode: ComputerUseMode }): Promise<unknown>
  resolve(a: { id: string; decision: 'allow' | 'deny' | 'stop' }): unknown
  stop(a?: { workspacePath: string; sessionId: string }): unknown
  thumb(a: { workspacePath: string; sessionId: string; file: string }): Promise<string | null>
  onEvent(cb: (e: unknown) => void): () => void
}
const bridge = (): Bridge | undefined => (window as unknown as { forge?: { computerUse?: Bridge } }).forge?.computerUse
const isArr = <T,>(v: unknown): v is T[] => Array.isArray(v)

export interface ComputerUseApi {
  status: CuStatus | null
  mode: ComputerUseMode
  busyBy?: { title: string }
  gates: CuGate[]
  log: CuLogEntry[]
  /** gate id → code main answered when it refused our resolve */
  gateErrors: Record<string, string>
  setMode(m: ComputerUseMode): Promise<CuSetModeCode | null>
  resolve(id: string, d: 'allow' | 'deny' | 'stop'): Promise<void>
  stop(): void
  thumb(file: string): Promise<string | null>
  refreshStatus(): Promise<CuStatus | null>
}

const LOG_CAP = 300
/** typed text lives on the gate card only (spec ruling): the log never keeps the in-memory preview */
const clean = (e: CuLogEntry): CuLogEntry => { if (e.textPreview === undefined) return e; const { textPreview: _drop, ...rest } = e; return rest }
const capLog = (l: CuLogEntry[]) => (l.length > LOG_CAP ? l.slice(l.length - LOG_CAP) : l)

export function useComputerUse(workspacePath: string, sessionId: string): ComputerUseApi {
  const [sessions, setSessions] = useState<SessionRow[]>([])
  const [gates, setGates] = useState<CuGate[]>([])
  const [log, setLog] = useState<CuLogEntry[]>([])
  const [status, setStatus] = useState<CuStatus | null>(null)
  const [gateErrors, setGateErrors] = useState<Record<string, string>>({})
  const same = useCallback((k?: { workspacePath: string; sessionId: string }) => !!k && k.workspacePath === workspacePath && k.sessionId === sessionId, [workspacePath, sessionId])
  const sameRef = useRef(same)
  sameRef.current = same

  const refreshStatus = useCallback(async (): Promise<CuStatus | null> => {
    const b = bridge()
    if (!b) return null
    try {
      const s = await b.status()
      if (s && typeof s === 'object' && 'supported' in s) { setStatus(s); return s }
    } catch { /* 拿不到就保持未知 */ }
    return null
  }, [])

  useEffect(() => {
    setSessions([]); setGates([]); setLog([]); setStatus(null); setGateErrors({})
    const b = bridge()
    if (!b || !workspacePath || !sessionId) return
    let alive = true
    let pushedState = false
    let pushedLog = false
    const live: CuLogEntry[] = []
    const resolved = new Set<string>()
    // 先订阅再拉快照:晚到的快照不覆盖已经推过来的状态。
    const off = b.onEvent((raw) => {
      const e = raw as CuEvent
      if (!alive || !e || typeof e !== 'object') return
      if (e.type === 'state') {
        pushedState = true
        setSessions(e.sessions)
        const mine = e.sessions.some((s) => s.workspacePath === workspacePath && s.sessionId === sessionId && s.mode !== 'off')
        if (!mine) setGates((g) => (g.length ? [] : g))
      } else if (e.type === 'gate') {
        if (!sameRef.current(e.gate.key)) return
        setGates((g) => (g.some((x) => x.id === e.gate.id) ? g : [...g, e.gate]))
      } else if (e.type === 'gate-resolved') {
        resolved.add(e.id)
        setGates((g) => (g.some((x) => x.id === e.id) ? g.filter((x) => x.id !== e.id) : g))
      } else if (e.type === 'action') {
        if (!sameRef.current(e.key)) return
        if (pushedLog) setLog((l) => capLog([...l, clean(e.entry)]))
        else live.push(clean(e.entry))
      }
    })
    void b.state().then((s) => {
      if (!alive || !s || typeof s !== 'object') return
      const { sessions: ss, gates: gs } = s as { sessions?: unknown; gates?: unknown }
      if (!pushedState && isArr<SessionRow>(ss)) {
        setSessions(ss)
        if (ss.some((x) => x.workspacePath === workspacePath && x.sessionId === sessionId && x.mode !== 'off')) void refreshStatus()
      }
      if (isArr<CuGate>(gs)) {
        const mine = gs.filter((g) => sameRef.current(g.key) && !resolved.has(g.id))
        setGates((cur) => [...mine.filter((g) => !cur.some((x) => x.id === g.id)), ...cur])
      }
    }).catch(() => {})
    void b.log({ workspacePath, sessionId }).then((l) => {
      if (!alive) return
      pushedLog = true
      const base = isArr<CuLogEntry>(l) ? l.map(clean) : []
      // 拉取期间推来的条目:快照里已有的(同 ts+op)不重复加
      const extra = live.filter((x) => !base.some((y) => y.ts === x.ts && y.op === x.op))
      setLog(capLog([...base, ...extra]))
    }).catch(() => { pushedLog = true })
    return () => { alive = false; off() }
  }, [workspacePath, sessionId, refreshStatus])

  // 开着的会话:状态要给输入框(缺授权时显示 需授权)。关着的不查。
  const mode: ComputerUseMode = sessions.find((s) => s.workspacePath === workspacePath && s.sessionId === sessionId)?.mode ?? 'off'
  useEffect(() => { if (mode !== 'off') void refreshStatus() }, [mode, refreshStatus])

  const holder = sessions.find((s) => s.mode !== 'off' && !(s.workspacePath === workspacePath && s.sessionId === sessionId))

  const setMode = useCallback(async (m: ComputerUseMode): Promise<CuSetModeCode | null> => {
    const b = bridge()
    if (!b) return 'unsupported'
    try {
      const r = (await b.setMode({ workspacePath, sessionId, mode: m })) as { ok?: boolean; code?: CuSetModeCode } | undefined
      return r && r.ok === false && r.code ? r.code : null
    } catch { return 'unsupported' }
  }, [workspacePath, sessionId])

  const thumb = useCallback(async (file: string): Promise<string | null> => {
    try { return (await bridge()?.thumb({ workspacePath, sessionId, file })) ?? null } catch { return null }
  }, [workspacePath, sessionId])

  return {
    status, mode, busyBy: holder ? { title: holder.title } : undefined, gates, log, gateErrors,
    setMode,
    resolve: async (id, d) => {
      try {
        const r = (await bridge()?.resolve({ id, decision: d })) as { ok?: boolean; code?: string } | undefined
        if (r && r.ok === false) setGateErrors((m) => ({ ...m, [id]: r.code ?? 'not_pending' }))
      } catch { /* 门会由主进程的事件收掉 */ }
    },
    stop: () => { void bridge()?.stop({ workspacePath, sessionId }) },
    thumb,
    refreshStatus,
  }
}

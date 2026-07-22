import type { ChatSendPayload } from '@shared/types'
import { CH } from '../ipc/channels'

interface QueuedTask { id: string; source: string; payload: ChatSendPayload }
interface Lane { busy: boolean; queue: QueuedTask[]; running: { id: string; text: string; sessionId: string; provider: string } | null; activeCancel: (() => void) | null }

export type RunTurn = (payload: ChatSendPayload) => Promise<unknown>
export type Broadcast = (channel: string, payload: unknown) => void

// Chat turns serialize PER SESSION: each session runs one turn at a time, but different sessions in the
// same workspace run concurrently (a plain chat in session B is no longer held behind session A's turn
// or behind a running workflow). Only ONE workflow may run per workspace, but that is enforced by
// Run2Manager.start — not here — so a running workflow does not block chat at all.
export class ChatQueue {
  private map = new Map<string, Map<string, Lane>>()   // ws → (sessionId → Lane)
  private seq = 0
  constructor(private runTurn: RunTurn, private broadcast: Broadcast) {}

  private lanes(ws: string): Map<string, Lane> {
    let m = this.map.get(ws)
    if (!m) { m = new Map(); this.map.set(ws, m) }
    return m
  }
  private lane(ws: string, sid: string): Lane {
    const m = this.lanes(ws)
    let l = m.get(sid)
    if (!l) { l = { busy: false, queue: [], running: null, activeCancel: null }; m.set(sid, l) }
    return l
  }

  enqueue(payload: ChatSendPayload, source: string): void {
    const { workspacePath: ws, sessionId: sid } = payload
    this.lane(ws, sid).queue.push({ id: `q-${++this.seq}`, source, payload })
    this.pump(ws, sid)
    this.emit(ws)
  }

  private pump(ws: string, sid: string): void {
    const lane = this.lane(ws, sid)
    if (lane.busy) return
    const next = lane.queue.shift()
    if (next) this.runOne(ws, sid, next)
  }

  // Kept as a no-op so Run2Manager's terminal-state call site (manager.ts) still compiles; a running
  // workflow no longer holds chat, so there is nothing to release when it ends.
  runDone(_ws: string): void {}

  cancel(ws: string, id: string): void {
    const m = this.map.get(ws); if (!m) return
    for (const lane of m.values()) {
      const i = lane.queue.findIndex(t => t.id === id)
      if (i > -1) { lane.queue.splice(i, 1); this.emit(ws); return }
    }
  }

  clear(ws: string): void {
    const m = this.map.get(ws); if (!m) return
    let changed = false
    for (const lane of m.values()) if (lane.queue.length) { lane.queue = []; changed = true }
    if (changed) this.emit(ws)
  }

  registerActive(ws: string, sessionId: string, cancel: () => void): void {
    this.lane(ws, sessionId).activeCancel = cancel
  }

  // 停止 targets the ACTIVE session's lane only — stopping session A's turn must not kill a concurrently
  // running session B in the same workspace. Callers that omit sessionId (legacy/back-compat: e.g. the
  // pet's workspace-wide stop) still cancel every lane, as before.
  stop(ws: string, sessionId?: string): void {
    const m = this.map.get(ws); if (!m) return
    if (sessionId !== undefined) { m.get(sessionId)?.activeCancel?.(); return }
    for (const lane of m.values()) lane.activeCancel?.()
  }

  runningProvider(ws: string, sessionId: string): string | null {
    return this.map.get(ws)?.get(sessionId)?.running?.provider ?? null
  }

  private runOne(ws: string, sid: string, task: QueuedTask): void {
    const lane = this.lane(ws, sid)
    lane.busy = true
    lane.running = { id: task.id, text: task.payload.text, sessionId: sid, provider: task.payload.agent }
    this.emit(ws)
    Promise.resolve(this.runTurn(task.payload)).catch(() => {}).finally(() => {
      lane.busy = false
      lane.running = null
      lane.activeCancel = null
      this.pump(ws, sid)
      this.emit(ws)
    })
  }

  private emit(ws: string): void {
    const lanes = [...this.lanes(ws).values()]
    const running = lanes.map(l => l.running).filter((r): r is NonNullable<typeof r> => !!r)
    const queue = lanes.flatMap(l => l.queue)
    this.broadcast(CH.chatQueueEvent, {
      workspacePath: ws,
      busy: running.length > 0,
      queue: queue.map(t => ({ id: t.id, text: t.payload.text, source: t.source, sessionId: t.payload.sessionId })),
      running: running[0] ?? null,
      runningTurns: running.map(r => ({ id: r.id, text: r.text, sessionId: r.sessionId })),
      runningSessionId: running[0]?.sessionId ?? null,
      runningSessionIds: running.map(r => r.sessionId),
    })
  }
}

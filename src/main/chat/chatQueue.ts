import type { ChatSendPayload } from '@shared/types'
import { CH } from '../ipc/channels'

interface QueuedTask { id: string; source: string; payload: ChatSendPayload }
interface WsQueue { busy: boolean; queue: QueuedTask[]; running: { id: string; text: string; sessionId: string; provider: string } | null; activeCancel: (() => void) | null }

export type RunTurn = (payload: ChatSendPayload) => Promise<unknown>
export type Broadcast = (channel: string, payload: unknown) => void

export class ChatQueue {
  private map = new Map<string, WsQueue>()
  private seq = 0
  constructor(private runTurn: RunTurn, private broadcast: Broadcast) {}

  private get(ws: string): WsQueue {
    let q = this.map.get(ws)
    if (!q) { q = { busy: false, queue: [], running: null, activeCancel: null }; this.map.set(ws, q) }
    return q
  }

  enqueue(payload: ChatSendPayload, source: string): void {
    const ws = payload.workspacePath
    const q = this.get(ws)
    const task: QueuedTask = { id: `q-${++this.seq}`, source, payload }
    if (q.busy) { q.queue.push(task); this.emit(ws) }
    else this.runOne(ws, task)
  }

  cancel(ws: string, id: string): void {
    const q = this.map.get(ws); if (!q) return
    const i = q.queue.findIndex(t => t.id === id)
    if (i > -1) { q.queue.splice(i, 1); this.emit(ws) }
  }

  clear(ws: string): void {
    const q = this.map.get(ws); if (!q) return
    if (q.queue.length) { q.queue = []; this.emit(ws) }
  }

  registerActive(ws: string, cancel: () => void): void {
    const q = this.get(ws)
    q.activeCancel = cancel
  }

  stop(ws: string): void {
    const q = this.map.get(ws)
    if (q?.activeCancel) q.activeCancel()
  }

  // Provider id of the turn currently in-flight for this session, or null when the session isn't
  // running. Lets the IDs panel mark the specific main-Agent row as 运行中 (the resume map otherwise
  // has no liveness — see agentSessions.ts). At most one turn runs per workspace, so a sessionId match
  // is enough; a different session's turn (or idle) returns null.
  runningProvider(ws: string, sessionId: string): string | null {
    const q = this.map.get(ws)
    return q?.running?.sessionId === sessionId ? q.running.provider : null
  }

  private runOne(ws: string, task: QueuedTask): void {
    const q = this.get(ws)
    q.busy = true
    q.running = { id: task.id, text: task.payload.text, sessionId: task.payload.sessionId, provider: task.payload.agent }
    this.emit(ws)
    Promise.resolve(this.runTurn(task.payload)).catch(() => {}).finally(() => {
      q.busy = false
      q.running = null
      q.activeCancel = null
      const next = q.queue.shift()
      if (next) this.runOne(ws, next)
      else this.emit(ws)
    })
  }

  private emit(ws: string): void {
    const q = this.get(ws)
    this.broadcast(CH.chatQueueEvent, {
      workspacePath: ws,
      busy: q.busy,
      queue: q.queue.map(t => ({ id: t.id, text: t.payload.text, source: t.source })),
      running: q.running,
      // Session that owns the in-flight turn (null when idle). Lets the sidebar light the specific
      // session's dot, not just the workspace pill — the queue serializes per workspace, so at most one
      // session runs here at a time, but multiple workspaces (each its own queue) can run concurrently.
      runningSessionId: q.running?.sessionId ?? null,
    })
  }
}

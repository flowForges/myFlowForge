import type { ChatSendPayload } from '@shared/types'
import { CH } from '../ipc/channels'

interface QueuedTask { id: string; source: string; payload: ChatSendPayload }
interface WsQueue { busy: boolean; queue: QueuedTask[]; running: { id: string; text: string; sessionId: string; provider: string } | null; activeCancel: (() => void) | null }

export type RunTurn = (payload: ChatSendPayload) => Promise<unknown>
export type Broadcast = (channel: string, payload: unknown) => void

export class ChatQueue {
  private map = new Map<string, WsQueue>()
  private seq = 0
  // isRunActive(ws): a run2 workflow is executing in this workspace → hold chat turns (don't start them)
  // until it finishes. run2 lanes mutate the working tree, so running a chat turn concurrently could
  // collide; instead the user can keep typing/queueing and the queue drains when runDone(ws) fires. When
  // omitted (tests, older callers) nothing is ever held — plain FIFO on `busy`.
  constructor(private runTurn: RunTurn, private broadcast: Broadcast, private isRunActive?: (ws: string) => boolean) {}

  private get(ws: string): WsQueue {
    let q = this.map.get(ws)
    if (!q) { q = { busy: false, queue: [], running: null, activeCancel: null }; this.map.set(ws, q) }
    return q
  }

  enqueue(payload: ChatSendPayload, source: string): void {
    const ws = payload.workspacePath
    const q = this.get(ws)
    q.queue.push({ id: `q-${++this.seq}`, source, payload })
    this.pump(ws)
    this.emit(ws)
  }

  // Start the next queued task if the workspace is idle AND no run2 workflow is holding it. Central
  // gate used by enqueue, turn-completion, and runDone so the "hold while a run is active" rule lives
  // in exactly one place.
  private pump(ws: string): void {
    const q = this.get(ws)
    if (q.busy || this.isRunActive?.(ws)) return
    const next = q.queue.shift()
    if (next) this.runOne(ws, next)
  }

  // Called when a run2 workflow for this workspace reaches a terminal state (Run2Manager) — release any
  // chat turns the user queued while it ran, in FIFO order.
  runDone(ws: string): void {
    this.pump(ws)
    this.emit(ws)
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
      this.pump(ws)   // start the next queued turn if the workspace is now free (and no run2 is holding)
      this.emit(ws)
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

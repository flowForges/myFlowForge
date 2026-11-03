import type { ChatSendPayload, ChatQueueEvent } from '@shared/types'
import { CH } from '../ipc/channels'

interface QueuedTask { id: string; source: string; payload: ChatSendPayload }
// ★runningPayload 不放进 running:running 原样广播给渲染端/手机,这里只是主进程自己要查的那份载荷。
interface Lane { busy: boolean; queue: QueuedTask[]; running: { id: string; text: string; sessionId: string; provider: string } | null; runningPayload?: ChatSendPayload; activeCancel: (() => void) | null; background: number; backgroundStop: (() => void) | null; adopted: { provider: string; run: () => Promise<unknown> }[]; runningAdopted: boolean }

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
    if (!l) { l = { busy: false, queue: [], running: null, activeCancel: null, background: 0, backgroundStop: null, adopted: [], runningAdopted: false }; m.set(sid, l) }
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
    // CLI 已经开口说话的那一轮排在用户消息前面:它的回复本来就先于这些消息产生。
    const auto = lane.adopted.shift()
    if (auto) { this.runOne(ws, sid, { id: `q-${++this.seq}`, source: '后台', payload: { agent: auto.provider, text: '' } as ChatSendPayload }, auto.run); return }
    const next = lane.queue.shift()
    if (next) this.runOne(ws, sid, next)
  }

  /**
   * 不是用户发起、而是 CLI 自己起的一轮(后台任务完成后):占同一条泳道,所以它在跑时用户的消息照常排队,
   * 正在说话的是谁、停止按钮管谁都和普通一轮一样。
   */
  adoptTurn(ws: string, sid: string, provider: string, run: () => Promise<unknown>): void {
    this.lane(ws, sid).adopted.push({ provider, run })
    this.pump(ws, sid)
  }

  /** 这个会话还有几个后台任务在跑(这一轮已经结束,进程还留着)。stop 杀掉它们。 */
  setBackground(ws: string, sid: string, count: number, stop: (() => void) | null): void {
    const lane = this.lane(ws, sid)
    lane.backgroundStop = stop
    if (lane.background === count) return
    lane.background = count
    this.emit(ws)
  }

  stopBackground(ws: string, sid: string): void {
    this.map.get(ws)?.get(sid)?.backgroundStop?.()
  }

  /** 正在跑的是 CLI 自己起的那一轮(不是用户发的)。 */
  runningAdopted(ws: string, sid: string): boolean {
    return !!this.map.get(ws)?.get(sid)?.runningAdopted
  }

  hasQueued(ws: string, sid: string): boolean {
    return (this.map.get(ws)?.get(sid)?.queue.length ?? 0) > 0
  }

  /** 还有后台任务在跑的会话(更新前要算进「退出会打断什么」)。 */
  listBackground(): Array<{ workspacePath: string; sessionId: string; count: number }> {
    const out: Array<{ workspacePath: string; sessionId: string; count: number }> = []
    for (const [ws, m] of this.map) for (const [sid, lane] of m) if (lane.background > 0) out.push({ workspacePath: ws, sessionId: sid, count: lane.background })
    return out
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
    // ★这一轮结束后留着跑后台任务的进程也归「停止」管:那时 activeCancel 已经没了。
    const stopLane = (lane?: Lane) => { lane?.activeCancel?.(); lane?.backgroundStop?.() }
    if (sessionId !== undefined) { stopLane(m.get(sessionId)); return }
    for (const lane of m.values()) stopLane(lane)
  }

  /** 所有工作区里【正在跑】的轮次(卡在确认/提问门上的也算 —— 门是 runTurn 里 await 的 Promise)。
   *  更新前的「有没有会话在执行」就读这个。排队但还没开跑的不算。 */
  listRunning(): Array<{ workspacePath: string; sessionId: string; text: string; provider: string }> {
    const out: Array<{ workspacePath: string; sessionId: string; text: string; provider: string }> = []
    for (const [ws, m] of this.map) {
      for (const lane of m.values()) if (lane.running) out.push({ workspacePath: ws, ...lane.running })
    }
    return out
  }

  /** 该会话有正在跑或排着队的轮次。共商「开始」要等它空下来(§7.2 #9)。 */
  sessionBusy(ws: string, sessionId: string): boolean {
    const lane = this.map.get(ws)?.get(sessionId)
    return !!lane && (lane.busy || lane.queue.length > 0)
  }

  runningProvider(ws: string, sessionId: string): string | null {
    return this.map.get(ws)?.get(sessionId)?.running?.provider ?? null
  }

  /** 正在跑的那一轮**起手时**带的权限档(载荷里没带就是 undefined)。 */
  runningPermissionMode(ws: string, sessionId: string): ChatSendPayload['permissionMode'] {
    const lane = this.map.get(ws)?.get(sessionId)
    return lane?.running ? lane.runningPayload?.permissionMode : undefined
  }

  private runOne(ws: string, sid: string, task: QueuedTask, run?: () => Promise<unknown>): void {
    const lane = this.lane(ws, sid)
    lane.busy = true
    lane.running = { id: task.id, text: task.payload.text, sessionId: sid, provider: task.payload.agent }
    lane.runningPayload = task.payload
    lane.runningAdopted = !!run
    this.emit(ws)
    Promise.resolve(run ? run() : this.runTurn(task.payload)).catch(() => {}).finally(() => {
      lane.busy = false
      lane.running = null
      lane.runningPayload = undefined
      lane.runningAdopted = false
      lane.activeCancel = null
      this.pump(ws, sid)
      this.emit(ws)
    })
  }

  // The current queue/running state for a workspace, in the same shape as the broadcast event. The
  // chatQueueEvent only fires when the queue CHANGES, so a chat view that mounts (or a session switched
  // away and back) must pull this snapshot to re-seed its lane — otherwise a stable queue is invisible.
  snapshot(ws: string): ChatQueueEvent {
    return this.buildEvent(ws)
  }

  private buildEvent(ws: string): ChatQueueEvent {
    const lanes = [...this.lanes(ws).values()]
    const running = lanes.map(l => l.running).filter((r): r is NonNullable<typeof r> => !!r)
    const queue = lanes.flatMap(l => l.queue)
    return {
      workspacePath: ws,
      busy: running.length > 0,
      queue: queue.map(t => ({ id: t.id, text: t.payload.text, source: t.source, sessionId: t.payload.sessionId })),
      running: running[0] ?? null,
      runningTurns: running.map(r => ({ id: r.id, text: r.text, sessionId: r.sessionId })),
      runningSessionId: running[0]?.sessionId ?? null,
      runningSessionIds: running.map(r => r.sessionId),
      backgroundTasks: Object.fromEntries([...this.lanes(ws)].filter(([, l]) => l.background > 0).map(([sid, l]) => [sid, l.background])),
    }
  }

  private emit(ws: string): void {
    this.broadcast(CH.chatQueueEvent, this.buildEvent(ws))
  }
}

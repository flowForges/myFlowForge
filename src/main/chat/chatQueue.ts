import type { Attachment, ChatSendPayload, ChatQueueEvent, ChatInterjectResult } from '@shared/types'
import { CH } from '../ipc/channels'

interface QueuedTask { id: string; source: string; payload: ChatSendPayload }
/** take 取出来的那条,带着它原来在队列里的位置(putBack 放回去用)。 */
export interface QueuedItem extends QueuedTask { index: number }
/** 当前这一轮的插话能力(provider 句柄上的 interject,见 AgentSession.interject)。 */
export type InterjectFn = (text: string, attachments?: Attachment[], via?: string) => Promise<boolean>
// ★runningPayload 不放进 running:running 原样广播给渲染端/手机,这里只是主进程自己要查的那份载荷。
interface Lane { busy: boolean; queue: QueuedTask[]; running: { id: string; text: string; sessionId: string; provider: string } | null; runningPayload?: ChatSendPayload; activeCancel: (() => void) | null; activeInterject: InterjectFn | null; background: number; backgroundStop: (() => void) | null; adopted: { provider: string; run: () => Promise<unknown> }[]; runningAdopted: boolean; blocked?: string }

/** 排着的这条和正在跑的那一轮是同一个 provider(插话只能并进同一个 provider 的那一轮)。 */
const sameProvider = (lane: Lane, t: QueuedTask): boolean => !!lane.running && lane.running.provider === t.payload.agent

export type RunTurn = (payload: ChatSendPayload) => Promise<unknown>
/** runTurn 的这种返回 = 这一轮没发出:会话正在 app 里进行(官方 App / 另一个 Forge 会话)。消息放回队首,泳道等「重试」。 */
export interface BusyElsewhere { busyElsewhere: string }
export const isBusyElsewhere = (r: unknown): r is BusyElsewhere => !!r && typeof (r as BusyElsewhere).busyElsewhere === 'string'
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
    if (!l) { l = { busy: false, queue: [], running: null, activeCancel: null, activeInterject: null, background: 0, backgroundStop: null, adopted: [], runningAdopted: false }; m.set(sid, l) }
    return l
  }

  enqueue(payload: ChatSendPayload, source: string): void {
    const { workspacePath: ws, sessionId: sid } = payload
    const lane = this.lane(ws, sid)
    lane.blocked = undefined   // 拦着的时候又发了一条 = 重试(排着的那条先走)
    lane.queue.push({ id: `q-${++this.seq}`, source, payload })
    this.pump(ws, sid)
    this.emit(ws)
  }

  private pump(ws: string, sid: string): void {
    const lane = this.lane(ws, sid)
    if (lane.busy) return
    // CLI 已经开口说话的那一轮排在用户消息前面:它的回复本来就先于这些消息产生。
    const auto = lane.adopted.shift()
    if (auto) { this.runOne(ws, sid, { id: `q-${++this.seq}`, source: '后台', payload: { agent: auto.provider, text: '' } as ChatSendPayload }, auto.run); return }
    if (lane.blocked) return
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

  /** 「重试」:被拦下的那条(和它后面排着的)重新发。没被拦着就什么都不做。 */
  retry(ws: string, sid: string): void {
    const lane = this.map.get(ws)?.get(sid)
    if (!lane?.blocked) return
    lane.blocked = undefined
    this.pump(ws, sid)
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

  /** 撤回一条。true = 真撤回了(界面才回填文字);false = 它已经不在队列里(被调度 / 被插话取走了)。 */
  cancel(ws: string, id: string): boolean {
    const m = this.map.get(ws); if (!m) return false
    for (const lane of m.values()) {
      const i = lane.queue.findIndex(t => t.id === id)
      if (i > -1) { lane.queue.splice(i, 1); if (!lane.queue.length) lane.blocked = undefined; this.emit(ws); return true }
    }
    return false
  }

  /**
   * 原子地从**这个会话**的队列里取出一条。取不到(已被调度 / 撤回 / 别的会话的)= null。
   * ★同步完成:和 cancel / pump 都在同一个线程上,谁先到谁拿走,不会两边都成功。
   */
  take(ws: string, sid: string, queuedId: string): QueuedItem | null {
    const lane = this.map.get(ws)?.get(sid); if (!lane) return null
    const index = lane.queue.findIndex(t => t.id === queuedId)
    if (index < 0) return null
    const [task] = lane.queue.splice(index, 1)
    if (!lane.queue.length) lane.blocked = undefined
    this.emit(ws)
    return { ...task, index }
  }

  /** take 出来没用掉的那条放回原位置(队列变短了就放到末尾)。泳道已经空闲就立刻发出。 */
  putBack(ws: string, sid: string, item: QueuedItem, index: number): void {
    const lane = this.lane(ws, sid)
    const task: QueuedTask = { id: item.id, source: item.source, payload: item.payload }
    lane.queue.splice(Math.max(0, Math.min(index, lane.queue.length)), 0, task)
    this.pump(ws, sid)
    this.emit(ws)
  }

  /**
   * 排队的那条并进这个会话正在跑的那一轮。
   * ★★先取出再问 provider:等回话的这段时间里这一轮可能结束、下一条开跑 —— 它不在队列里,就不会被发第二遍;
   *  provider 说不行才放回原位置,下一轮照常发。所以只有两种结局:进了这一轮,或者还在队列里。
   */
  async interject(ws: string, sid: string, queuedId: string): Promise<ChatInterjectResult> {
    const lane = this.map.get(ws)?.get(sid)
    if (!lane || !lane.queue.some(t => t.id === queuedId)) return { ok: false, code: 'gone' }
    if (!lane.busy) return { ok: false, code: 'not_running' }
    const fn = lane.activeInterject
    if (!fn) return { ok: false, code: 'unsupported' }
    // ★排给别的 provider 的那条(比如 codex)不能写进正在跑的 claude 那一轮:它会被错的模型回答。
    if (!sameProvider(lane, lane.queue.find(t => t.id === queuedId)!)) return { ok: false, code: 'unsupported' }
    const item = this.take(ws, sid, queuedId)
    if (!item) return { ok: false, code: 'gone' }
    let ok = false
    try { ok = await fn(item.payload.text, item.payload.attachments, item.payload.via) } catch { ok = false }
    if (ok) return { ok: true }
    this.putBack(ws, sid, item, item.index)
    return { ok: false, code: 'not_running' }
  }

  clear(ws: string): void {
    const m = this.map.get(ws); if (!m) return
    let changed = false
    for (const lane of m.values()) if (lane.queue.length || lane.blocked) { lane.queue = []; lane.blocked = undefined; changed = true }
    if (changed) this.emit(ws)
  }

  /** 这个会话当前那一轮的停止键;interject 是它的插话能力(没有 = 这一轮插不进去)。 */
  registerActive(ws: string, sessionId: string, cancel: () => void, interject?: InterjectFn): void {
    const lane = this.lane(ws, sessionId)
    lane.activeCancel = cancel
    this.setInterject(ws, sessionId, interject ?? null)
  }

  /** 单独改这一轮的插话能力(比如 provider 晚一点才知道能不能插)。能力有无变了才广播。 */
  setInterject(ws: string, sessionId: string, interject: InterjectFn | null): void {
    const lane = this.lane(ws, sessionId)
    const had = !!lane.activeInterject
    lane.activeInterject = interject
    if (had !== !!interject) this.emit(ws)
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
    Promise.resolve(run ? run() : this.runTurn(task.payload)).catch(() => undefined).then((result) => {
      // 会话正在 app 里进行,这条没发出:放回队首,不往下发,等「重试」(或再发一条)。
      if (!run && isBusyElsewhere(result)) { lane.blocked = result.busyElsewhere; lane.queue.unshift(task) }
      lane.busy = false
      lane.running = null
      lane.runningPayload = undefined
      lane.runningAdopted = false
      lane.activeCancel = null
      lane.activeInterject = null
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
    const queue = lanes.flatMap(l => l.queue.map(t => ({ t, interjectable: l.busy && !!l.activeInterject && sameProvider(l, t) })))
    return {
      workspacePath: ws,
      busy: running.length > 0,
      queue: queue.map(({ t, interjectable }) => ({ id: t.id, text: t.payload.text, source: t.source, sessionId: t.payload.sessionId, interjectable })),
      running: running[0] ?? null,
      runningTurns: running.map(r => ({ id: r.id, text: r.text, sessionId: r.sessionId })),
      runningSessionId: running[0]?.sessionId ?? null,
      runningSessionIds: running.map(r => r.sessionId),
      backgroundTasks: Object.fromEntries([...this.lanes(ws)].filter(([, l]) => l.background > 0).map(([sid, l]) => [sid, l.background])),
      blocked: Object.fromEntries([...this.lanes(ws)].filter(([, l]) => !!l.blocked).map(([sid, l]) => [sid, l.blocked!])),
    }
  }

  private emit(ws: string): void {
    this.broadcast(CH.chatQueueEvent, this.buildEvent(ws))
  }
}

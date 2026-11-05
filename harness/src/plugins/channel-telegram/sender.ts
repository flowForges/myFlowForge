// 发送器(07 spec §5.4、§9):限速、重试、分块同步。调用方(轮询、轮)永远不等它:sync、edit、typing、fire 立刻返回,
// send 的 Promise 永不 reject,网络再坏也挡不住谁。每个聊天一条队列,同一时间一个请求,顺序不变;日志只有稳定代码
import { createHash } from 'node:crypto'
import type { Logger } from '../../kernel/log'
import { TelegramError, type ApiTimers, type TelegramApi } from './api'
import type { Entity } from './markdown'
import { codeOf } from './poller'
import type { Chunk } from './render'

export interface OutgoingMessage {
  text: string
  entities?: readonly Entity[]
  /** 原样进 reply_markup */
  keyboard?: unknown
  /** 退到纯文本时换成这个键盘:卡片没了 pre 的边界,正文能伪造卡片的行 */
  plainKeyboard?: unknown
  silent?: boolean
}

/** 按块对齐:messageIds[i]、hashes[i] 是第 i 块。sender 就地改它,调用方落盘(§9.5) */
export interface Delivery {
  turnId: string
  messageIds: number[]
  hashes: string[]
  done: boolean
}

export interface SenderOpts {
  api: TelegramApi
  now(): number
  timers: ApiTimers
  /** [0, 1) */
  random(): number
  /** 这个聊天的 Delivery 变了,该落盘了 */
  onChange(chatId: string): void
  /** 一条最终内容放弃了,计入 undelivered;Delivery 还开着,下次启动再补 */
  onUndelivered?(chatId: string): void
  /** blocked 记在 state.json:sender 只查不存,解封和重启都不用另外通知 */
  isBlocked?(chatId: string): boolean
  /** Telegram 回了 403 */
  onBlocked?(chatId: string): void
  log: Logger
}

const GLOBAL_PER_SECOND = 25
const GLOBAL_WINDOW_MS = 1000
const CHAT_WRITE_INTERVAL_MS = 1100
const EDIT_INTERVAL_MS = 1500
const TYPING_INTERVAL_MS = 5000
const BACKOFF_MIN_MS = 1000
const BACKOFF_MAX_MS = 60_000
const JITTER = 0.2
const FINAL_RETRY_MS = 3_600_000
/** 单次定时的上限:再大的 retry_after 也不能让 setTimeout 溢出成立刻触发,到点再排 */
const MAX_TIMER_MS = 3_600_000
/** 没有 retry_after 的 429 */
const RETRY_AFTER_FALLBACK_S = 5
/** send、edit、fire 的总数;sync 不受限:一轮一条,且最终内容不能丢 */
const QUEUE_MAX = 256
/** 总数满了每条队列也还能排这么多:别的聊天刷屏不能饿死配对账号的审批卡片 */
const LANE_RESERVED = 8
/** Telegram 说得再久也最多等这么久,到点再问一次:这个聊天排着的都在等它 */
const RETRY_AFTER_MAX_MS = 3_600_000
const EDIT_TIMES_MAX = 32
const LANES_SWEEP_AT = 1000

type SyncOp = {
  kind: 'sync'
  turnId: string
  chunks: Chunk[]
  hashes: string[]
  final: boolean
  delivery: Delivery
  /** 第几块只发纯文本(§9.1) */
  plain: Set<number>
  /** 第几块原消息没了,发新的 */
  resend: Set<number>
}
type SendOp = { kind: 'send'; msg: OutgoingMessage; plain: boolean; retryWhile?: () => boolean; onPlain?: () => void; resolve(id: number | undefined): void }
type EditOp = { kind: 'edit'; messageId: number; msg: OutgoingMessage; plain: boolean }
type CallOp = { kind: 'call'; method: string; body: object; limited: boolean }
type Op = (SyncOp | SendOp | EditOp | CallOp) & {
  /** 每来一次新内容加一:失败时用它分辨手上有没有更新的 */
  rev: number
  attempts: number
  notBefore: number
  /** 从第一次失败起算,被 429 暂停的时间不算 */
  giveUpAt?: number
}

interface Lane {
  chatId: string
  /** 写操作之间的间隔;不属于聊天的调用(answerCallbackQuery、leaveChat)没有 */
  paced: boolean
  ops: Op[]
  /** 手上的请求。被 drop 之后它不在 ops 里了,结果还是要等 */
  inFlight?: Op
  timer?: unknown
  pausedUntil: number
  lastWriteAt: number
  editedAt: Map<number, number>
  typedAt: number
}

interface Step {
  method: string
  body: object
  rev: number
  /** 这次是在改这条消息 */
  messageId?: number
  /** sync 的第几块 */
  index?: number
  hash?: string
  /** 带了 entities,被拒后还能发一次纯文本 */
  hasEntities: boolean
}

const hashOf = (c: Chunk) => createHash('sha256').update(JSON.stringify([c.text, c.entities])).digest('base64url').slice(0, 22)

/** sendMessage、editMessageText 的正文只在这里拼:链接预览永远关(§9.4) */
function content(msg: OutgoingMessage, plain: boolean): object {
  return {
    text: msg.text,
    ...(!plain && msg.entities && msg.entities.length > 0 && { entities: msg.entities }),
    ...(msg.keyboard !== undefined && { reply_markup: plain && msg.plainKeyboard !== undefined ? msg.plainKeyboard : msg.keyboard }),
    link_preview_options: { is_disabled: true },
  }
}

const FRESH = { rev: 0, attempts: 0, notBefore: 0 }

export class Sender {
  private readonly lanes = new Map<string, Lane>()
  /** 最近一秒发出的请求时刻 */
  private readonly recent: number[] = []
  private readonly lifetime = new AbortController()
  private readonly drainWaiters = new Set<() => void>()
  private queued = 0
  private flushing = 0
  private closed = false

  constructor(private readonly o: SenderOpts) {}

  /**
   * 这一轮现在该是这些块,最新的算数。interim 失败就丢,下一次 sync 接着对齐;final 退避重试,最多 1 小时。
   * 同一轮的多次 sync 只有中间隔了一条 send 才分开排:审批卡片之后的输出要在卡片之后(§9.3)
   */
  sync(chatId: string, turnId: string, chunks: Chunk[], o: { final: boolean; delivery: Delivery }): void {
    if (!this.accepting(chatId)) return
    if (o.delivery.turnId !== turnId) {
      // 接着写就是改写上一轮的消息
      this.o.log.warn('telegram delivery belongs to another turn')
      return
    }
    const lane = this.laneOf(chatId, true)
    const hashes = chunks.map(hashOf)
    const tail = lastNonEdit(lane.ops)
    if (tail?.kind === 'sync' && tail.delivery === o.delivery && tail.turnId === turnId) {
      tail.chunks = chunks
      tail.hashes = hashes
      tail.final = tail.final || o.final
      tail.rev++
    } else {
      lane.ops.push({ ...FRESH, kind: 'sync', turnId, chunks, hashes, final: o.final, delivery: o.delivery, plain: new Set(), resend: new Set() })
    }
    this.pump(lane)
  }

  /** 卡片、命令回复。给 retryWhile 的重试到它为假,不给的最多 1 小时。结果只有 message_id 或 undefined,永不 reject */
  send(chatId: string, msg: OutgoingMessage, o: { retryWhile?: () => boolean; onPlain?: () => void } = {}): Promise<number | undefined> {
    if (!this.accepting(chatId)) return Promise.resolve(undefined)
    const lane = this.laneOf(chatId, true)
    if (!this.hasRoom(lane)) {
      this.o.log.warn('telegram send queue full', { method: 'sendMessage' })
      return Promise.resolve(undefined)
    }
    return new Promise(resolve => {
      this.queued++
      lane.ops.push({ ...FRESH, kind: 'send', msg, plain: false, ...(o.retryWhile && { retryWhile: o.retryWhile }), ...(o.onPlain && { onPlain: o.onPlain }), resolve })
      this.pump(lane)
    })
  }

  /** 卡片更新。同一条消息最新的算数 */
  edit(chatId: string, messageId: number, msg: OutgoingMessage): void {
    if (!this.accepting(chatId)) return
    const lane = this.laneOf(chatId, true)
    const same = lane.ops.find((op): op is Op & EditOp => op.kind === 'edit' && op.messageId === messageId)
    if (same) {
      same.msg = msg
      same.plain = false
      same.rev++
    } else {
      if (!this.hasRoom(lane)) {
        this.o.log.warn('telegram send queue full', { method: 'editMessageText' })
        return
      }
      this.queued++
      lane.ops.push({ ...FRESH, kind: 'edit', messageId, msg, plain: false })
    }
    this.pump(lane)
  }

  /** 不属于聊天内容的一次性调用(answerCallbackQuery、leaveChat):占全局额度,429 等一次,其余失败只记代码 */
  fire(method: string, body: object): void {
    if (this.closed) return
    const lane = this.laneOf(`~${method}`, false)
    if (!this.hasRoom(lane)) {
      this.o.log.warn('telegram send queue full', { method })
      return
    }
    this.queued++
    lane.ops.push({ ...FRESH, kind: 'call', method, body, limited: false })
    this.pump(lane)
  }

  /** 每个聊天最多 5 s 一次,发不出就算了:不占写间隔,不进队列 */
  typing(chatId: string): void {
    if (!this.accepting(chatId)) return
    const lane = this.laneOf(chatId, true)
    const now = this.o.now()
    if (now < lane.pausedUntil || now - lane.typedAt < TYPING_INTERVAL_MS || this.globalReadyAt(now) > now) return
    lane.typedAt = now
    this.recent.push(now)
    void this.request('sendChatAction', { chat_id: chatId, action: 'typing' }).catch((err: unknown) => {
      if (err instanceof TelegramError && err.code === 'blocked') this.markBlocked(chatId)
      else if (err instanceof TelegramError && err.code === 'rate_limited') this.pauseFor(lane, err)
      else this.o.log.warn('telegram typing failed', { code: codeOf(err) })
    })
  }

  /** 关闭前用:写间隔不等了,429 暂停和退避照旧。最多等 ms;没发完的靠 §9.5 下次补 */
  flush(ms: number): Promise<void> {
    if (this.closed || this.isDrained()) return Promise.resolve()
    return new Promise(resolve => {
      this.flushing++
      const finish = () => {
        this.drainWaiters.delete(finish)
        this.o.timers.clearTimeout(timer)
        this.flushing--
        resolve()
      }
      const timer = this.o.timers.setTimeout(finish, ms)
      this.drainWaiters.add(finish)
      for (const lane of [...this.lanes.values()]) this.pump(lane)
    })
  }

  /** 这个聊天排着的全不要了(撤销配对、对方封了机器人) */
  drop(chatId: string): void {
    const lane = this.lanes.get(chatId)
    if (lane) this.clearLane(lane)
  }

  /** 换了机器人:旧聊天的东西不能用新令牌发 */
  dropAll(): void {
    for (const lane of [...this.lanes.values()]) this.clearLane(lane)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.dropAll()
    this.lifetime.abort()
    for (const finish of [...this.drainWaiters]) finish()
  }

  private hasRoom(lane: Lane): boolean {
    return this.queued < QUEUE_MAX || lane.ops.length < LANE_RESERVED
  }

  private accepting(chatId: string): boolean {
    return !this.closed && !this.isBlocked(chatId)
  }

  private isBlocked(chatId: string): boolean {
    try {
      return this.o.isBlocked?.(chatId) === true
    } catch (err) {
      this.o.log.warn('telegram blocked check failed', { code: codeOf(err) })
      return false
    }
  }

  private safely(callback: ((chatId: string) => void) | undefined, chatId: string): void {
    try {
      callback?.(chatId)
    } catch (err) {
      this.o.log.warn('telegram sender callback failed', { code: codeOf(err) })
    }
  }

  private laneOf(chatId: string, paced: boolean): Lane {
    let lane = this.lanes.get(chatId)
    if (lane) return lane
    if (this.lanes.size >= LANES_SWEEP_AT) this.sweep()
    lane = { chatId, paced, ops: [], pausedUntil: 0, lastWriteAt: -Infinity, editedAt: new Map(), typedAt: -Infinity }
    this.lanes.set(chatId, lane)
    return lane
  }

  /** 空闲且间隔都过了的,留着也没用:陌生人的聊天不能把这张表撑大 */
  private sweep(): void {
    const now = this.o.now()
    for (const [id, lane] of this.lanes) {
      if (lane.ops.length === 0 && !lane.inFlight && lane.pausedUntil <= now && now - lane.lastWriteAt > EDIT_INTERVAL_MS) this.lanes.delete(id)
    }
  }

  private isDrained(): boolean {
    for (const lane of this.lanes.values()) if (lane.ops.length > 0) return false
    return true
  }

  private globalReadyAt(now: number): number {
    while (this.recent.length > 0 && now - this.recent[0] >= GLOBAL_WINDOW_MS) this.recent.shift()
    return this.recent.length < GLOBAL_PER_SECOND ? now : this.recent[0] + GLOBAL_WINDOW_MS
  }

  /** 队头能走就走,不能走就排定时器。手上有请求时什么都不做,回来时会再进这里 */
  private pump(lane: Lane): void {
    if (this.closed || lane.inFlight) return
    this.o.timers.clearTimeout(lane.timer)
    lane.timer = undefined
    if (lane.paced && lane.ops.length > 0 && this.isBlocked(lane.chatId)) {
      this.clearLane(lane)
      return
    }
    for (;;) {
      const op = lane.ops[0]
      if (!op) {
        this.checkDrained()
        return
      }
      if (op.kind === 'send' && op.retryWhile && !this.stillWanted(op)) {
        this.settle(lane, op, undefined)
        continue
      }
      const step = this.nextStep(lane, op)
      if (!step) {
        this.complete(lane, op)
        continue
      }
      const now = this.o.now()
      const at = this.readyAt(lane, op, step, now)
      if (at > now) {
        lane.timer = this.o.timers.setTimeout(() => {
          lane.timer = undefined
          this.pump(lane)
        }, Math.min(at - now, MAX_TIMER_MS))
        return
      }
      this.dispatch(lane, op, step, now)
      return
    }
  }

  private stillWanted(op: SendOp): boolean {
    try {
      return op.retryWhile?.() ?? true
    } catch {
      return false
    }
  }

  private readyAt(lane: Lane, op: Op, step: Step, now: number): number {
    let at = Math.max(lane.pausedUntil, op.notBefore, this.globalReadyAt(now))
    if (this.flushing === 0 && lane.paced) {
      at = Math.max(at, lane.lastWriteAt + CHAT_WRITE_INTERVAL_MS)
      if (step.messageId !== undefined) at = Math.max(at, (lane.editedAt.get(step.messageId) ?? -Infinity) + EDIT_INTERVAL_MS)
    }
    return at
  }

  /** 这个 op 下一个要发的请求;undefined = 没有了 */
  private nextStep(lane: Lane, op: Op): Step | undefined {
    const chat_id = lane.chatId
    switch (op.kind) {
      case 'send':
        return {
          method: 'sendMessage',
          body: { chat_id, ...content(op.msg, op.plain), ...(op.msg.silent && { disable_notification: true }) },
          rev: op.rev,
          hasEntities: !op.plain && (op.msg.entities?.length ?? 0) > 0,
        }
      case 'edit':
        return {
          method: 'editMessageText',
          body: { chat_id, message_id: op.messageId, ...content(op.msg, op.plain) },
          rev: op.rev,
          messageId: op.messageId,
          hasEntities: !op.plain && (op.msg.entities?.length ?? 0) > 0,
        }
      case 'call':
        return { method: op.method, body: op.body, rev: op.rev, hasEntities: false }
      case 'sync':
        return this.nextChunk(lane, op)
    }
  }

  private nextChunk(lane: Lane, op: Op & SyncOp): Step | undefined {
    const { messageIds, hashes } = op.delivery
    for (let index = 0; index < op.chunks.length; index++) {
      const hash = op.hashes[index]
      const isNew = index >= messageIds.length || op.resend.has(index)
      if (!isNew && hashes[index] === hash) continue
      const chunk = op.chunks[index]
      const plain = op.plain.has(index)
      const base = { rev: op.rev, index, hash, hasEntities: !plain && chunk.entities.length > 0 }
      if (isNew) {
        const silent = chunk.notify ? {} : { disable_notification: true }
        return { ...base, method: 'sendMessage', body: { chat_id: lane.chatId, ...content(chunk, plain), ...silent } }
      }
      const messageId = messageIds[index]
      return { ...base, method: 'editMessageText', messageId, body: { chat_id: lane.chatId, message_id: messageId, ...content(chunk, plain) } }
    }
    return undefined
  }

  private request(method: string, body: object): Promise<unknown> {
    // api.call 是 async,这一层防的是注入的实现同步抛错
    try {
      return this.o.api.call(method, body, { signal: this.lifetime.signal })
    } catch (err) {
      return Promise.reject(err)
    }
  }

  private dispatch(lane: Lane, op: Op, step: Step, now: number): void {
    lane.inFlight = op
    this.recent.push(now)
    if (lane.paced) lane.lastWriteAt = now
    if (step.messageId !== undefined) this.noteEdit(lane, step.messageId, now)
    void this.request(step.method, step.body)
      .then(
        result => this.onSuccess(lane, op, step, result),
        (err: unknown) => this.onFailure(lane, op, step, err),
      )
      .catch((err: unknown) => {
        // 自己的 bug 不能卡住这个聊天:这一条不要了,后面的接着走
        this.o.log.warn('telegram sender error', { code: codeOf(err) })
        if (lane.ops[0] === op) this.abandon(lane, op)
      })
      .finally(() => {
        delete lane.inFlight
        this.pump(lane)
        this.checkDrained()
      })
  }

  private noteEdit(lane: Lane, messageId: number, now: number): void {
    lane.editedAt.delete(messageId)
    lane.editedAt.set(messageId, now)
    if (lane.editedAt.size > EDIT_TIMES_MAX) {
      const oldest = lane.editedAt.keys().next().value
      if (oldest !== undefined) lane.editedAt.delete(oldest)
    }
  }

  private onSuccess(lane: Lane, op: Op, step: Step, result: unknown): void {
    const id = step.method === 'sendMessage' ? (result as { message_id?: unknown } | null)?.message_id : undefined
    if (lane.ops[0] !== op) {
      this.onDetachedSuccess(lane, op, step, id)
      return
    }
    if (step.method === 'sendMessage' && (op.kind === 'sync' || op.kind === 'send') && (typeof id !== 'number' || !Number.isSafeInteger(id))) {
      this.onFailure(lane, op, step, new TelegramError('server'))
      return
    }
    this.resetFailures(op)
    if (op.kind === 'sync') {
      if (typeof id === 'number') this.placeMessage(lane, op, step, id)
      else this.recordHash(lane, op, step)
      return
    }
    if (op.kind === 'send') {
      this.settle(lane, op, id as number)
      return
    }
    if (op.kind === 'edit' && op.rev !== step.rev) return
    this.remove(lane, op)
    this.queued--
  }

  /** 请求途中被 drop 了,但消息真的发出去了:调用方要知道,Delivery 要记,否则重放时再发一遍 */
  private onDetachedSuccess(lane: Lane, op: Op, step: Step, id: unknown): void {
    const valid = typeof id === 'number' && Number.isSafeInteger(id)
    if (op.kind === 'send') {
      op.resolve(valid ? id : undefined)
      return
    }
    if (op.kind !== 'sync' || this.closed) return
    if (valid) this.placeMessage(lane, op, step, id)
    else if (step.method !== 'sendMessage') this.recordHash(lane, op, step)
  }

  private placeMessage(lane: Lane, op: Op & SyncOp, step: Step, id: number): void {
    const index = step.index as number
    op.delivery.messageIds[index] = id
    op.resend.delete(index)
    if (step.hash !== undefined) op.delivery.hashes[index] = step.hash
    this.noteEdit(lane, id, this.o.now())
    this.safely(this.o.onChange, lane.chatId)
  }

  private recordHash(lane: Lane, op: Op & SyncOp, step: Step): void {
    if (step.index === undefined || step.hash === undefined) return
    op.delivery.hashes[step.index] = step.hash
    this.safely(this.o.onChange, lane.chatId)
  }

  private onFailure(lane: Lane, op: Op, step: Step, err: unknown): void {
    if (lane.ops[0] !== op) {
      if (op.kind === 'send') op.resolve(undefined)
      return
    }
    if (this.closed) return
    if (!(err instanceof TelegramError)) {
      // api.ts 只抛 TelegramError;别的都是 bug,重试没有意义
      this.giveUp(lane, op, codeOf(err))
      return
    }
    const { code } = err
    switch (code) {
      case 'aborted':
        return
      case 'not_modified':
        this.onNotModified(lane, op, step)
        return
      case 'not_found_message':
        // 用户删了:正文发一条新的;卡片更新不发,用户不要的东西不该再冒出来
        if (op.kind === 'sync' && step.index !== undefined) op.resend.add(step.index)
        else this.abandon(lane, op)
        return
      case 'blocked':
        this.markBlocked(lane.chatId)
        // clearLane 不回手上这条,而它已经过了上面的检查:没人会再回它了
        if (op.kind === 'send') op.resolve(undefined)
        return
      case 'rate_limited':
        this.onRateLimited(lane, op, step, err)
        return
      case 'bad_request':
        if (step.hasEntities) this.fallBackToPlain(op, step)
        else this.giveUp(lane, op, code)
        return
      case 'unauthorized':
        // 轮询已经停了;令牌不对时重试只是多打请求
        this.giveUp(lane, op, code)
        return
      default:
        this.onTransient(lane, op, step, code)
    }
  }

  private onNotModified(lane: Lane, op: Op, step: Step): void {
    this.resetFailures(op)
    if (op.kind === 'sync') {
      this.recordHash(lane, op, step)
      return
    }
    if (op.kind === 'edit' && op.rev !== step.rev) return
    this.abandon(lane, op)
  }

  private fallBackToPlain(op: Op, step: Step): void {
    if (op.kind === 'sync' && step.index !== undefined) op.plain.add(step.index)
    else if (op.kind === 'send' || op.kind === 'edit') {
      op.plain = true
      if (op.kind === 'send') op.onPlain?.()
    }
  }

  private pauseFor(lane: Lane, err: TelegramError): number {
    const wait = Math.min((err.retryAfter ?? RETRY_AFTER_FALLBACK_S) * 1000, RETRY_AFTER_MAX_MS)
    lane.pausedUntil = Math.max(lane.pausedUntil, this.o.now() + wait)
    return wait
  }

  private onRateLimited(lane: Lane, op: Op, step: Step, err: TelegramError): void {
    const wait = this.pauseFor(lane, err)
    if (op.giveUpAt !== undefined) op.giveUpAt += wait
    if (this.isDroppableInterim(op, step)) {
      this.abandon(lane, op)
      return
    }
    if (op.kind === 'call') {
      if (op.limited) this.abandon(lane, op)
      else op.limited = true
    }
  }

  /** 中间的编辑手上没有更新的内容:丢掉,下一次 sync 带最新的来 */
  private isDroppableInterim(op: Op, step: Step): boolean {
    return op.kind === 'sync' && !op.final && op.rev === step.rev
  }

  private onTransient(lane: Lane, op: Op, step: Step, code: string): void {
    if (op.kind === 'call') {
      this.o.log.warn('telegram call failed', { method: op.method, code })
      this.abandon(lane, op)
      return
    }
    if (op.kind === 'sync' && !op.final) {
      if (this.isDroppableInterim(op, step)) this.abandon(lane, op)
      return
    }
    const now = this.o.now()
    const endless = op.kind === 'send' && op.retryWhile !== undefined
    op.giveUpAt ??= now + FINAL_RETRY_MS
    if (!endless && now >= op.giveUpAt) {
      this.giveUp(lane, op, code)
      return
    }
    const base = Math.min(BACKOFF_MIN_MS * 2 ** op.attempts, BACKOFF_MAX_MS)
    op.attempts++
    op.notBefore = now + Math.round(base * (1 + (this.o.random() * 2 - 1) * JITTER))
  }

  private resetFailures(op: Op): void {
    op.attempts = 0
    op.notBefore = 0
    delete op.giveUpAt
  }

  private markBlocked(chatId: string): void {
    this.safely(this.o.onBlocked, chatId)
    this.drop(chatId)
  }

  /** 这一条到此为止。最终内容计入 undelivered,Delivery 不动:下次启动重算再补 */
  private giveUp(lane: Lane, op: Op, code: string): void {
    this.o.log.warn('telegram send gave up', { kind: op.kind, code })
    if (op.kind === 'sync' && op.final) {
      this.safely(this.o.onUndelivered, lane.chatId)
      this.safely(this.o.onChange, lane.chatId)
    }
    this.abandon(lane, op)
  }

  private abandon(lane: Lane, op: Op): void {
    if (op.kind === 'send') {
      this.settle(lane, op, undefined)
      return
    }
    this.remove(lane, op)
    if (op.kind !== 'sync') this.queued--
  }

  private settle(lane: Lane, op: Op & SendOp, id: number | undefined): void {
    this.remove(lane, op)
    this.queued--
    op.resolve(id)
  }

  /** sync 的块都对齐了 */
  private complete(lane: Lane, op: Op): void {
    this.remove(lane, op)
    if (op.kind === 'sync' && op.final && !op.delivery.done) {
      op.delivery.done = true
      this.safely(this.o.onChange, lane.chatId)
    }
  }

  private remove(lane: Lane, op: Op): void {
    const at = lane.ops.indexOf(op)
    if (at >= 0) lane.ops.splice(at, 1)
  }

  private clearLane(lane: Lane): void {
    this.o.timers.clearTimeout(lane.timer)
    lane.timer = undefined
    for (const op of lane.ops.splice(0)) {
      if (op.kind !== 'sync') this.queued--
      // 手上这条的结果还没出来,onSuccess、onFailure 会回它
      if (op.kind === 'send' && op !== lane.inFlight) op.resolve(undefined)
    }
    this.checkDrained()
  }

  private checkDrained(): void {
    if (this.drainWaiters.size === 0 || !this.isDrained()) return
    for (const lane of this.lanes.values()) if (lane.inFlight) return
    for (const finish of [...this.drainWaiters]) finish()
  }
}

function lastNonEdit(ops: readonly Op[]): Op | undefined {
  for (let i = ops.length - 1; i >= 0; i--) if (ops[i].kind !== 'edit') return ops[i]
  return undefined
}

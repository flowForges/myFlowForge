// 长轮询(07 spec §5.2):getMe → 循环 { getUpdates → onBatch → 落盘 }。带新 offset 的下一次 getUpdates 才等于确认,所以发出去的只能是落了盘的
import type { Logger } from '../../kernel/log'
import { TelegramError, type TelegramApi } from './api'
import type { TelegramState } from './state'

export type PollerState = 'starting' | 'online' | 'reconnecting' | 'unauthorized' | 'conflict'

export interface PollerOpts {
  api: TelegramApi
  state: TelegramState
  /** 每条处理完调 state.advance;单条的错自己接住。正常返回 = 这批都处理了 */
  onBatch(updates: unknown[]): void | Promise<void>
  onState(s: PollerState, reason?: string): void
  sleep(ms: number): Promise<void>
  /** [0, 1) */
  random(): number
  now(): number
  pollTimeoutS?: number
  log?: Logger
}

export const POLL_TIMEOUT_S = 50
/** 本地中止比服务器的长轮询多等这么久:代理吞掉连接、合盖醒来都靠它 */
const ABORT_MARGIN_S = 15
const ALLOWED_UPDATES = ['message', 'callback_query', 'my_chat_member']
const BATCH_LIMIT = 100
const BACKOFF_MIN_MS = 1000
const BACKOFF_MAX_MS = 60_000
const JITTER = 0.2
const CONFLICT_RETRY_MS = 60_000
/** 超过 2^31 ms 的 setTimeout 会立刻触发,服务器给个离谱的数就成了空转 */
const RETRY_AFTER_MAX_MS = 3_600_000
/** 文档:没有新更新满一周后,下一个 update_id 随机。提前一天 */
const ID_RESET_IDLE_MS = 6 * 86_400_000
const STOP_BOUND_MS = 500
const SAVE_FAILED = 'state_save_failed'

type IdentifiedUpdate = { update_id: number }

const isIdentified = (u: unknown): u is IdentifiedUpdate => {
  const id = (u as IdentifiedUpdate | null | undefined)?.update_id
  return Number.isSafeInteger(id) && (id as number) >= 0
}

export class Poller {
  lastOkAt: number | undefined

  private readonly pollTimeoutS: number
  private ctl: AbortController | undefined
  private done: Promise<void> | undefined
  private reported: string | undefined
  private failures = 0
  private identified = false
  /** 上次失败了:下一次不长等,状态马上能回 online */
  private recovering = false
  /** 这轮闲置结束之前不发 offset:旧的高 offset 会把重置后的低 id 确认掉 */
  private omitOffset = false
  /** 闲置后第一批已到,offset 已归零,等它落盘 */
  private idleReset = false

  constructor(private readonly o: PollerOpts) {
    this.pollTimeoutS = o.pollTimeoutS ?? POLL_TIMEOUT_S
  }

  /** 不等网络。已在跑就什么都不做;401 停下之后再调可以重新开始 */
  start(): void {
    if (this.ctl) return
    const ctl = new AbortController()
    this.ctl = ctl
    this.reported = undefined
    this.failures = 0
    this.identified = false
    this.recovering = false
    this.report('starting')
    this.done = this.run(ctl.signal).finally(() => {
      if (this.ctl !== ctl) return
      this.ctl = undefined
      this.done = undefined
    })
  }

  /** 中止轮询和退避。正在跑的 onBatch 打断不了:最多等 500 ms,它结束后这批照样落盘,不再发请求 */
  async stop(): Promise<void> {
    const { ctl, done } = this
    this.ctl = undefined
    this.done = undefined
    ctl?.abort()
    if (!done) return
    let timer: NodeJS.Timeout | undefined
    await Promise.race([done, new Promise<void>(resolve => (timer = setTimeout(resolve, STOP_BOUND_MS).unref()))])
    clearTimeout(timer)
  }

  private async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        if (this.identified || (await this.identify(signal))) await this.pollOnce(signal)
      } catch (err) {
        if (!(await this.handleFailure(err, signal))) return
      }
    }
  }

  private async identify(signal: AbortSignal): Promise<boolean> {
    const me = await this.o.api.call<{ id?: unknown; username?: unknown } | null>('getMe', {}, { signal })
    if (typeof me?.id !== 'number' || !Number.isSafeInteger(me.id)) throw new TelegramError('server')
    const changed = this.o.state.adoptBot({ id: me.id, ...(typeof me.username === 'string' && { username: me.username }) })
    if (changed && !this.persist()) {
      await this.pause(this.nextBackoff(), signal)
      return false
    }
    this.identified = true
    this.succeeded()
    return true
  }

  private async pollOnce(signal: AbortSignal): Promise<void> {
    const { state, api } = this.o
    if (this.isIdle()) this.omitOffset = true
    const ack = state.ackOffset
    const result = await api.call<unknown>(
      'getUpdates',
      {
        timeout: this.recovering ? 0 : this.pollTimeoutS,
        limit: BATCH_LIMIT,
        allowed_updates: ALLOWED_UPDATES,
        ...(!this.omitOffset && ack > 0 && { offset: ack }),
      },
      { signal, timeoutMs: (this.pollTimeoutS + ABORT_MARGIN_S) * 1000 },
    )
    if (!Array.isArray(result)) throw new TelegramError('server')
    this.recovering = false
    this.succeeded()

    if (this.omitOffset && !this.idleReset && result.length > 0) {
      state.data.offset = 0
      this.idleReset = true
    }
    const identified = result.filter(isIdentified)
    state.data.dropped.badUpdate += result.length - identified.length
    // 落盘失败时的重投也走这里:内存里已处理过的不再处理
    const fresh = identified.filter(u => u.update_id >= state.data.offset)
    if (fresh.length > 0) {
      await this.deliver(fresh)
      state.data.lastUpdateAt = this.o.now()
    }

    if (identified.length < result.length || fresh.length > 0 || state.data.offset !== state.ackOffset) {
      if (this.persist()) {
        this.omitOffset = false
        this.idleReset = false
      } else {
        await this.pause(this.nextBackoff(), signal)
      }
    } else if (result.length > 0) {
      // 没有任何进展却立刻回来了:服务器在重发已确认的,不空转
      await this.pause(this.nextBackoff(), signal)
    }
  }

  private isIdle(): boolean {
    const { offset, lastUpdateAt } = this.o.state.data
    return offset > 0 && (lastUpdateAt === undefined || this.o.now() - lastUpdateAt >= ID_RESET_IDLE_MS)
  }

  /** onBatch 不该抛。真抛了:卡住的第一条算毒更新跳过,没处理的下次重投,队列不被一条卡死 */
  private async deliver(fresh: IdentifiedUpdate[]): Promise<void> {
    const { state } = this.o
    try {
      await this.o.onBatch(fresh)
      for (const u of fresh) state.advance(u.update_id)
    } catch (err) {
      this.o.log?.warn('telegram batch failed', { code: codeOf(err) })
      const stuck = fresh.find(u => u.update_id >= state.data.offset)
      if (stuck) {
        state.advance(stuck.update_id)
        state.data.dropped.badUpdate++
      }
    }
  }

  private persist(): boolean {
    const { state } = this.o
    try {
      state.save()
    } catch (err) {
      this.o.log?.warn('telegram state save failed', { code: codeOf(err) })
      if (!state.problems.includes(SAVE_FAILED)) state.problems.push(SAVE_FAILED)
      return false
    }
    const at = state.problems.indexOf(SAVE_FAILED)
    if (at >= 0) state.problems.splice(at, 1)
    return true
  }

  /** 返回循环还要不要继续 */
  private async handleFailure(err: unknown, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return false
    const code = codeOf(err)
    this.o.log?.warn('telegram poll failed', { code })
    this.recovering = true
    if (code === 'unauthorized') {
      this.report('unauthorized')
      return false
    }
    if (code === 'conflict_webhook' || code === 'conflict_other') {
      this.report('conflict', code === 'conflict_webhook' ? 'webhook' : 'other_poller')
      await this.pause(CONFLICT_RETRY_MS, signal)
    } else if (code === 'rate_limited') {
      const retryAfter = (err as TelegramError).retryAfter
      await this.pause(retryAfter === undefined ? this.nextBackoff() : Math.min(retryAfter * 1000, RETRY_AFTER_MAX_MS), signal)
    } else {
      this.report('reconnecting', code)
      await this.pause(this.nextBackoff(), signal)
    }
    return !signal.aborted
  }

  private succeeded(): void {
    this.failures = 0
    this.lastOkAt = this.o.now()
    this.report('online')
  }

  private nextBackoff(): number {
    const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** this.failures)
    this.failures++
    return base * (1 + JITTER * (2 * this.o.random() - 1))
  }

  /** sleep 或 stop,先到的算 */
  private pause(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>(resolve => {
      if (signal.aborted) return resolve()
      const finish = () => {
        signal.removeEventListener('abort', finish)
        resolve()
      }
      signal.addEventListener('abort', finish)
      void this.o.sleep(ms).then(finish, finish)
    })
  }

  /** 状态变了才通知。监听器的错不打断轮询 */
  private report(s: PollerState, reason?: string): void {
    const key = `${s}:${reason ?? ''}`
    if (key === this.reported) return
    this.reported = key
    try {
      this.o.onState(s, reason)
    } catch (err) {
      this.o.log?.warn('telegram state listener failed', { code: codeOf(err) })
    }
  }
}

/** 只有稳定代码进日志:别的错的 message 里可能有消息内容 */
function codeOf(err: unknown): string {
  if (err instanceof TelegramError) return err.code
  const code = (err as NodeJS.ErrnoException | null | undefined)?.code
  return typeof code === 'string' && /^[A-Za-z_]{1,32}$/.test(code) ? code : 'internal'
}

// 配对码(07 spec §6):只从 app 出到 IM。码只以加盐哈希留在内存,重启作废;发送者的失败次数落盘
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import type { TelegramState } from './state'

/** Crockford base32:没有 I、L、O、U */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const CODE_LENGTH = 8
const CODE_TTL_MS = 5 * 60_000
/** date 是秒,时钟也可能差一点;旧消息里不可能有新码,放宽无害(R17) */
const DATE_SLACK_S = 120
const SENDER_WRONG_MAX = 3
const SENDER_LOCK_MS = 3_600_000
const CODE_WRONG_MAX = 10
const SENDERS_MAX = 1000
const REPLY_WINDOW_MS = 3_600_000
const REPLIES_PER_SENDER = 3
const REPLIES_GLOBAL = 30
/** 结构是列表,放开只改这个常量 */
export const MAX_PAIRED = 1

export class PairingError extends Error {
  constructor(readonly code: 'full') {
    super(code)
  }
}

export type AttemptResult = 'ok' | 'invalid' | 'locked'

interface ActiveCode {
  salt: Buffer
  hash: Buffer
  issuedAt: number
  expiresAt: number
  wrong: number
  botId: number | undefined
}

export interface PairingOpts {
  state: TelegramState
  now(): number
  onBurned(): void
}

const digest = (salt: Buffer, code: string) => createHash('sha256').update(salt).update(code).digest()

/** 大小写、连字符、空白都不算;Crockford 的 O、I、L 读成数字 */
const normalize = (raw: string) => raw.toUpperCase().replace(/[-\s]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1')

export class Pairing {
  /** 不可枚举:对象被序列化或打印也带不出去 */
  declare private active: ActiveCode | undefined
  private replies = new Map<string, number[]>()
  private repliesGlobal: number[] = []

  constructor(private readonly o: PairingOpts) {
    Object.defineProperty(this, 'active', { value: undefined, writable: true, enumerable: false })
  }

  /** 已经有配对账号时抛 PairingError('full');新的作废旧的 */
  begin(): { code: string; expiresAt: number } {
    if (this.o.state.data.pairings.length >= MAX_PAIRED) throw new PairingError('full')
    let code = ''
    for (let i = 0; i < CODE_LENGTH; i++) code += ALPHABET[randomInt(ALPHABET.length)]
    const salt = randomBytes(16)
    const issuedAt = this.o.now()
    const expiresAt = issuedAt + CODE_TTL_MS
    this.active = { salt, hash: digest(salt, code), issuedAt, expiresAt, wrong: 0, botId: this.o.state.data.bot?.id }
    return { code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt }
  }

  cancel(): void {
    this.active = undefined
  }

  status(): { active: boolean; expiresAt?: number } {
    const a = this.live()
    return a ? { active: true, expiresAt: a.expiresAt } : { active: false }
  }

  /** 码已发出且还有效。过期、机器人换了、已经有人配对了:都是没有码 */
  private live(): ActiveCode | undefined {
    const a = this.active
    if (!a) return undefined
    const { state } = this.o
    if (this.o.now() >= a.expiresAt || a.botId !== state.data.bot?.id || state.data.pairings.length >= MAX_PAIRED) {
      this.active = undefined
      return undefined
    }
    return a
  }

  /**
   * 没有码、消息早于出码时间:不计数。这些猜测猜不中任何东西,记下来只会让陌生人能写 state,
   * 让积压的旧消息把新码作废。回话都是同一句,外面看不出区别
   */
  attempt(senderId: string, code: string, messageDate: number): AttemptResult {
    const { senders } = this.o.state.data
    const now = this.o.now()
    const record = senders[senderId]
    if (record?.lockedUntil !== undefined) {
      if (record.lockedUntil > now) return 'locked'
      delete senders[senderId]
    }
    const a = this.live()
    if (!a || messageDate < Math.floor(a.issuedAt / 1000) - DATE_SLACK_S) return 'invalid'
    if (timingSafeEqual(digest(a.salt, normalize(code)), a.hash)) {
      this.active = undefined
      delete senders[senderId]
      return 'ok'
    }
    this.countWrong(senderId, now)
    if (++a.wrong >= CODE_WRONG_MAX) {
      this.active = undefined
      this.o.onBurned()
    }
    return 'invalid'
  }

  private countWrong(senderId: string, now: number): void {
    const { senders } = this.o.state.data
    // 三个月前的两次手误不该和今天这次凑成一把锁
    const prior = senders[senderId]
    const recent = prior?.at !== undefined && now - prior.at < SENDER_LOCK_MS
    const wrong = (recent ? prior.wrong : 0) + 1
    senders[senderId] = { wrong, at: now, ...(wrong >= SENDER_WRONG_MAX && { lockedUntil: now + SENDER_LOCK_MS }) }
    const ids = Object.keys(senders)
    if (ids.length <= SENDERS_MAX) return
    // 数字键在对象里按大小排,不是插入顺序,所以要比 at
    const oldest = ids.reduce((best, id) => ((senders[id].at ?? 0) < (senders[best].at ?? 0) ? id : best))
    delete senders[oldest]
  }

  /** 那句话还能不能回:每发送者每小时 3 次,全局 30 次。回不了的不占名额,记录量因此也不超过 30 */
  replyAllowed(senderId: string): boolean {
    const since = this.o.now() - REPLY_WINDOW_MS
    this.repliesGlobal = this.repliesGlobal.filter(t => t > since)
    for (const [id, times] of this.replies) {
      const kept = times.filter(t => t > since)
      if (kept.length === 0) this.replies.delete(id)
      else this.replies.set(id, kept)
    }
    const mine = this.replies.get(senderId) ?? []
    if (mine.length >= REPLIES_PER_SENDER || this.repliesGlobal.length >= REPLIES_GLOBAL) return false
    const now = this.o.now()
    this.replies.set(senderId, [...mine, now])
    this.repliesGlobal.push(now)
    return true
  }
}

export interface PairCommand {
  command: 'pair' | 'start'
  code?: string
}

/** /pair、/start,带不带 @机器人 都行;不带码的不算尝试 */
export function parsePairCommand(text: string): PairCommand | undefined {
  const m = /^\/(pair|start)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(text.trim())
  if (!m) return undefined
  const code = m[2]?.trim()
  return { command: m[1] as PairCommand['command'], ...(code && { code }) }
}

// 审批卡片(07 spec §10):一个按钮只批一次审批,只有配对账号按得动。卡片是注入的最后防线:
// 模型写的命令就是卡片的正文,所以看不全、看到的和要跑的可能不同时,一律只给 拒绝。失败方向都是关:卡片没发到,审批按超时拒绝。
// onRequested、onResolved 在别人的写入路径上同步跑,只记下来;写行、发送、改卡片都在定时器里
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import type { Approvals } from '../../kernel/approvals'
import type { Logger } from '../../kernel/log'
import { sanitizeLine } from '../../lib/memory/wrap'
import { cleanText, clip, CLIP_MARK, SUMMARY_CLIP_MARK } from '../../lib/tools/diagnostics'
import type { SandboxService } from '../../lib/tools/types'
import { ApprovalRequestedPayloadSchema, ApprovalResolvedPayloadSchema, type KernelEvent, type SandboxStatus } from '../../protocol/index'
import type { ApiTimers } from './api'
import type { Inbound } from './inbound'
import type { Entity } from './markdown'
import { codeOf } from './poller'
import type { Sender } from './sender'
import type { TelegramState } from './state'

export type Choice = 'y' | 's' | 'n'

const RowSchema = z.object({
  nonce: z.string(),
  chatId: z.string(),
  messageId: z.number().optional(),
  approvalId: z.string(),
  choices: z.array(z.enum(['y', 's', 'n'])),
})
type CardRow = z.infer<typeof RowSchema>

const NONCE_BYTES = 12
/** 改过的客户端能发任意 callback_data:只认这一种形状 */
const CALLBACK_DATA = /^a:([A-Za-z0-9_-]{16}):([ysn])$/
const DECISION = { y: 'allow', s: 'allow_session', n: 'deny' } as const
const BUTTON_LABEL = { y: '允许', s: '本会话允许', n: '拒绝' } as const
const STALE = '已失效'
const MASK = '***'
/** 一行里超过这么多个连续空白写成个数:否则能把后半段推出屏幕(R20) */
const BLANK_RUN_SHOWN = 8
/** 再多一屏就放不下,按钮旁边看到的只是结尾 */
const LINES_MAX = 40
/** 上限 4096;制表符写成个数之后会变长,摘要的 2000 字不是正文的上限 */
const BODY_MAX = 3000
const TOOL_MAX = 64
const NOT_WELL_FORMED = /\p{Cs}/gu

/**
 * cleanText 不动、看起来却是别的东西的:不换行空格这类像空格而不是空格(shell 当成普通字符),盲文空白看起来什么都没有,半个代理对发不出去
 */
const LOOKS_LIKE_SOMETHING_ELSE = /[^\S \t\n]|⠀|\p{Cs}/u

export interface CardView {
  /** 改卡片时第一行和命令块还用这两个 */
  tool: string
  body: string
  text: string
  entities: Entity[]
  choices: Choice[]
}

type CardInput = { tool: string; summary: string; key?: string | undefined; unsandboxed?: boolean | undefined }

/** 只改显示,不改含义:空白行压成一行,长串空白写成个数,制表符多宽由客户端说了算所以也写成个数 */
function compactBlanks(s: string): string {
  const lines: string[] = []
  for (const raw of s.split('\n')) {
    const line = raw.trim() === '' ? '' : raw.replace(/[^\S\n]+/g, run => (run.length > BLANK_RUN_SHOWN || /[^ ]/.test(run) ? `⟨${run.length} 空格⟩` : run))
    if (line === '' && (lines.length === 0 || lines.at(-1) === '')) continue
    lines.push(line)
  }
  if (lines.at(-1) === '') lines.pop()
  return lines.join('\n')
}

function framed(first: string, body: string, rest: readonly string[]): { text: string; entities: Entity[] } {
  const head = `${first}\n`
  return { text: [head + body, ...rest].join('\n'), entities: [{ type: 'pre', offset: head.length, length: body.length }] }
}

/** 纯函数。mask 是出站打码:scrub 加令牌字面值 */
export function buildCard(p: CardInput, o: { mask(s: string): string; level: SandboxStatus['level'] }): CardView {
  const { summary, key } = p
  const clean = cleanText(summary)
  const shown = o.mask(clean)
  const compact = compactBlanks(shown).replace(NOT_WELL_FORMED, '�')
  const cut = compact.length > BODY_MAX
  const body = (cut ? clip(compact, BODY_MAX) : compact) || '(空)'
  const lineCount = compact.split('\n').length

  const flags: string[] = []
  // 有这个记号就算截断过:模型把它写进短命令,结果只是少按钮
  if (cut || summary.includes(SUMMARY_CLIP_MARK) || summary.includes(CLIP_MARK)) flags.push('中间已截断')
  if (clean !== summary || LOOKS_LIKE_SOMETHING_ELSE.test(summary)) flags.push('含不可见字符')
  // 打码的模式能盖住任何东西:没有 END 的私钥头盖到结尾,Cookie: 盖到行尾,password=$(…) 盖住一段命令。摘要进事件前已经打过一次,只能从记号看出来
  if (shown !== clean || summary.includes(MASK)) flags.push('含已打码内容')
  if (lineCount > LINES_MAX) flags.push(`共 ${lineCount} 行`)

  const judgeable = flags.length === 0 && compact !== ''
  const scoped = judgeable && key !== undefined && p.unsandboxed !== true && o.level === 'full' && sanitizeLine(key) === key && o.mask(key) === key && !key.includes(MASK)

  const tool = [...sanitizeLine(o.mask(p.tool))].slice(0, TOOL_MAX).join('') || 'unknown'
  const header = `需要批准 · ${tool}${p.unsandboxed === true ? ' · 未隔离' : ''}`
  const rest = [...flags, ...(scoped ? [`本会话放行范围:${key}`] : [])]
  return { tool, body, ...framed(header, body, rest), choices: [...(judgeable ? (['y'] as const) : []), ...(scoped ? (['s'] as const) : []), 'n'] }
}

export interface CardsOpts {
  state: Pick<TelegramState, 'data'>
  sender: Pick<Sender, 'send' | 'edit' | 'fire'>
  approvals: Pick<Approvals, 'respond'>
  sandbox: Pick<SandboxService, 'status'>
  /** 现查当前名单 */
  isPaired(accountId: string, chatId: string | undefined): boolean
  /** 渠道开着、有令牌。关着时一个请求都不发 */
  active(): boolean
  mask(s: string): string
  timers: ApiTimers
  save(): boolean
  log: Logger
}

interface Waiting {
  approvalId: string
  sessionId: string
  chatId: string
  payload: CardInput
}

interface OpenCard {
  row: CardRow
  sessionId: string
  tool: string
  body: string
  /** 发送还没回来:还不知道 messageId */
  sending: boolean
  pressed?: Choice
  /** 审批结束了,卡片要改成这样 */
  outcome?: string
  /** 撤销或重启:整张卡只留一句 */
  expired: boolean
}

export class Cards {
  /** 只有这里的 nonce 算数,这张表不落盘:state.json 里的行只是为了下次启动能把卡片改成已失效 */
  private readonly open = new Map<string, OpenCard>()
  private readonly waiting: Waiting[] = []
  private readonly finished: OpenCard[] = []
  private timer: unknown
  private started = false
  private disposed = false

  constructor(private readonly o: CardsOpts) {}

  // —— onAppend 这条路:不做 I/O

  onRequested(e: KernelEvent, chatId: string): void {
    if (this.disposed) return
    const parsed = ApprovalRequestedPayloadSchema.safeParse(e.payload)
    if (!parsed.success || !e.sessionId) {
      // 没有卡片就是超时拒绝
      this.o.log.warn('telegram approval event unreadable')
      return
    }
    const { approvalId, tool, summary, key, unsandboxed } = parsed.data
    this.waiting.push({ approvalId, sessionId: e.sessionId, chatId, payload: { tool, summary, key, unsandboxed } })
    this.schedule()
  }

  onResolved(e: KernelEvent): void {
    if (this.disposed) return
    const parsed = ApprovalResolvedPayloadSchema.safeParse(e.payload)
    if (!parsed.success) return
    const { approvalId, decision, by } = parsed.data
    const at = this.waiting.findIndex(w => w.approvalId === approvalId)
    if (at >= 0) {
      this.waiting.splice(at, 1)
      return
    }
    // by:'session' 没有 requested,没有卡
    for (const card of this.open.values()) {
      if (card.row.approvalId !== approvalId || card.outcome !== undefined) continue
      this.finish(card, decision === 'allow' ? this.allowedLabel(card.pressed) : by === 'timeout' ? '已超时,已拒绝' : by === 'cancel' ? '已取消' : '已拒绝')
      return
    }
  }

  // —— 轮询这条路

  /** 陌生人一个请求都不发(R16);配对账号每次都有回答 */
  onCallback(i: Inbound & { kind: 'callback' }): void {
    if (!this.o.isPaired(i.accountId, i.chatId)) return
    let answer: string | undefined
    try {
      answer = this.press(i)
    } catch (err) {
      this.o.log.warn('telegram callback failed', { code: codeOf(err) })
    }
    this.o.sender.fire('answerCallbackQuery', { callback_query_id: i.callbackId, text: answer ?? STALE })
  }

  /** §10 的五条。前四条不成立时什么都不改,这张卡还是好的:改过的客户端不能白白用掉别人的卡 */
  private press(i: Inbound & { kind: 'callback' }): string | undefined {
    const match = CALLBACK_DATA.exec(i.data)
    if (!match) return undefined
    const card = this.open.get(match[1]!)
    const choice = match[2] as Choice
    if (!card || card.outcome !== undefined) return undefined
    const { row } = card
    // 换了机器人时行已经没了
    if (!this.o.state.data.cards.includes(row)) return undefined
    // 发送还没回来时没有 messageId:按过期算
    if (row.chatId !== i.chatId || row.messageId === undefined || row.messageId !== i.messageId) return undefined
    if (!row.choices.includes(choice)) return undefined
    // 卡片发出去之后级别可能掉了
    if (choice === 's' && this.levelOf(card.sessionId) !== 'full') return undefined
    card.pressed = choice
    // respond 同步写 resolved,onResolved 在这一步里就到了
    const accepted = this.o.approvals.respond(row.approvalId, DECISION[choice], `telegram:${i.accountId}`)
    if (!accepted) {
      if (card.outcome === undefined) this.finish(card, STALE)
      return undefined
    }
    if (card.outcome === undefined) this.finish(card, choice === 'n' ? '已拒绝' : this.allowedLabel(choice))
    return card.outcome
  }

  // —— 生命周期

  /** 撤销和换令牌时:所有 nonce 立刻作废,卡片改成已失效。还没发的不发了,正在发的回来时改 */
  expireAll(): void {
    this.waiting.length = 0
    this.finished.length = 0
    for (const card of this.open.values()) {
      card.expired = true
      card.outcome ??= STALE
      if (!card.sending) this.open.delete(card.row.nonce)
    }
    this.dropRows(row => !this.open.has(row.nonce))
  }

  /** 渠道开着了。第一次是激活:上个进程留下的行都失效,它们的审批已经不存在了(§10) */
  resume(): void {
    if (this.disposed) return
    if (!this.started) {
      this.started = true
      this.dropRows(row => !this.open.has(row.nonce))
    }
    this.schedule()
  }

  /** 换了机器人:旧机器人的消息改不了,状态里的行 adoptBot 已经清了 */
  forget(): void {
    this.waiting.length = 0
    this.finished.length = 0
    for (const card of this.open.values()) {
      card.outcome ??= STALE
    }
    this.open.clear()
  }

  /** 关闭前:结果交给发送器(之后它还冲刷一下)。行都留着,发不出去也好,下次启动再改一遍 */
  dispose(): void {
    if (this.disposed) return
    this.o.timers.clearTimeout(this.timer)
    this.timer = undefined
    if (this.o.active()) for (const card of this.finished) if (card.row.messageId !== undefined) this.editFinal(card)
    this.waiting.length = 0
    this.finished.length = 0
    this.disposed = true
  }

  // —— 定时器

  private schedule(): void {
    if (this.disposed || this.timer !== undefined) return
    this.timer = this.o.timers.setTimeout(() => {
      this.timer = undefined
      try {
        this.flush()
      } catch (err) {
        this.o.log.warn('telegram cards failed', { code: codeOf(err) })
      }
    }, 0)
  }

  private flush(): void {
    if (this.disposed || !this.o.active()) return
    for (const w of this.waiting.splice(0)) this.openCard(w)
    for (const card of this.finished.splice(0)) this.close(card)
  }

  /** 先写行再发:没有 nonce 就没有行,崩溃时行比消息多,反过来就有一张下次启动改不掉的卡 */
  private openCard(w: Waiting): void {
    if (!this.o.isPaired(w.chatId, w.chatId)) return
    const view = buildCard(w.payload, { mask: this.o.mask, level: this.levelOf(w.sessionId) })
    const nonce = randomBytes(NONCE_BYTES).toString('base64url')
    const row: CardRow = { nonce, chatId: w.chatId, approvalId: w.approvalId, choices: view.choices }
    const card: OpenCard = { row, sessionId: w.sessionId, tool: view.tool, body: view.body, sending: true, expired: false }
    this.o.state.data.cards.push(row)
    this.open.set(nonce, card)
    this.o.save()
    const keyboard = { inline_keyboard: [view.choices.map(c => ({ text: BUTTON_LABEL[c], callback_data: `a:${nonce}:${c}` }))] }
    void this.o.sender
      .send(w.chatId, { text: view.text, entities: view.entities, keyboard }, { retryWhile: () => card.outcome === undefined && !this.disposed })
      .then(id => this.onSent(card, id))
      .catch((err: unknown) => this.o.log.warn('telegram card failed', { code: codeOf(err) }))
  }

  private onSent(card: OpenCard, id: number | undefined): void {
    card.sending = false
    // 关了:行留给下次启动。换了机器人:行已经没了,这条也改不了
    if (this.disposed || !this.o.state.data.cards.includes(card.row)) {
      this.open.delete(card.row.nonce)
      return
    }
    if (id === undefined) {
      // 放弃了:审批等它自己超时,失败方向是关
      this.remove(card)
      this.o.save()
      return
    }
    card.row.messageId = id
    this.o.save()
    if (card.outcome !== undefined) this.close(card)
  }

  private finish(card: OpenCard, outcome: string): void {
    card.outcome = outcome
    this.finished.push(card)
    this.schedule()
  }

  /** 卡片的最后一步。发送还没回来时什么都不做,onSent 会再来 */
  private close(card: OpenCard): void {
    if (card.sending) return
    if (card.row.messageId !== undefined) this.editFinal(card)
    this.remove(card)
    this.o.save()
  }

  /** 不带 reply_markup:按钮就没了 */
  private editFinal(card: OpenCard): void {
    const { messageId, chatId } = card.row
    if (messageId === undefined) return
    if (card.expired) this.o.sender.edit(chatId, messageId, { text: STALE })
    else this.o.sender.edit(chatId, messageId, framed(`${card.outcome ?? STALE} · ${card.tool}`, card.body, []))
  }

  private remove(card: OpenCard): void {
    this.open.delete(card.row.nonce)
    const rows = this.o.state.data.cards
    const at = rows.indexOf(card.row)
    if (at >= 0) rows.splice(at, 1)
  }

  /** 这些行的卡片改成已失效,行删掉;看不懂的行也删掉 */
  private dropRows(dead: (row: CardRow) => boolean): void {
    const kept: unknown[] = []
    for (const raw of this.o.state.data.cards) {
      const parsed = RowSchema.safeParse(raw)
      if (!parsed.success) continue
      if (!dead(parsed.data)) {
        kept.push(raw)
        continue
      }
      if (parsed.data.messageId !== undefined) this.o.sender.edit(parsed.data.chatId, parsed.data.messageId, { text: STALE })
    }
    if (kept.length !== this.o.state.data.cards.length) {
      this.o.state.data.cards = kept
      this.o.save()
    }
  }

  private allowedLabel(pressed: Choice | undefined): string {
    return pressed === 's' ? '本会话已允许' : '已允许'
  }

  /** 问不到就当没有隔离 */
  private levelOf(sessionId: string): SandboxStatus['level'] {
    try {
      return this.o.sandbox.status(sessionId).level
    } catch (err) {
      this.o.log.warn('telegram sandbox status failed', { code: codeOf(err) })
      return 'none'
    }
  }
}

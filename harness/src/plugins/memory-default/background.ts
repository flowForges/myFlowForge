// 后台模型、预算、额度和单并发队列(06 spec §13)。这里管用户账号上的花费:
// 拿不准就不调用,任何一道闸判不了都按"不花钱"处理
import type { Logger } from '../../kernel/log'
import type { MemoryConfig } from '../../lib/memory/types'
import type { ModelError, ModelEvent, ModelsService, Quota } from '../../lib/models/types'
import type { AccountView, ModelEntry, ModelRef, PresetView } from '../../protocol/models'
import type { Store } from './store'

const MIN_CONTEXT = 16_000
/** spec §12:一次后台调用最多 120 s,额度读取也算在里面 */
const TIMEOUT_MS = 120_000
const QUEUE_MAX = 8
/** 整个任务的上限:任务卡在 text 以外的地方时,队列不能跟着卡死 */
const JOB_TIMEOUT_MS = 600_000
/** 中止之后留给任务收尾的时间,超过就不等了 */
const CLOSE_GRACE_MS = 5000
/** 额度读不到的账号,吃的是用户前台的额度而且看不见 */
const BLIND_TOKENS = 100_000
const QUOTA_LOW_PERCENT = 75
const UNPRICED = { input: 10, output: 10 }
const CHARS_PER_TOKEN = 3.5
/** 中日韩文字一个字约 1 到 2 个 token,按 3.5 字符一个算会少算好几倍 */
const TOKENS_PER_CJK = 1.5
const CJK = /[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef\u{20000}-\u{3ffff}]/gu
/** 上限:调用方传多大都只预留、只发这么多 */
const MAX_OUTPUT = 4096
/** 不理 maxOutput 的流在这里截断:估算值比 maxOutput 多出这么多倍,就不是估算的误差了 */
const OUTPUT_OVERRUN = 2.5
/** 全是微任务的流会饿死定时器,隔一段让一次事件循环 */
const YIELD_EVERY = 256
/** health 不能被一次卡住的额度读取拖住 */
const STATUS_QUOTA_MS = 2000
const BUDGET = 'budget:'
/** 供应商明确拒收的错误,没有内容也没有用量就没花钱;其他错误可能已经算过钱 */
const REFUSED: ReadonlySet<ModelError['kind']> = new Set(['auth', 'quota', 'restricted', 'bad_request', 'rate_limit'])
// 前面不能是字母:否则 gemini 算 mini,elite 算 lite
const CHEAP_ID = /(?:^|[^a-z])(?:mini|lite|flash|haiku|nano|small|spark)/i

type ModelsView = Pick<ModelsService, 'catalog' | 'accounts'>
export type BackgroundNone = 'no_model' | 'restricted' | 'unknown_subscription'

function accountOf(models: ModelsView, accountId: string): { account: AccountView; preset: PresetView; list: ModelEntry[] } | undefined {
  const account = models.accounts().find(a => a.id === accountId)
  if (!account) return undefined
  const catalog = models.catalog()
  const preset = catalog.presets.find(p => p.id === account.presetId)
  if (!preset) return undefined
  // 和 registry 的 modelsOf 同样的优先级
  const listed = catalog.models[account.presetId]
  return { account, preset, list: listed?.length ? listed : (account.models ?? []) }
}

export function pickBackground(models: ModelsView, cfg: MemoryConfig, sessionRef?: ModelRef): { ref: ModelRef } | { none: BackgroundNone } {
  if (cfg.backgroundModel) {
    const explicit = accountOf(models, cfg.backgroundModel.accountId)
    if (!explicit) return { none: 'no_model' }
    if (explicit.preset.restriction === 'coding-tools-only') return { none: 'restricted' }
    return { ref: cfg.backgroundModel }
  }
  // 不跨账号:对话不悄悄发给另一家
  const base = sessionRef ?? models.catalog().default
  if (!base) return { none: 'no_model' }
  const account = accountOf(models, base.accountId)
  if (!account) return { none: 'no_model' }
  const { preset, list } = account
  if (preset.restriction === 'coding-tools-only') return { none: 'restricted' }
  if (preset.restriction === 'unknown' && preset.billing !== 'metered') return { none: 'unknown_subscription' }

  const usable = (m: ModelEntry) => !m.deprecated && m.context >= MIN_CONTEXT
  const candidates = list.filter(usable)
  const costOf = (m: ModelEntry) => m.cost?.input ?? Infinity
  const cheapest = candidates.filter(m => m.cost).sort((a, b) => costOf(a) - costOf(b))[0]
  const chosen = cheapest ?? candidates.find(m => CHEAP_ID.test(m.id))
  if (chosen) return { ref: { accountId: base.accountId, modelId: chosen.id } }
  const current = list.find(m => m.id === base.modelId)
  return current && !usable(current) ? { none: 'no_model' } : { ref: base }
}

export type BackgroundReason = 'budget' | 'quota_low' | 'account_out' | 'restricted' | 'timeout' | 'error' | 'aborted' | 'length'
export type BackgroundText = { ok: true; text: string; tokens: number; model: string; usd: number } | { ok: false; reason: BackgroundReason }

export interface BackgroundRun {
  /** 过完所有闸才发:interactive:false、无工具、reasoning:'off'。不抛错 */
  text(ref: ModelRef, req: { system: string; prompt: string; maxOutput: number }): Promise<BackgroundText>
}

export interface BackgroundStatus {
  backgroundModel?: ModelRef
  budget: { tokens: number; usd: number; tokensLimit: number; usdLimit: number }
  /** memory.health 的稳定代码 */
  problem?: string
}

export interface BackgroundOpts {
  models: () => ModelsService | undefined
  config(): MemoryConfig
  store: Store
  now(): number
  log: Logger
  timeoutMs?: number
  jobTimeoutMs?: number
  closeGraceMs?: number
}

type Job = (run: BackgroundRun) => Promise<void> | void
type TextReq = Parameters<BackgroundRun['text']>[1]

/** 今天的花费和不再试的账号。一天一条,存在 meta */
interface Ledger {
  tokens: number
  usd: number
  out: string[]
}

const no = (reason: BackgroundReason): BackgroundText => ({ ok: false, reason })
/** 没取整:流式的时候一段一段累加 */
function estimate(text: string): number {
  const cjk = text.match(CJK)?.length ?? 0
  return cjk * TOKENS_PER_CJK + (text.length - cjk) / CHARS_PER_TOKEN
}
const spendable = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0
const dollars = (cost: { input: number; output: number }, input: number, output: number) => (input * cost.input + output * cost.output) / 1e6

/** 本地日期:预算过的是用户的午夜 */
export function dateKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** undefined = 坏了。坏账本判不了还剩多少,当作没有预算 */
function parseLedger(raw: string | undefined): Ledger | undefined {
  if (raw === undefined) return { tokens: 0, usd: 0, out: [] }
  try {
    const v = JSON.parse(raw) as Partial<Ledger> | null
    if (!v || !spendable(v.tokens) || !spendable(v.usd)) return undefined
    if (!Array.isArray(v.out) || !v.out.every(a => typeof a === 'string')) return undefined
    return { tokens: v.tokens, usd: v.usd, out: v.out }
  } catch {
    return undefined
  }
}

/** low:别调。blind:看不见额度,只靠压低的预算。seen:看得见,还够 */
function assessQuota(quota: Quota | null): 'low' | 'blind' | 'seen' {
  if (quota === null || 'link' in quota) return 'blind'
  if (!Array.isArray(quota.windows)) return 'low'
  if (quota.windows.length === 0) return 'blind'
  return quota.windows.every(w => Number.isFinite(w.usedPercent) && w.usedPercent < QUOTA_LOW_PERCENT) ? 'seen' : 'low'
}

/** 一次调用的停止信号:超时、关闭和截断都走这里 */
class CallGate {
  readonly controller = new AbortController()
  stop: 'timeout' | 'aborted' | 'length' | undefined
  readonly stopped: Promise<undefined>
  private resolve!: (v: undefined) => void
  constructor() {
    this.stopped = new Promise(r => (this.resolve = r))
  }
  halt(why: 'timeout' | 'aborted' | 'length') {
    if (this.stop) return
    this.stop = why
    this.controller.abort()
    this.resolve(undefined)
  }
}

interface Fenced {
  entry: ModelEntry | undefined
  metered: boolean
}

interface Slot {
  abort: AbortController
  done: Promise<void>
}

export class Background {
  private readonly queue: Job[] = []
  private active: Slot | undefined
  private closed = false
  /** 这一天的账本写失败过:记不了账就不再花 */
  private brokenDay: string | undefined

  constructor(private readonly o: BackgroundOpts) {}

  /** 一次一个,队列满了丢新的。不抛错,也不等任务开始 */
  enqueue(job: Job): boolean {
    if (this.closed || this.queue.length >= QUEUE_MAX) return false
    this.queue.push(job)
    this.pump()
    return true
  }

  /** 中止,等跑着的任务结束,最多等 closeGraceMs。之后才能关库 */
  async close(): Promise<void> {
    this.closed = true
    this.queue.length = 0
    this.active?.abort.abort()
    await this.active?.done
  }

  /** 给 memory.health:读账本,不花钱,卡住的额度读取最多等一小会 */
  async status(): Promise<BackgroundStatus> {
    const cfg = this.o.config()
    let tokensLimit = cfg.tokensPerDay
    let backgroundModel: ModelRef | undefined
    let problem: string | undefined
    try {
      const models = this.o.models()
      const pick = models && pickBackground(models, cfg)
      if (models && pick) {
        if ('ref' in pick) {
          backgroundModel = pick.ref
          if ((await this.quotaBriefly(models, pick.ref.accountId)) === 'blind') tokensLimit = Math.min(tokensLimit, BLIND_TOKENS)
        } else if (cfg.backgroundModel) {
          problem = `background_model:${pick.none}`
        }
      }
    } catch {
      problem = 'background_model:error'
    }
    const day = dateKey(this.o.now())
    let ledger: Ledger | undefined
    try {
      ledger = parseLedger(this.o.store.getMeta(BUDGET + day))
      if (!ledger) problem ??= 'budget_ledger_damaged'
    } catch {
      problem ??= 'budget_ledger_unreadable'
    }
    if (this.brokenDay === day) problem ??= 'budget_ledger_unwritable'
    return {
      ...(backgroundModel && { backgroundModel }),
      budget: { tokens: ledger?.tokens ?? 0, usd: ledger?.usd ?? 0, tokensLimit, usdLimit: cfg.usdPerDay },
      ...(problem && { problem }),
    }
  }

  private async quotaBriefly(models: ModelsService, accountId: string): Promise<'low' | 'blind' | 'seen'> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const late = new Promise<'late'>(r => (timer = setTimeout(() => r('late'), Math.min(STATUS_QUOTA_MS, this.o.timeoutMs ?? STATUS_QUOTA_MS))))
      const quota = await Promise.race([models.quota(accountId), late])
      return quota === 'late' ? 'blind' : assessQuota(quota)
    } catch {
      return 'blind'
    } finally {
      clearTimeout(timer)
    }
  }

  /** 日志坏了不能影响调用和队列 */
  private warn(msg: string, data?: unknown): void {
    try {
      this.o.log.warn(msg, data)
    } catch {
      // 没地方说了
    }
  }

  private pump(): void {
    if (this.active || this.closed) return
    const job = this.queue.shift()
    if (!job) return
    const abort = new AbortController()
    // 下一轮事件循环才开始:noteContext 那边不能被任务的同步部分拖住
    const done = new Promise<void>(resolve => setImmediate(() => void this.runJob(job, abort).finally(resolve)))
    this.active = { abort, done }
  }

  private async runJob(job: Job, abort: AbortController): Promise<void> {
    let tail: Promise<unknown> = Promise.resolve()
    let failed: BackgroundReason | undefined
    const run: BackgroundRun = {
      // 同一个任务并发调 text 也一个一个发
      text: (ref, req) => {
        const result = tail.then(async () => {
          if (abort.signal.aborted) return no('aborted')
          // 一个任务失败一次就放弃:任务里写循环,也只发一个请求、读一次额度
          if (failed) return no(failed)
          const r = await this.send(ref, req, abort.signal)
          if (!r.ok) failed = r.reason
          return r
        }).catch(() => no('error'))
        tail = result
        return result
      },
    }
    try {
      if (!abort.signal.aborted) await this.settleOrAbandon(job, run, abort)
    } catch (err) {
      this.warn('background job failed', { error: err instanceof Error ? err.name : 'unknown' })
    } finally {
      // 任务结束了,它留下的 run 不能再发;没等完的那个也要停,否则会和下一个任务同时在飞
      abort.abort()
      await tail.catch(() => {})
      this.active = undefined
      this.pump()
    }
  }

  /** 到上限或被中止后,再等一小会就放手。放手的任务还在跑,但它的 text 只会回 aborted */
  private settleOrAbandon(job: Job, run: BackgroundRun, abort: AbortController): Promise<void> {
    return new Promise((resolve, reject) => {
      let grace: ReturnType<typeof setTimeout> | undefined
      const cap = setTimeout(() => abort.abort(), this.o.jobTimeoutMs ?? JOB_TIMEOUT_MS)
      const giveUp = () => {
        clearTimeout(cap)
        grace = setTimeout(() => {
          this.warn('background job abandoned')
          resolve()
        }, this.o.closeGraceMs ?? CLOSE_GRACE_MS)
      }
      abort.signal.addEventListener('abort', giveUp, { once: true })
      void (async () => job(run))()
        .then(resolve, reject)
        .finally(() => {
          clearTimeout(cap)
          clearTimeout(grace)
          abort.signal.removeEventListener('abort', giveUp)
        })
    })
  }

  private async send(ref: ModelRef, req: TextReq, closing: AbortSignal): Promise<BackgroundText> {
    const gate = new CallGate()
    const timer = setTimeout(() => gate.halt('timeout'), this.o.timeoutMs ?? TIMEOUT_MS)
    const onClose = () => gate.halt('aborted')
    closing.addEventListener('abort', onClose, { once: true })
    try {
      return await this.fencedCall(ref, req, gate)
    } catch (err) {
      this.warn('background call failed', { error: err instanceof Error ? err.name : 'unknown' })
      return no('error')
    } finally {
      clearTimeout(timer)
      closing.removeEventListener('abort', onClose)
    }
  }

  private accountFence(models: ModelsService, ref: ModelRef, cfg: MemoryConfig): Fenced | BackgroundReason {
    const found = accountOf(models, ref.accountId)
    if (!found) return 'account_out'
    const { account, preset, list } = found
    if (preset.restriction === 'coding-tools-only') return 'restricted'
    const explicit = cfg.backgroundModel?.accountId === ref.accountId && cfg.backgroundModel.modelId === ref.modelId
    if (preset.restriction === 'unknown' && preset.billing !== 'metered' && !explicit) return 'restricted'
    if (account.state !== 'ok') return 'account_out'
    return { entry: list.find(m => m.id === ref.modelId), metered: preset.billing === 'metered' }
  }

  /** 读不了、读到坏的,或这一天写失败过,都是 undefined */
  private readLedger(day: string): Ledger | undefined {
    if (this.brokenDay === day) return undefined
    try {
      const ledger = parseLedger(this.o.store.getMeta(BUDGET + day))
      if (!ledger) this.warn('background budget ledger is damaged')
      return ledger
    } catch (err) {
      this.warn('background budget ledger is unreadable', { error: err instanceof Error ? err.name : 'unknown' })
      return undefined
    }
  }

  /** 写不进去就是 false。旧日子清不掉不要紧:账本本身是对的,下次再清 */
  private writeLedger(day: string, ledger: Ledger): boolean {
    try {
      this.o.store.setMeta(BUDGET + day, JSON.stringify(ledger))
    } catch (err) {
      this.warn('background budget ledger is unwritable', { error: err instanceof Error ? err.name : 'unknown' })
      return false
    }
    try {
      // 只清更早的:时钟往回拨时,真正的那一天的账不能丢。日期按字典序就是时间序
      for (const { key } of this.o.store.metaWithPrefix(BUDGET)) if (key < BUDGET + day) this.o.store.deleteMeta(key)
    } catch (err) {
      this.warn('background budget cleanup failed', { error: err instanceof Error ? err.name : 'unknown' })
    }
    return true
  }

  private async fencedCall(ref: ModelRef, req: TextReq, gate: CallGate): Promise<BackgroundText> {
    const models = this.o.models()
    if (!models) return no('error')
    const cfg = this.o.config()
    const fence = this.accountFence(models, ref, cfg)
    if (typeof fence === 'string') return no(fence)
    const cost = fence.entry?.cost ?? UNPRICED
    const billed = (input: number, output: number) => (fence.metered ? dollars(cost, input, output) : 0)

    if (!Number.isInteger(req.maxOutput) || req.maxOutput <= 0) return no('error')
    const maxOutput = Math.min(req.maxOutput, MAX_OUTPUT)
    const promptTokens = Math.ceil(estimate(req.system) + estimate(req.prompt))
    // 按最坏情况占住,调用结束再退回去:一次调用越不过日线,进程没了也算足
    const held = promptTokens + maxOutput
    const heldUsd = billed(promptTokens, maxOutput)
    const refusal = (ledger: Ledger | undefined, tokensLimit: number): BackgroundReason | undefined => {
      if (!ledger) return 'budget'
      if (ledger.out.includes(ref.accountId)) return 'account_out'
      if (ledger.tokens >= tokensLimit || ledger.tokens + held > tokensLimit) return 'budget'
      if (fence.metered && (ledger.usd >= cfg.usdPerDay || ledger.usd + heldUsd > cfg.usdPerDay)) return 'budget'
      return undefined
    }
    // 账本先看:花光了就不用去读额度
    const early = refusal(this.readLedger(dateKey(this.o.now())), cfg.tokensPerDay)
    if (early) return no(early)

    let quota: Quota | null | undefined
    try {
      quota = await Promise.race([models.quota(ref.accountId), gate.stopped])
    } catch {
      return no('quota_low')
    }
    if (gate.stop) return no(gate.stop)
    const seen = assessQuota(quota ?? null)
    if (seen === 'low') return no('quota_low')
    const tokensLimit = seen === 'blind' ? Math.min(cfg.tokensPerDay, BLIND_TOKENS) : cfg.tokensPerDay

    // 先记账再发:发到一半进程没了,这笔也算数
    const day = dateKey(this.o.now())
    const base = this.readLedger(day)
    const late = refusal(base, tokensLimit)
    if (late || !base) return no(late ?? 'budget')
    if (!this.writeLedger(day, { ...base, tokens: base.tokens + held, usd: base.usd + heldUsd })) return no('budget')

    const got = await this.collect(models, ref, { ...req, maxOutput }, gate)

    const refused = got.error && REFUSED.has(got.error.kind) && !got.usage && got.output === 0
    const input = refused ? 0 : got.usage && got.usage.input > 0 ? got.usage.input : promptTokens
    const output = refused ? 0 : got.usage && got.usage.output > 0 ? got.usage.output : Math.ceil(got.output)
    const tokens = input + output
    const usd = billed(input, output)
    const accountOut = got.error && !gate.stop && (got.error.kind === 'quota' || got.error.kind === 'auth' || got.error.kind === 'restricted')
    const out = accountOut && !base.out.includes(ref.accountId) ? [...base.out, ref.accountId] : base.out
    if (accountOut) this.warn('background account is out for the day', { accountId: ref.accountId, kind: got.error?.kind })
    if (!this.writeLedger(day, { tokens: base.tokens + tokens, usd: base.usd + usd, out })) this.brokenDay = dateKey(this.o.now())

    const reason = gate.stop ?? this.failureOf(got)
    return reason ? no(reason) : { ok: true, text: got.text, tokens, model: ref.modelId, usd }
  }

  private failureOf(got: Collected): BackgroundReason | undefined {
    if (got.reason === 'stop') return undefined
    if (got.reason === 'length') return 'length'
    if (got.error?.kind === 'restricted') return 'restricted'
    if (got.error?.kind === 'quota' || got.error?.kind === 'auth') return 'account_out'
    return 'error'
  }

  /** 不抛错。流怎么坏都走到这里的返回值:停在 gate、没有 done、或者抛了 */
  private async collect(models: ModelsService, ref: ModelRef, req: TextReq, gate: CallGate): Promise<Collected> {
    const got: Collected = { text: '', output: 0 }
    const cap = req.maxOutput * OUTPUT_OVERRUN
    let iterator: AsyncIterator<ModelEvent> | undefined
    try {
      iterator = models
        .stream(ref, {
          ...(req.system && { system: req.system }),
          messages: [{ role: 'user', parts: [{ type: 'text', text: req.prompt }] }],
          reasoning: 'off',
          maxOutput: req.maxOutput,
          interactive: false,
          signal: gate.controller.signal,
        })
        [Symbol.asyncIterator]()
      for (let events = 1; ; events++) {
        // race:不理 signal 的流也拦不住超时和关闭
        const next = await Promise.race([iterator.next(), gate.stopped])
        if (gate.stop || !next || next.done) break
        const e = next.value
        if (e.type === 'done') {
          got.reason = e.reason
          got.error = e.error
          break
        }
        if (e.type === 'usage') got.usage = { input: spendable(e.input) ? e.input : 0, output: spendable(e.output) ? e.output : 0 }
        else if (e.type === 'text') {
          got.text += e.delta
          got.output += estimate(e.delta)
        } else if (e.type === 'reasoning') got.output += estimate(e.delta ?? '')
        else got.output += estimate(e.argsDelta)
        if (got.output > cap) gate.halt('length')
        else if (events % YIELD_EVERY === 0) await new Promise(setImmediate)
      }
    } catch {
      // 没有 done:调用方按 error 算,已产出的照样记账
    }
    // 不等:停不下来的流 return() 也不会回来
    try {
      void Promise.resolve(iterator?.return?.()).catch(() => {})
    } catch {
      // 已经有结果了,收尾失败不影响
    }
    return got
  }
}

interface Collected {
  text: string
  /** 模型产出的全部内容估算成 token,没有 usage 时按它记账 */
  output: number
  usage?: { input: number; output: number }
  reason?: Extract<ModelEvent, { type: 'done' }>['reason']
  error?: ModelError
}

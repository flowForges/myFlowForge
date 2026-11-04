// loop-default 的一轮(spec §8 第 2–6、8 步):重建历史 → 逐步 models.stream → 按顺序执行工具 → 直到模型不再调用工具。
// 终态不在这里写:返回给 index.ts,拍完结束快照再写
// 快照(第 1、7 步)在 index.ts 的 runTurn 前后;每步请求前压缩上下文(§8.4)
// 委派(04 §7):每步请求前送达后续消息和运行通知;模型停了而运行没完时挂起,不结束轮
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Logger } from '../../kernel/log'
import type { SessionInfo, Sessions } from '../../kernel/sessions'
import { activeRebuild, selectCheckpoint } from '../../lib/memory/checkpoint'
import { injectMemory } from '../../lib/memory/inject'
import type { MemoryService } from '../../lib/memory/types'
import type { Message, ModelError, ModelEvent, ModelRequest, ModelsService, Part } from '../../lib/models/types'
import { redact } from '../../lib/tools/redact'
import type { BackgroundRuns, FollowUp, ToolsService, TurnInbox } from '../../lib/tools/types'
import type { KernelEvent, ModelRef } from '../../protocol/index'
import { charsToTokens, compact, contextWindow, dropOldest, estimateTokens } from './compact'
import { accountProtocol, family, toolDefs, toolsetFor } from './family'
import { followUpMessage, INTERRUPTED, noticeMessage, rebuildHistory, type BuildOpts, type ReplayOrigin } from './history'
import { LOOP_REMINDER, LoopGuard } from './loopGuard'
import { dateReminder, environmentBlock, systemPrompt } from './prompts/index'

export const MAX_STEPS = 50
const NAME_MAX = 200
const ARGS_RAW_MAX = 2_000

const mapStrings = (v: unknown, f: (s: string) => string): unknown => {
  if (typeof v === 'string') return f(v)
  if (Array.isArray(v)) return v.map(x => mapStrings(x, f))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [f(k), mapStrings(x, f)]))
  return v
}

/**
 * 写进事件的工具参数:在解析后的字符串值里打码再序列化,保证仍是合法 JSON(PEM 规则不会吃掉结尾的 `"}`);
 * 不是合法 JSON 的参数换成占位对象,原文打码截断后放在里面
 */
export function loggedArgs(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw)
    const masked = JSON.stringify(mapStrings(parsed, redact))
    // 没打到任何东西:留原文,重建的历史与当时发给模型的逐字节相同
    return masked === JSON.stringify(parsed) ? raw : masked
  } catch {
    return JSON.stringify({ _unparsed: redact(raw).slice(0, ARGS_RAW_MAX) })
  }
}
const MAX_RETRIES = 2
const RETRY_DEFAULT_MS = 5_000
const RETRY_MAX_MS = 60_000
/**
 * 模型厂商说上下文爆了(06 §12);认不出来的就是 03 的失败。不认裸的 context、maximum、too long:
 * 输出上限、图片过大这些 400 不能写一个永久的标记
 */
const OVERFLOW = /context[ _-]?(length|window|limit)|too many (input )?tokens|reduce the length|request_too_large|string too long|\b(prompt|input|request|messages?)\b[^.]*\b(too long|too large|exceeds?)\b/i
/** 推理回放对不上前缀(Anthropic preserved thinking 的 400);被篡改的签名开头相同,恢复办法也相同 */
const THINKING_REFUSED = /invalid .signature. in .thinking. block|bound to a different conversation/i

/**
 * 尾部是带推理的工具步:正在工具循环里。这时动前缀两头都可能被拒:留着推理,签名对不上新前缀;
 * 去掉推理,旧模型要求工具循环的最后一步以推理打头。所以平时等它过去,厂商已经拒了(force)才动
 */
function inThinkingRound(messages: Message[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'assistant') continue
    return messages[i].parts.some(p => p.type === 'reasoning') && messages[i].parts.some(p => p.type === 'tool_call')
  }
  return false
}

/** 前缀变了:留下的推理全都对不上。这之后新产生的绑定新前缀 */
const withoutReplays = (messages: Message[]): Message[] =>
  messages.map(m => (m.parts.some(p => p.type === 'reasoning') ? { ...m, parts: m.parts.filter(p => p.type !== 'reasoning') } : m))

export interface LoopDeps {
  models: ModelsService
  tools: ToolsService
  append(e: Omit<KernelEvent, 'seq' | 'ts'>): unknown
  signal: AbortSignal
  sessions: Pick<Sessions, 'spillDir'>
  log: Logger
  /** 本会话的事件(seq 升序) */
  history(sessionId: string): KernelEvent[]
  /** 限流重试的等待;须在 signal 中止时尽快返回。默认 setTimeout */
  sleep?(ms: number, signal: AbortSignal): Promise<void>
  maxSteps?: number
  now?(): Date
  platform?: NodeJS.Platform
  /** `executors` 服务;没有 = 没有后台运行,不挂起 */
  background?: BackgroundRuns
  /** 本轮的收件箱;没有 = 挂起时只有通知能叫醒 */
  inbox?: TurnInbox
  /** `memory` 服务;没有 = 不注入 */
  memory?: MemoryService
}

export interface TurnRequest {
  sessionId: string
  turnId: string
  text: string
  /** 带 cwd 的会话 */
  info: SessionInfo & { cwd: string }
  ref: ModelRef | 'default'
}

type Call = { id: string; name: string; args: string }
type StepResult =
  | { kind: 'ok'; text: string; replays: unknown[]; calls: Call[]; reason: string }
  | { kind: 'cancelled' }
  | { kind: 'error'; error: ModelError; produced: boolean }

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>(resolve => {
    if (signal.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })

/** cwd 或其祖先有 `.git`(目录或 worktree 的文件) */
export function isGitDir(cwd: string): boolean {
  for (let d = cwd; ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) return true
    if (dirname(d) === d) return false
  }
}

/** 一轮的终态;由调用方在结束快照之后写下(客户端看到终态时快照已在) */
export interface TurnOutcome {
  type: 'turn.ended' | 'turn.failed'
  payload: { turnId: string; reason?: string; message?: string }
}

export async function runTurn(deps: LoopDeps, req: TurnRequest): Promise<TurnOutcome> {
  const { models, tools, signal, background, inbox } = deps
  const { sessionId, turnId, info } = req
  const ev = (type: KernelEvent['type'], payload: object): void => {
    deps.append({ type, sessionId, payload: { turnId, ...payload } })
  }
  const fail = (reason: string, extra?: { message: string }): TurnOutcome => ({ type: 'turn.failed', payload: { turnId, reason, ...extra } })
  const maxSteps = Math.max(1, deps.maxSteps ?? MAX_STEPS)

  // 族、工具集、系统提示词:同一会话内恒定
  const concrete = req.ref === 'default' ? models.catalog().default : req.ref
  const fam = family(concrete ? accountProtocol(models, concrete) : undefined, concrete?.modelId)
  const toolset = toolsetFor(fam, info.toolset)
  const defs = toolDefs(tools.list(), toolset)
  const system = systemPrompt(fam, toolset)

  // 回传推理 replay 只限同一账号 / 协议 / 模型('default' 换了模型或协议后,旧 replay 不再发)
  const origin: ReplayOrigin | undefined = concrete && { accountId: concrete.accountId, protocol: accountProtocol(models, concrete), modelId: concrete.modelId }
  const buildOpts: BuildOpts = {
    origin,
    environment: environmentBlock({ cwd: info.cwd, platform: deps.platform ?? process.platform, isGit: isGitDir(info.cwd), approvalMode: info.approvalMode }),
    reminder: dateReminder,
    now: (deps.now?.() ?? new Date()).getTime(),
  }

  // 压缩的预算:模型上下文减去系统提示词与工具定义
  const fixed = charsToTokens(system.length + JSON.stringify(defs).length)
  const context = Math.max(1, contextWindow(models, req.ref) - fixed)

  // 记忆先写进事件,下面的重建才读得到;之后每轮、每次重启读到的都是这同一段字节
  if (deps.memory) {
    injectMemory(deps.memory, { sessionId, turnId, text: req.text, events: deps.history(sessionId), contextTokens: context }, p => ev('memory.injected', p), deps.log)
  }
  const built = rebuildHistory(deps.history(sessionId), turnId, req.text, buildOpts)
  let messages: Message[] = built.messages
  /** 当前轮的开场消息:折叠不碰用户消息,dropOldest 也不换它,所以按对象认得出 */
  let opening: Message | undefined = messages[built.opening]
  /** 这一轮试过的检查点:省不够的不再算一遍 */
  let lastTried: number | undefined

  // 只有 step 往上数;后续消息把上限推后,并重置死循环检测(§7.6)
  let limit = maxSteps
  let guard = new LoopGuard()
  /** 挂起时收下、还没进本轮消息的后续消息;不为空时即使过了上限也还要再走一步 */
  const received: FollowUp[] = []
  const sleep = deps.sleep ?? defaultSleep
  let retries = 0

  /** 新的有效检查点值得切换就写标记并换掉消息。force = 模型厂商已经说爆了,省多少都切 */
  function trySwitch(step: number, force: boolean): boolean {
    if (!force && inThinkingRound(messages)) return false // 不算试过:这一轮结束后再切
    const events = deps.history(sessionId)
    const cp = selectCheckpoint(events)
    const active = activeRebuild(events)
    if (!cp || cp.seq === lastTried || (active && cp.throughSeq <= active.throughSeq)) return false
    const includeCurrent = { ...buildOpts, includeCurrent: true }
    const candidate = rebuildHistory(events, turnId, req.text, { ...includeCurrent, rebuild: cp }).messages
    lastTried = cp.seq
    const before = estimateTokens(messages)
    const after = estimateTokens(candidate)
    if (force ? after >= before : before - after < context * 0.2) return false
    ev('context.rebuilt', { step, checkpointSeq: cp.seq, throughSeq: cp.throughSeq, before, after })
    const rebuilt = rebuildHistory(deps.history(sessionId), turnId, req.text, includeCurrent)
    messages = rebuilt.messages
    opening = messages[rebuilt.opening]
    return true
  }

  /** 每步请求前(06 §12):先看重建,再折叠,再兜底。没有记忆服务时只有 03 的折叠 */
  function fitContext(step: number, force: boolean): void {
    const memory = deps.memory
    const switched = !!memory && (force || estimateTokens(messages) > context * 0.7) && trySwitch(step, force)
    // 折叠结果留在本轮的消息里:之后几步的前缀不变,直到再次越过高水位
    messages = compact(messages, { context, cwd: info.cwd })
    if (memory) {
      const currentOpening = opening ? messages.indexOf(opening) : -1
      const tokens = estimateTokens(messages)
      if (force && !(switched && tokens <= context * 0.5)) {
        // 没切换时估算可能比厂商的算法偏小(目录里的窗口也可能不准):低于 50% 还被拒,就再减一半,否则重试发的是同一份
        messages = withoutReplays(dropOldest(messages, { context, target: switched ? 0.5 : Math.min(0.5, (0.5 * tokens) / context), keepRecent: 0, currentOpening }))
      } else if (tokens > context * 0.9 && !inThinkingRound(messages)) {
        messages = withoutReplays(dropOldest(messages, { context, target: 0.6, keepRecent: Math.min(24_000, Math.floor(context * 0.3)), currentOpening }))
      }
    }
    if (memory && concrete) {
      try {
        memory.noteContext({ sessionId, ref: concrete, tokens: estimateTokens(messages), context })
      } catch (err) {
        deps.log.warn('noteContext failed', { error: err instanceof Error ? err.name : 'unknown' })
      }
    }
  }

  /** 一次模型请求:转发 delta / 用量,收齐文本、推理 replay 与工具调用 */
  async function streamStep(step: number, force = false): Promise<StepResult> {
    fitContext(step, force)
    const request: Omit<ModelRequest, 'model'> = {
      system,
      messages: messages.slice(),
      ...(defs.length && { tools: defs }),
      ...(step === limit && { toolChoice: 'none' as const }),
      reasoning: 'medium',
      interactive: true,
      signal,
    }
    let text = ''
    const replays: unknown[] = []
    const calls = new Map<string, Call>()
    let produced = false
    let doneEvent: Extract<ModelEvent, { type: 'done' }> | undefined
    try {
      for await (const e of models.stream(req.ref, request)) {
        if (e.type === 'text') {
          produced = true
          text += e.delta
          if (e.delta) ev('message.assistant.delta', { step, text: e.delta })
        } else if (e.type === 'reasoning') {
          if (e.delta) ev('message.reasoning.delta', { step, text: e.delta })
          if (e.replay !== undefined) replays.push(e.replay)
        } else if (e.type === 'tool_call') {
          produced = true
          const c = calls.get(e.id) ?? { id: e.id, name: '', args: '' }
          if (e.name) c.name = e.name
          c.args += e.argsDelta ?? ''
          calls.set(e.id, c)
        } else if (e.type === 'usage') {
          ev('turn.usage', {
            step, input: e.input, output: e.output,
            ...(e.cacheRead !== undefined && { cacheRead: e.cacheRead }),
            ...(e.cacheWrite !== undefined && { cacheWrite: e.cacheWrite }),
          })
        } else if (e.type === 'done') {
          doneEvent = e
          break
        }
      }
    } catch (err) {
      if (signal.aborted) return { kind: 'cancelled' }
      return { kind: 'error', produced, error: { kind: 'network', message: err instanceof Error ? err.message : String(err), retryable: false } }
    }
    if (signal.aborted || doneEvent?.reason === 'cancelled') return { kind: 'cancelled' }
    if (!doneEvent) return { kind: 'error', produced, error: { kind: 'network', message: 'stream ended without done', retryable: true } }
    if (doneEvent.reason === 'error') {
      return { kind: 'error', produced, error: doneEvent.error ?? { kind: 'unavailable', message: 'model error', retryable: false } }
    }
    // 模型没给 id 的调用:补一个本步内唯一的
    const list = [...calls.values()].map((c, i) => (c.id ? c : { ...c, id: `call_${step}_${i}` }))
    return { kind: 'ok', text, replays, calls: list, reason: doneEvent.reason }
  }

  const runsOpen = (): boolean => !!background && background.active(turnId) + background.pending(turnId) > 0

  /** 取走已结束运行的通知:写事件并进本轮消息(两边 seq 顺序一致,之后的请求和重建逐字节相同) */
  const deliverNotices = (step: number): void => {
    for (const n of background?.take(turnId) ?? []) {
      ev('executor.notice', { step, runId: n.runId, text: n.text })
      messages.push(noticeMessage(n.text))
    }
  }

  /**
   * 等运行结束或用户发消息。parked 先置、事件后写,都在第一个 await 之前:客户端看到 turn.parked 时发的消息一定收得下。
   * 叫醒的原因不看 race 谁赢:wait 先 resolve、续延还没跑时消息也可能进来。unpark 之后不会再有消息,这时取到的就是全部
   */
  async function park(step: number, runs: BackgroundRuns): Promise<'notice' | 'message' | 'abort'> {
    const stopWaiting = new AbortController()
    const parked = inbox?.park() ?? new Promise<void>(() => {})
    try {
      ev('turn.parked', { step, active: runs.active(turnId), pending: runs.pending(turnId) })
      await Promise.race([parked, runs.wait(turnId, AbortSignal.any([signal, stopWaiting.signal]))])
    } finally {
      inbox?.unpark()
      stopWaiting.abort()
    }
    received.push(...(inbox?.take() ?? []))
    const cause = signal.aborted ? 'abort' : received.length ? 'message' : 'notice'
    ev('turn.resumed', { step, cause })
    return cause
  }

  /** 取消、关闭或后续消息顶替了等着写的失败:它不会进事件了,留一条日志,否则就没有任何记录 */
  const logReplaced = (outcome: TurnOutcome, cause: 'message' | 'abort'): void => {
    if (outcome.type !== 'turn.failed') return
    const { reason: kind, message } = outcome.payload
    deps.log.warn('turn failure replaced', { turnId, kind, ...(message !== undefined && { message: redact(message) }), cause })
  }

  /**
   * 模型不会再被请求了(失败或到了上限),但运行还开着:不杀它们,等到结束,通知只写事件,再交出 outcome。
   * 这段等待也算挂起:用户发来消息 → 'resume',调用方 continue,由下一步的开头给新预算。取消不走 settle 的 outcome,只记日志
   */
  async function settle(step: number, outcome: TurnOutcome): Promise<TurnOutcome | 'resume'> {
    for (;;) {
      deliverNotices(step)
      if (!background || !runsOpen()) return outcome
      const woke = await park(step, background)
      if (woke === 'abort') {
        logReplaced(outcome, woke)
        return fail('cancelled')
      }
      if (woke === 'message') {
        logReplaced(outcome, woke)
        return 'resume'
      }
    }
  }

  /** 本步调用的结果消息:没跑到的补"已中断",与 history.ts 重建的一样;否则恢复后的请求里调用没有结果 */
  const closeCalls = (calls: Call[], results: Part[]): Message => ({
    role: 'tool',
    parts: calls.map((c, j) => results[j] ?? { type: 'tool_result' as const, callId: c.id, content: INTERRUPTED, isError: true }),
  })

  // 过了上限还有后续消息时要再走一步:第 limit 步挂起时收下的消息,要到下一步开头才给新预算
  turn: for (let step = 1; step <= limit || received.length > 0; step++) {
    if (signal.aborted) return fail('cancelled')
    // 后续消息在前:它的 message.user 收下时已写,seq 比这里才写的通知小
    const followUps = [...received.splice(0), ...(inbox?.take() ?? [])]
    for (const f of followUps) messages.push(followUpMessage(f.text, f.ts, buildOpts))
    if (followUps.length) {
      limit = step + maxSteps
      guard = new LoopGuard()
      retries = 0
    }
    deliverNotices(step)

    let r = await streamStep(step)
    let overflowRetried = false
    let thinkingRetried = false
    while (r.kind === 'error' && !r.produced) {
      if (r.error.kind === 'rate_limit' && r.error.retryable && retries < MAX_RETRIES) {
        // 限流且这一步还没吐出文本 / 工具调用:等一会儿重试(每轮最多 2 次,可被取消)
        retries++
        const wait = Math.min(RETRY_MAX_MS, Math.max(0, r.error.retryAfterMs ?? RETRY_DEFAULT_MS))
        deps.log.info('rate limited, retrying', { step, wait })
        await sleep(wait, signal)
        if (signal.aborted) return fail('cancelled')
        r = await streamStep(step)
      } else if (r.error.kind === 'bad_request' && THINKING_REFUSED.test(r.error.message)) {
        // 折叠、丢消息、重建或 memory.delete 动过前缀:去掉推理重试一次,新产生的推理绑定新前缀。在 OVERFLOW 之前:这种拒绝不能写标记
        const stripped = withoutReplays(messages)
        if (thinkingRetried || stripped.every((m, i) => m === messages[i])) break
        thinkingRetried = true
        deps.log.warn('thinking replay refused, retrying once without it', { step })
        messages = stripped
        r = await streamStep(step)
      } else if (deps.memory && r.error.kind === 'bad_request' && OVERFLOW.test(r.error.message) && !overflowRetried) {
        // 上下文真的爆了:这一步强制重建或丢旧消息,只重试一次,不占限流的次数。再失败走 03 的失败
        overflowRetried = true
        deps.log.warn('context overflow, retrying once', { step })
        r = await streamStep(step, true)
      } else {
        break
      }
    }
    if (r.kind === 'cancelled') return fail('cancelled')
    if (r.kind === 'error') {
      const s = await settle(step, fail(r.error.kind, { message: r.error.message }))
      if (s === 'resume') continue
      return s
    }

    // 模型原文进本轮的消息;写进事件的工具参数打码
    const parts: Part[] = [
      ...r.replays.map(replay => ({ type: 'reasoning' as const, replay })),
      ...(r.text ? [{ type: 'text' as const, text: r.text }] : []),
      ...r.calls.map(c => ({ type: 'tool_call' as const, id: c.id, name: c.name, args: c.args })),
    ]
    const logged = parts.map(p => {
      if (p.type === 'tool_call') return { ...p, name: redact(p.name).slice(0, NAME_MAX), args: loggedArgs(p.args) }
      if (p.type === 'reasoning') return { ...p, ...origin } // 来源:重建时只回传给同一模型
      return p
    })
    ev('message.assistant', { step, text: r.text, parts: logged })
    if (!r.calls.length) {
      if (r.reason === 'length') deps.log.warn('model output hit the length limit', { step })
      // 同 stepParts:只有推理的步不进
      if (parts.some(p => p.type === 'text' || p.type === 'tool_call')) messages.push({ role: 'assistant', parts })
      const ended: TurnOutcome = { type: 'turn.ended', payload: { turnId } }
      if (!background || !runsOpen()) return ended
      const woke = await park(step, background)
      if (woke === 'abort') return fail('cancelled')
      // 到了上限只有用户的消息才值得再请求模型;通知写进事件留给下一轮(§7.3)
      if (step !== limit || woke === 'message') continue
      const s = await settle(step, ended)
      if (s === 'resume') continue
      return s
    }
    messages.push({ role: 'assistant', parts })
    if (step === limit) {
      messages.push(closeCalls(r.calls, []))
      const s = await settle(step, fail('max_steps'))
      if (s === 'resume') continue
      return s
    }

    const results: Part[] = []
    for (const c of r.calls) {
      const verdict = guard.see(c.name, c.args)
      if (verdict === 'stop') {
        // 第 5 次不执行
        messages.push(closeCalls(r.calls, results))
        const s = await settle(step, fail('loop'))
        if (s === 'resume') continue turn
        return s
      }
      const res = await tools.call(c.name, c.args, {
        sessionId, turnId, callId: c.id, cwd: info.cwd, spillDir: deps.sessions.spillDir(sessionId), signal,
      })
      // 取消靠 signal 判断,不看拒绝文案(取消导致的拒绝不再继续循环)
      if (signal.aborted) return fail('cancelled')
      const content = verdict === 'warn' ? `${res.content}\n\n${LOOP_REMINDER}` : res.content
      results.push({ type: 'tool_result', callId: c.id, content, ...(res.isError && { isError: true }) })
    }
    messages.push({ role: 'tool', parts: results })
  }
  // 不会到这里:step === limit 时上面已返回或收到了后续消息
  return fail('max_steps')
}

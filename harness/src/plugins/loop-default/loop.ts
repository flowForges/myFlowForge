// loop-default 的一轮(spec §8 第 2–6、8 步):重建历史 → 逐步 models.stream → 按顺序执行工具 → 直到模型不再调用工具
// 快照(第 1、7 步)由 Task 12 接在 index.ts 的 runTurn 前后
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Logger } from '../../kernel/log'
import type { SessionInfo, Sessions } from '../../kernel/sessions'
import type { Message, ModelError, ModelEvent, ModelRequest, ModelsService, Part } from '../../lib/models/types'
import { redact } from '../../lib/tools/redact'
import type { ToolsService } from '../../lib/tools/types'
import type { KernelEvent, ModelRef } from '../../protocol/index'
import { accountProtocol, family, toolDefs, toolsetFor } from './family'
import { buildMessages, type ReplayOrigin } from './history'
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
    return JSON.stringify(mapStrings(JSON.parse(raw), redact))
  } catch {
    return JSON.stringify({ _unparsed: redact(raw).slice(0, ARGS_RAW_MAX) })
  }
}
const MAX_RETRIES = 2
const RETRY_DEFAULT_MS = 5_000
const RETRY_MAX_MS = 60_000

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

export async function runTurn(deps: LoopDeps, req: TurnRequest): Promise<void> {
  const { models, tools, signal } = deps
  const { sessionId, turnId, info } = req
  const ev = (type: KernelEvent['type'], payload: object): void => {
    deps.append({ type, sessionId, payload: { turnId, ...payload } })
  }
  const fail = (reason: string, extra?: object): void => ev('turn.failed', { reason, ...extra })
  const maxSteps = Math.max(1, deps.maxSteps ?? MAX_STEPS)

  // 族、工具集、系统提示词:同一会话内恒定
  const concrete = req.ref === 'default' ? models.catalog().default : req.ref
  const fam = family(concrete ? accountProtocol(models, concrete) : undefined, concrete?.modelId)
  const toolset = toolsetFor(fam, info.toolset)
  const defs = toolDefs(tools.list(), toolset)
  const system = systemPrompt(fam, toolset)

  // 回传推理 replay 只限同一账号 / 协议 / 模型('default' 换了模型或协议后,旧 replay 不再发)
  const origin: ReplayOrigin | undefined = concrete && { accountId: concrete.accountId, protocol: accountProtocol(models, concrete), modelId: concrete.modelId }
  const messages: Message[] = buildMessages(deps.history(sessionId), turnId, req.text, {
    origin,
    environment: environmentBlock({ cwd: info.cwd, platform: deps.platform ?? process.platform, isGit: isGitDir(info.cwd), approvalMode: info.approvalMode }),
    reminder: dateReminder,
    now: (deps.now?.() ?? new Date()).getTime(),
  })

  const guard = new LoopGuard()
  const sleep = deps.sleep ?? defaultSleep
  let retries = 0

  /** 一次模型请求:转发 delta / 用量,收齐文本、推理 replay 与工具调用 */
  async function streamStep(step: number): Promise<StepResult> {
    const request: Omit<ModelRequest, 'model'> = {
      system,
      messages: messages.slice(),
      ...(defs.length && { tools: defs }),
      ...(step === maxSteps && { toolChoice: 'none' as const }),
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

  for (let step = 1; step <= maxSteps; step++) {
    if (signal.aborted) return fail('cancelled')
    let r = await streamStep(step)
    // 限流且这一步还没吐出文本 / 工具调用:等一会儿重试(每轮最多 2 次,可被取消)
    while (r.kind === 'error' && r.error.kind === 'rate_limit' && r.error.retryable && !r.produced && retries < MAX_RETRIES) {
      retries++
      const wait = Math.min(RETRY_MAX_MS, Math.max(0, r.error.retryAfterMs ?? RETRY_DEFAULT_MS))
      deps.log.info('rate limited, retrying', { step, wait })
      await sleep(wait, signal)
      if (signal.aborted) return fail('cancelled')
      r = await streamStep(step)
    }
    if (r.kind === 'cancelled') return fail('cancelled')
    if (r.kind === 'error') return fail(r.error.kind, { message: r.error.message })

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
      return ev('turn.ended', {})
    }
    if (step === maxSteps) return fail('max_steps')
    messages.push({ role: 'assistant', parts })

    const results: Part[] = []
    for (const c of r.calls) {
      const verdict = guard.see(c.name, c.args)
      if (verdict === 'stop') return fail('loop') // 第 5 次不执行
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
  // 不会到这里:step === maxSteps 时上面已返回
  fail('max_steps')
}

// Review Focus 5:重建不丢东西,而且发出去的请求总是合法。直接跑 runTurn,日志在内存里,假模型每次都过三个编解码器检查。
// 用例里没有密钥,也不触发 LoopGuard 提醒:那两样不在"逐字节一致"的范围内(04 spec)
import { describe, expect, it } from 'vitest'
import { activeRebuild, safeBoundaries } from '../../lib/memory/checkpoint'
import type { MemoryService } from '../../lib/memory/types'
import { checkpointBlock } from '../../lib/memory/wrap'
import { buildAnthropicBody } from '../../lib/models/anthropic'
import { buildChatBody } from '../../lib/models/chat'
import { buildResponsesBody } from '../../lib/models/responses'
import type { Message, ModelEvent, ModelRequest, ModelsService } from '../../lib/models/types'
import type { BackgroundRuns, FollowUp, RunNotice, ToolsService, TurnInbox } from '../../lib/tools/types'
import type { KernelEvent } from '../../protocol/index'
import { charsToTokens, dropOldest, estimateTokens } from './compact'
import { family, toolDefs, toolsetFor } from './family'
import { buildMessages, rebuildHistory, type BuildOpts } from './history'
import { runTurn, type LoopDeps, type TurnOutcome } from './loop'
import { dateReminder as dateOf, systemPrompt } from './prompts/index'

type Req = Omit<ModelRequest, 'model'>
const REF = { accountId: 'acc', modelId: 'gpt-5' }
/** 模型上下文减去系统提示词和工具定义之后的预算:测试里 1 token = 3.5 字符 */
const CONTEXT = 10_000
const CHARS = (fraction: number) => Math.floor(CONTEXT * fraction * 3.5)
const toolset = toolsetFor(family(undefined, REF.modelId), undefined)
const WINDOW = CONTEXT + charsToTokens(systemPrompt(family(undefined, REF.modelId), toolset).length + JSON.stringify(toolDefs([], toolset)).length)

async function* of(...evs: ModelEvent[]): AsyncIterable<ModelEvent> {
  for (const e of evs) yield e
}
const say = (text: string) => of({ type: 'text', delta: text }, { type: 'done', reason: 'stop' })
const calling = (id: string, name = 'read') => of({ type: 'tool_call', id, name, argsDelta: `{"path":"${id}"}` }, { type: 'done', reason: 'tool_calls' })
const refuse = (message: string, kind: 'bad_request' | 'rate_limit' = 'bad_request') =>
  of({ type: 'done', reason: 'error', error: { kind, message, retryable: kind === 'rate_limit', ...(kind === 'rate_limit' && { retryAfterMs: 1 }) } })

/** 每个 tool_call 都有结果,没有孤立结果;三个编解码器的请求体同样成对 */
function expectValid(messages: Message[]) {
  expect(messages[0]?.role).toBe('user')
  messages.forEach((m, i) => {
    const calls = m.parts.flatMap(p => (p.type === 'tool_call' ? [p.id] : []))
    if (calls.length) {
      expect(messages[i + 1]?.role, 'a call without its result').toBe('tool')
      expect(messages[i + 1].parts.map(p => (p.type === 'tool_result' ? p.callId : ''))).toEqual(calls)
    }
    if (m.role === 'tool') expect(messages[i - 1]?.role, 'an orphaned result').toBe('assistant')
  })
  const req = { model: REF, system: 's', messages } as never
  const anthropic = buildAnthropicBody(req, {}) as { messages: { role: string; content: { type: string; id?: string; tool_use_id?: string }[] }[] }
  anthropic.messages.forEach((m, i) => {
    const uses = m.content.filter(b => b.type === 'tool_use').map(b => b.id)
    if (uses.length) expect(anthropic.messages[i + 1].content.filter(b => b.type === 'tool_result').map(b => b.tool_use_id)).toEqual(uses)
  })
  expect(anthropic.messages[0].role).toBe('user')
  const chat = buildChatBody(req, {}) as { messages: { role: string; tool_call_id?: string; tool_calls?: { id: string }[] }[] }
  chat.messages.forEach((m, i) => {
    if (m.tool_calls?.length) expect(chat.messages.slice(i + 1, i + 1 + m.tool_calls.length).map(x => x.tool_call_id)).toEqual(m.tool_calls.map(c => c.id))
    if (m.role === 'tool') expect(chat.messages.slice(0, i).some(x => x.tool_calls?.some(c => c.id === m.tool_call_id))).toBe(true)
  })
  const responses = buildResponsesBody(req, { store: false, includeEncryptedReasoning: true }) as { input: { type?: string; call_id?: string }[] }
  const called = responses.input.filter(x => x.type === 'function_call').map(x => x.call_id)
  const answered = responses.input.filter(x => x.type === 'function_call_output').map(x => x.call_id)
  expect(answered).toEqual(called)
}

/** Anthropic 开了 thinking 时的规则:工具循环里最后一个 assistant 必须以 thinking 打头 */
function anthropicRefuses(req: Req): boolean {
  const body = buildAnthropicBody({ model: REF, system: 's', messages: req.messages } as never, {}) as { messages: { role: string; content: { type: string }[] }[] }
  const last = body.messages[body.messages.length - 1]
  const prior = body.messages[body.messages.length - 2]
  if (!last?.content.some(b => b.type === 'tool_result') || prior?.role !== 'assistant') return false
  return prior.content.some(b => b.type === 'tool_use') && prior.content[0].type !== 'thinking'
}

interface Opts {
  memory?: boolean | Partial<MemoryService>
  runs?: BackgroundRuns
  window?: number
  ref?: typeof REF
  onTool?(id: string): void
}

function harness(o: Opts = {}) {
  const events: KernelEvent[] = []
  const append = (e: Omit<KernelEvent, 'seq' | 'ts'>) => {
    const full = { ...e, seq: events.length + 1, ts: 1_700_000_000_000 + events.length * 1000 } as KernelEvent
    events.push(full)
    return full
  }
  const ev = (type: KernelEvent['type'], payload: object) => append({ type, sessionId: 's', payload })
  const requests: Req[] = []
  const noted: { tokens: number; context: number }[] = []
  let script: (n: number, req: Req) => AsyncIterable<ModelEvent> = () => say('ok')
  const models = {
    catalog: () => ({ presets: [], models: {}, default: REF }),
    accounts: () => [{ id: REF.accountId, presetId: 'p', label: 'a', state: 'ok', models: [{ id: REF.modelId, name: 'm', context: o.window ?? WINDOW, output: 1000, image: false, reasoning: 'none', toolCall: true }] }],
    stream(_ref: unknown, req: Req) {
      const copy = { ...req, messages: structuredClone(req.messages) }
      requests.push(copy)
      expectValid(copy.messages)
      return script(requests.length, copy)
    },
  } as unknown as ModelsService
  let currentTurn = ''
  const tools = {
    list: () => [],
    async call(name: string, _args: string, ctx: { callId: string }) {
      o.onTool?.(ctx.callId)
      const content = `result of ${ctx.callId}`
      ev('tool.ended', { turnId: currentTurn, callId: ctx.callId, name, ok: true, ms: 1, content })
      return { content }
    },
  } as unknown as ToolsService
  const service: MemoryService | undefined =
    o.memory === false
      ? undefined
      : { contextFor: () => [], noteContext: req => void noted.push({ tokens: req.tokens, context: req.context }), ...(typeof o.memory === 'object' ? o.memory : {}) }
  const pending: FollowUp[] = []
  let wake: (() => void) | undefined
  const box = {
    parked: false,
    send(text: string) {
      if (!box.parked) throw new Error('ERR_BUSY')
      const e = ev('message.user', { turnId: currentTurn, text, followUp: true })
      box.parked = false
      pending.push({ text, ts: e.ts })
      wake?.()
    },
  }
  const inbox: TurnInbox = {
    park() {
      box.parked = true
      return new Promise<void>(resolve => { wake = resolve })
    },
    unpark() { box.parked = false },
    take: () => pending.splice(0),
  }
  const h = {
    events, requests, noted, ev, box,
    /** 一轮写完的历史:问题,可选 size 字符的工具结果,回答 */
    past(turnId: string, text: string, resultChars = 0) {
      ev('message.user', { turnId, text })
      if (resultChars) {
        ev('message.assistant', { turnId, step: 1, text: '', parts: [{ type: 'tool_call', id: `${turnId}-c`, name: 'read', args: '{"path":"p"}' }] })
        ev('tool.ended', { turnId, callId: `${turnId}-c`, name: 'read', ok: true, ms: 1, content: 'r'.repeat(resultChars) })
      }
      ev('message.assistant', { turnId, step: 2, text: `answer ${turnId}`, parts: [{ type: 'text', text: `answer ${turnId}` }] })
      return ev('turn.ended', { turnId })
    },
    checkpoint(throughSeq: number, text = 'SUMMARY', extra: object = {}) {
      return ev('memory.checkpoint', { throughSeq, asOfSeq: events.length, text, model: 'm', tokens: 1, covers: 1, ...extra })
    },
    marker(cp: KernelEvent, throughSeq: number, turnId = 'marker-turn') {
      return ev('context.rebuilt', { turnId, step: 1, checkpointSeq: cp.seq, throughSeq, before: 2, after: 1 })
    },
    markers: () => events.filter(e => e.type === 'context.rebuilt').map(e => e.payload as { checkpointSeq: number; throughSeq: number; before: number; after: number; step: number; turnId: string }),
    run(turnId: string, text: string, s?: (n: number, req: Req) => AsyncIterable<ModelEvent>, deps: Partial<LoopDeps> = {}): Promise<TurnOutcome> {
      if (s) script = s
      currentTurn = turnId
      ev('message.user', { turnId, text })
      const full: LoopDeps = {
        models, tools, append, signal: new AbortController().signal,
        sessions: { spillDir: () => '/nonexistent-spill' },
        log: { info() {}, warn() {}, error() {} },
        history: () => events.slice(),
        platform: 'linux',
        now: () => new Date(0),
        sleep: async () => {},
        ...(service && { memory: service }),
        ...(o.runs && { background: o.runs, inbox }),
        ...deps,
      }
      return runTurn(full, { sessionId: 's', turnId, text, info: { sessionId: 's', cwd: '/nonexistent-cwd' } as never, ref: o.ref ?? REF })
    },
    /** 这一刻从日志算,和循环同样的选项 */
    rebuilt(turnId: string, text: string, opts: BuildOpts = {}) {
      return buildMessages(events, turnId, text, { origin: { accountId: REF.accountId, protocol: undefined, modelId: REF.modelId }, environment: env(requests[0].messages[0]), reminder: reminderFn, ...opts })
    },
  }
  return h
}

const env = (first: Message) => (first.parts[0] as { text: string }).text
const reminderFn = (ts: number) => dateOf(ts)

const allText = (m: Message[]) => JSON.stringify(m)
const lastOf = <T>(a: T[]) => a[a.length - 1]
const textsOf = (m: Message) => m.parts.map(p => (p.type === 'text' ? p.text : p.type))

describe('switching to a checkpoint', () => {
  it('over 70% with a valid checkpoint: the marker carries before and after, the request is rebuilt, the next turn starts with the same messages', async () => {
    const h = harness()
    h.past('t1', 'first question', CHARS(0.4))
    const through = h.past('t2', 'second question', CHARS(0.4)).seq
    const cp = h.checkpoint(through)
    h.past('t3', 'third question')
    const before = h.events.map(e => ({ ...e }))

    await h.run('t4', 'fourth question')

    const [marker] = h.markers()
    expect(h.markers()).toHaveLength(1)
    expect(marker).toMatchObject({ turnId: 't4', step: 1, checkpointSeq: cp.seq, throughSeq: through })
    expect(marker.before).toBeGreaterThan(CONTEXT * 0.7)
    expect(marker.after).toBeLessThan(marker.before - CONTEXT * 0.2)

    const req = h.requests[0].messages
    expect(estimateTokens(req)).toBe(marker.after)
    expect(textsOf(req[0]).slice(1)).toEqual([dateOf(before[0].ts), 'first question'])
    expect(textsOf(req[1])).toEqual([checkpointBlock(through, 'SUMMARY')])
    expect(allText(req)).not.toContain('rrrrr')
    expect(allText(req)).toContain('third question')
    expect(textsOf(lastOf(req))[1]).toBe('fourth question')

    // 下一轮:这一轮发过的消息原样在开头
    const sent = [...req, { role: 'assistant', parts: [{ type: 'text', text: 'ok' }] } as Message]
    await h.run('t5', 'fifth question')
    const next = h.requests[1].messages
    expect(JSON.stringify(next.slice(0, sent.length))).toBe(JSON.stringify(sent))
    expect(h.markers()).toHaveLength(1)

    // 事件一条不少:原有的 seq 和载荷都在
    for (const e of before) expect(h.events[e.seq - 1]).toEqual(e)
    expect(h.events.length).toBeGreaterThan(before.length)
    expect(allText(h.events.filter(e => e.type === 'tool.ended').map(e => e.payload) as never)).toContain('rrrrr')
  })

  it('at or under 70% nothing moves, even with a checkpoint waiting', async () => {
    const h = harness()
    const through = h.past('t1', 'first', CHARS(0.3)).seq
    h.checkpoint(through)
    await h.run('t2', 'second')
    expect(h.markers()).toEqual([])
    expect(allText(h.requests[0].messages)).not.toContain('<checkpoint')
    expect(allText(h.requests[0].messages)).toContain('rrrrr')
  })

  it('a rebuild that saves under 20% is not written, and that checkpoint is not tried again in this turn', async () => {
    const h = harness()
    const through = h.past('t1', 'first', 10).seq
    h.checkpoint(through)
    h.past('t2', 'second', CHARS(0.75))
    await h.run('t3', 'third', n => (n === 1 ? calling('c1') : say('ok')))
    expect(h.markers()).toEqual([])
    expect(h.requests).toHaveLength(2)
    expect(allText(h.requests[1].messages)).not.toContain('<checkpoint')
  })

  it('tried once: a checkpoint turned down at step 1 stays turned down at step 2, though it would now save enough; a newer one is tried', async () => {
    const h = harness()
    const t1End = h.past('t1', 'first', CHARS(0.15)).seq
    h.past('t2', 'second', CHARS(0.6))
    // 第一步只省 0.15:不够。第二步的新结果比这大,但这个检查点已经试过
    h.checkpoint(t1End)
    const big = 'b'.repeat(CHARS(0.08))
    const result = (id: string) => `${big}${id}`
    const h2Tools = { list: () => [], call: async (name: string, _a: string, ctx: { callId: string }) => {
      const content = result(ctx.callId)
      h.ev('tool.ended', { turnId: 't3', callId: ctx.callId, name, ok: true, ms: 1, content })
      return { content }
    } } as unknown as ToolsService
    let newer: KernelEvent | undefined
    await h.run('t3', 'third', (n) => {
      if (n === 3) newer = h.checkpoint(h.events.filter(e => e.type === 'turn.ended').pop()!.seq, 'NEWER')
      return n <= 3 ? calling(`c${n}`) : say('ok')
    }, { tools: h2Tools })
    // 第 3 步的请求之后才写的检查点,第 4 步才看得到
    expect(h.requests).toHaveLength(4)
    expect(h.markers().map(m => m.step)).toEqual([4])
    expect(h.markers()[0].checkpointSeq).toBe(newer!.seq)
    expect(h.requests.slice(0, 3).every(r => !allText(r.messages).includes('<checkpoint'))).toBe(true)
  })

  it('tried once, even when a second try would now pass: only a later turn looks at it again', async () => {
    const h = harness()
    const through = h.past('t1', 'first', 10).seq
    h.checkpoint(through)
    const big = h.past('t2', 'second', CHARS(0.75))
    const result = h.events.find(e => e.type === 'tool.ended' && e.seq < big.seq && (e.payload as { turnId: string }).turnId === 't2')!
    await h.run('t3', 'third', n => {
      // 第一步省不够。之后事件里的大结果没了,这份候选再算一次就省够了;活的消息还带着它
      if (n === 1) (result.payload as { content: string }).content = '[已删除]'
      return n === 1 ? calling('c1') : say('ok')
    })
    expect(h.requests).toHaveLength(2)
    expect(h.markers()).toEqual([])
    await h.run('t4', 'fourth')
    expect(h.markers()).toEqual([]) // 这一轮的历史本身已经小了,不到 70%
  })

  it('an older marker stays when the newest valid checkpoint does not cover more', async () => {
    const h = harness()
    const t1 = h.past('t1', 'first', 10).seq
    const t2 = h.past('t2', 'second', CHARS(0.8)).seq
    const newer = h.checkpoint(t2, 'NEWER')
    h.marker(newer, t2)
    h.checkpoint(t1, 'LESS')
    h.past('t3', 'third', CHARS(0.8))
    await h.run('t4', 'fourth')
    expect(h.markers()).toHaveLength(1)
    expect(allText(h.requests[0].messages)).toContain('NEWER')
    expect(allText(h.requests[0].messages)).not.toContain('LESS')
  })

  it('a mid-turn rebuild keeps the opening whole enough to act on, and the later steps; the next step and the next turn continue byte for byte', async () => {
    const h = harness()
    h.past('t1', 'first question', CHARS(0.5))
    const task = `TASK-HEAD${'t'.repeat(9000)}`
    let through = 0
    let cpSeq = 0
    await h.run('t2', task, n => {
      if (n === 1) {
        // 这一步的回答和结果在边界之后,边界落在这一轮中间
        through = h.events[h.events.length - 1].seq
        return calling('c1')
      }
      if (n === 2) {
        // 写手这时才交卷:下一步越过 70%
        cpSeq = h.checkpoint(through).seq
        return of({ type: 'text', delta: 'x'.repeat(CHARS(0.25)) }, { type: 'tool_call', id: 'c2', name: 'read', argsDelta: '{"path":"c2"}' }, { type: 'done', reason: 'tool_calls' })
      }
      return n === 3 ? calling('c3') : say('done')
    })
    expect(h.markers()).toHaveLength(1)
    expect(h.markers()[0]).toMatchObject({ step: 3, checkpointSeq: cpSeq, throughSeq: through })

    const third = h.requests[2].messages
    expect(textsOf(third[0])[2]).toBe('first question')
    expect(textsOf(third[1])).toEqual([checkpointBlock(through, 'SUMMARY')])
    const opening = textsOf(third[2])
    expect(opening).toHaveLength(2)
    expect(opening[1].startsWith('TASK-HEAD')).toBe(true)
    expect(opening[1].length).toBeLessThanOrEqual(4000)
    expect(opening[1].length).toBeGreaterThan(3900)
    // 这一轮后面的步都在,配对完好
    expect(third.slice(3).map(m => m.role)).toEqual(['assistant', 'tool', 'assistant', 'tool'])
    expect(allText(third)).toContain('result of c1')
    expect(allText(third)).toContain('result of c2')

    const fourth = h.requests[3].messages
    expect(JSON.stringify(fourth.slice(0, third.length))).toBe(JSON.stringify(third))

    const sent = [...fourth, { role: 'assistant', parts: [{ type: 'text', text: 'done' }] } as Message]
    await h.run('t3', 'next turn')
    const next = lastOf(h.requests).messages
    expect(JSON.stringify(next.slice(0, sent.length))).toBe(JSON.stringify(sent))
  })

  it('a covered turn whose opening was over 4000: the first message is clipped and the session stops being over budget', async () => {
    const h = harness()
    h.past('t1', `HEAD${'p'.repeat(CHARS(0.8))}`)
    const through = h.events[h.events.length - 1].seq
    h.checkpoint(through)
    await h.run('t2', 'second')
    expect(h.markers()).toHaveLength(1)
    const first = lastOf(textsOf(h.requests[0].messages[0]))
    expect(first.startsWith('HEAD')).toBe(true)
    expect(first.length).toBeLessThanOrEqual(4000)
    expect(estimateTokens(h.requests[0].messages)).toBeLessThan(CONTEXT * 0.3)
  })

  it('compact after a rebuild still never touches the first message', async () => {
    const h = harness()
    const t1 = h.past('t1', 'first', 10).seq
    h.checkpoint(t1)
    // 重建后的尾部仍然过 70%:折叠接着做
    for (let i = 2; i < 8; i++) h.past(`t${i}`, `q${i}`, CHARS(0.15))
    await h.run('t9', 'last')
    const first = h.requests[0].messages[0]
    expect(textsOf(first)[2]).toBe('first')
    expect(allText(h.requests[0].messages)).toContain('[已折叠')
    expectFirstUnchanged(h)
  })

  it('the turn blocks of covered turns are reclaimed: a marker frees the ~2k chars a turn compact never folds', async () => {
    const block = 'B'.repeat(2000)
    const h = harness()
    for (let i = 0; i < 16; i++) {
      h.ev('message.user', { turnId: `t${i}`, text: `q${i}` })
      h.ev('memory.injected', { turnId: `t${i}`, kind: 'turn', text: `${i}:${block}`, items: [] })
      h.ev('message.assistant', { turnId: `t${i}`, step: 1, text: `a${i}`, parts: [{ type: 'text', text: `a${i}` }] })
      h.ev('turn.ended', { turnId: `t${i}` })
    }
    const through = h.events[h.events.length - 1].seq
    h.checkpoint(through)
    await h.run('tail', 'tail question')
    expect(h.markers()).toHaveLength(1)
    expect(allText(h.requests[0].messages)).not.toContain(block)
    expect(estimateTokens(h.requests[0].messages)).toBeLessThan(CONTEXT * 0.1)
  })
})

function expectFirstUnchanged(h: ReturnType<typeof harness>) {
  for (const r of h.requests) expect(JSON.stringify(r.messages[0])).toBe(JSON.stringify(h.requests[0].messages[0]))
}

describe('with no usable checkpoint the turn still works', () => {
  it('no checkpoint at 70%: the 03 fold, the same as with no memory service', async () => {
    const run = async (memory: boolean) => {
      const h = harness({ memory })
      for (let i = 0; i < 6; i++) h.past(`t${i}`, `q${i}`, CHARS(0.15))
      await h.run('last', 'last')
      expect(h.markers()).toEqual([])
      return h.requests[0].messages
    }
    const withMemory = await run(true)
    expect(allText(withMemory)).toContain('[已折叠')
    expect(allText(withMemory)).not.toContain('[已省略')
    expect(withMemory).toEqual(await run(false))
  })

  it('still above 90% after the fold: dropOldest to 60%, the first message and the opening stay', async () => {
    const h = harness()
    for (let i = 0; i < 12; i++) {
      h.ev('message.user', { turnId: `t${i}`, text: `q${i} ${'u'.repeat(CHARS(0.1))}` })
      h.ev('message.assistant', { turnId: `t${i}`, step: 1, text: 'a', parts: [{ type: 'text', text: 'a' }] })
      h.ev('turn.ended', { turnId: `t${i}` })
    }
    await h.run('last', 'the current question')
    const sent = h.requests[0].messages
    expect(estimateTokens(sent)).toBeLessThanOrEqual(CONTEXT * 0.6)
    expect(lastOf(textsOf(sent[0])).startsWith('q0')).toBe(true)
    expect(lastOf(textsOf(sent[0])).length).toBeLessThanOrEqual(4000)
    expect(textsOf(sent[1])[0]).toMatch(/^\[已省略较早的 \d+ 条消息,事件日志里还在\]$/)
    expect(lastOf(textsOf(lastOf(sent)))).toBe('the current question')
    // 只改发送的消息,没有事件
    expect(h.events.filter(e => e.type === 'context.rebuilt')).toEqual([])
  })

  it('a current opening that fills the context is never cut, and the first message is', async () => {
    const h = harness()
    h.past('t1', `FIRST${'f'.repeat(CHARS(0.5))}`)
    const opening = `OPEN${'o'.repeat(CHARS(0.5))}`
    await h.run('t2', opening)
    const sent = h.requests[0].messages
    expect(lastOf(textsOf(sent[0])).length).toBeLessThanOrEqual(4000)
    expect(lastOf(textsOf(lastOf(sent)))).toBe(opening)
  })

  it.each<[string, (h: ReturnType<typeof harness>) => void]>([
    ['a malformed checkpoint', h => { h.past('t1', 'q', CHARS(0.8)); h.ev('memory.checkpoint', { throughSeq: 'x', text: 3 }) }],
    ['a null checkpoint payload', h => { h.past('t1', 'q', CHARS(0.8)); h.ev('memory.checkpoint', null as unknown as object) }],
    ['a checkpoint past its own position', h => { h.past('t1', 'q', CHARS(0.8)); h.ev('memory.checkpoint', { throughSeq: 999, asOfSeq: 1, text: 'BAD', model: 'm', tokens: 1, covers: 1 }) }],
    ['a redacted checkpoint', h => { const s = h.past('t1', 'q', CHARS(0.8)).seq; h.checkpoint(s, '[已删除]', { redacted: true }) }],
    ['a marker pointing at nothing', h => { const s = h.past('t1', 'q', CHARS(0.8)).seq; h.ev('context.rebuilt', { turnId: 'x', step: 1, checkpointSeq: 4242, throughSeq: s, before: 2, after: 1 }) }],
    ['a marker with a null payload', h => { h.past('t1', 'q', CHARS(0.8)); h.ev('context.rebuilt', null as unknown as object) }],
    ['a marker pointing at a redacted checkpoint', h => { const s = h.past('t1', 'q', CHARS(0.8)).seq; h.marker(h.checkpoint(s, '[已删除]', { redacted: true }), s) }],
  ])('%s: ignored, the conversation is whole', async (_name, seed) => {
    const h = harness()
    seed(h)
    const outcome = await h.run('t2', 'second')
    expect(outcome.type).toBe('turn.ended')
    expect(allText(h.requests[0].messages)).not.toContain('<checkpoint')
    expect(allText(h.requests[0].messages)).toContain('answer t1')
    expect(h.markers().filter(m => m?.turnId === 't2')).toEqual([])
  })

  it('a redacted checkpoint falls back to the previous marker', async () => {
    const h = harness()
    const t1 = h.past('t1', 'q1').seq
    const t2 = h.past('t2', 'q2').seq
    h.marker(h.checkpoint(t1, 'PRIOR'), t1)
    h.marker(h.checkpoint(t2, '[已删除]', { redacted: true }), t2)
    await h.run('t3', 'q3')
    const sent = allText(h.requests[0].messages)
    expect(sent).toContain('PRIOR')
    expect(sent).toContain('answer t2')
    expect(sent).not.toContain('answer t1')
  })

  it('rollback of a covered turn after the marker: previous valid or none, undone content stays out', async () => {
    const h = harness()
    h.past('t1', 'q1')
    const through = h.past('t2', 'q2').seq
    h.marker(h.checkpoint(through, 'COVERS-T2'), through)
    h.ev('turn.rolledBack', { turnId: 't2', files: 0 })
    await h.run('t3', 'q3')
    const sent = allText(h.requests[0].messages)
    expect(sent).not.toContain('COVERS-T2')
    expect(sent).toContain('answer t1')
    expect(sent).not.toContain('answer t2')
  })

  it('a marker written inside a turn later rolled back stays in force', async () => {
    const h = harness()
    const through = h.past('t1', 'q1').seq
    const cp = h.checkpoint(through, 'STAYS')
    h.past('t2', 'q2')
    h.marker(cp, through, 't2')
    h.ev('turn.rolledBack', { turnId: 't2', files: 0 })
    await h.run('t3', 'q3')
    const sent = allText(h.requests[0].messages)
    expect(sent).toContain('STAYS')
    expect(sent).not.toContain('answer t2')
  })

  it('a rollback before asOfSeq: the checkpoint is valid and switches, later ones too', async () => {
    const h = harness()
    h.past('t1', 'q1', CHARS(0.8))
    h.past('gone', 'undone')
    h.ev('turn.rolledBack', { turnId: 'gone', files: 0 })
    const through = h.events[h.events.length - 1].seq
    h.checkpoint(through, 'VALID')
    await h.run('t2', 'q2')
    expect(h.markers()).toHaveLength(1)
    expect(allText(h.requests[0].messages)).toContain('VALID')
    expect(allText(h.requests[0].messages)).not.toContain('undone')
  })

  it('every marker reader agrees: includeCurrent with the marker gives what the loop sent', async () => {
    const h = harness()
    const through = h.past('t1', 'q1', CHARS(0.8)).seq
    h.checkpoint(through)
    await h.run('t2', 'q2', n => (n === 1 ? calling('c1') : say('ok')))
    expect(activeRebuild(h.events)?.throughSeq).toBe(through)
    const live = [...h.requests[1].messages, { role: 'assistant', parts: [{ type: 'text', text: 'ok' }] } as Message]
    expect(JSON.stringify(h.rebuilt('t2', 'ignored', { includeCurrent: true }))).toBe(JSON.stringify(live))
  })
})

describe('no memory service: as before, and an old marker still rebuilds', () => {
  it('no switch, no drop, no overflow retry', async () => {
    const h = harness({ memory: false })
    const through = h.past('t1', 'q1', CHARS(0.95)).seq
    h.checkpoint(through)
    const outcome = await h.run('t2', 'q2', () => refuse('prompt is too long'))
    expect(outcome).toMatchObject({ type: 'turn.failed', payload: { reason: 'bad_request' } })
    expect(h.requests).toHaveLength(1)
    expect(h.markers()).toEqual([])
    expect(allText(h.requests[0].messages)).not.toContain('[已省略')
  })

  it('an old log with a marker rebuilds the same bytes with or without the service', async () => {
    const send = async (memory: boolean) => {
      const h = harness({ memory })
      h.past('t1', 'q1')
      const through = h.past('t2', 'q2').seq
      h.marker(h.checkpoint(through, 'KEPT'), through)
      h.past('t3', 'q3')
      await h.run('t4', 'q4')
      return h.requests[0].messages
    }
    const without = await send(false)
    expect(allText(without)).toContain('KEPT')
    expect(JSON.stringify(without)).toBe(JSON.stringify(await send(true)))
  })
})

describe('noteContext', () => {
  it('gets the estimate after compaction, every step', async () => {
    const h = harness()
    h.past('t1', 'q1', CHARS(0.1))
    await h.run('t2', 'q2', n => (n === 1 ? calling('c1') : say('ok')))
    expect(h.noted).toHaveLength(2)
    expect(h.noted[0]).toEqual({ tokens: estimateTokens(h.requests[0].messages), context: CONTEXT })
    expect(h.noted[1].tokens).toBe(estimateTokens(h.requests[1].messages))
  })

  it('a throwing noteContext does not cost the turn', async () => {
    const h = harness({ memory: { noteContext() { throw new Error('nope') } } })
    expect((await h.run('t1', 'q1')).type).toBe('turn.ended')
  })
})

describe('the provider says the context overflowed', () => {
  const TOO_LONG = 'prompt is too long: 210000 tokens > 200000 maximum'

  it('nothing produced, no checkpoint: one forced drop, one retry, the turn goes on', async () => {
    const h = harness()
    for (let i = 0; i < 4; i++) h.past(`t${i}`, `q${i}`, CHARS(0.1))
    const outcome = await h.run('last', 'the question', n => (n === 1 ? refuse(TOO_LONG) : say('ok')))
    expect(outcome.type).toBe('turn.ended')
    expect(h.requests).toHaveLength(2)
    const retry = h.requests[1].messages
    expect(estimateTokens(retry)).toBeLessThan(estimateTokens(h.requests[0].messages))
    expect(textsOf(retry[1])[0]).toMatch(/^\[已省略较早的/)
    expect(lastOf(textsOf(lastOf(retry)))).toBe('the question')
  })

  it('a provider smaller than the catalog says: the drop still cuts, though the estimate is under 50%', async () => {
    const h = harness()
    for (let i = 0; i < 6; i++) h.past(`t${i}`, `q${i}`, CHARS(0.05))
    await h.run('last', 'q', n => (n === 1 ? refuse(TOO_LONG) : say('ok')))
    expect(estimateTokens(h.requests[0].messages)).toBeLessThan(CONTEXT * 0.5)
    expect(estimateTokens(h.requests[1].messages)).toBeLessThanOrEqual(estimateTokens(h.requests[0].messages) / 2)
  })

  it('it fails again: the 03 failure, exactly two requests', async () => {
    const h = harness()
    h.past('t1', 'q1', CHARS(0.1))
    const outcome = await h.run('t2', 'q2', () => refuse(TOO_LONG))
    expect(outcome).toMatchObject({ type: 'turn.failed', payload: { reason: 'bad_request', message: TOO_LONG } })
    expect(h.requests).toHaveLength(2)
  })

  it('a checkpoint is forced first, whatever it saves; the marker is written', async () => {
    const h = harness()
    // 省下的远不到 20%,平时不够切
    const through = h.past('t1', 'q1', 2000).seq
    const cp = h.checkpoint(through)
    h.past('t2', 'q2', CHARS(0.1))
    const outcome = await h.run('t3', 'q3', n => (n === 1 ? refuse(TOO_LONG) : say('ok')))
    expect(outcome.type).toBe('turn.ended')
    expect(h.markers()).toHaveLength(1)
    expect(h.markers()[0].checkpointSeq).toBe(cp.seq)
    expect(textsOf(h.requests[1].messages[1])).toEqual([checkpointBlock(through, 'SUMMARY')])
  })

  it.each(['context_length_exceeded', 'request too large', 'maximum of 8192 tokens', 'please reduce the length of the messages', 'CONTEXT window'])('the text %s counts', async text => {
    const h = harness()
    h.past('t1', 'q1', 100)
    await h.run('t2', 'q2', n => (n === 1 ? refuse(text) : say('ok')))
    expect(h.requests).toHaveLength(2)
  })

  it('another bad_request: no retry', async () => {
    const h = harness()
    const outcome = await h.run('t1', 'q1', () => refuse('invalid tool schema'))
    expect(outcome.type).toBe('turn.failed')
    expect(h.requests).toHaveLength(1)
  })

  it('another kind with the same words: no retry', async () => {
    const h = harness()
    const outcome = await h.run('t1', 'q1', () => of({ type: 'done', reason: 'error', error: { kind: 'unavailable', message: 'too long', retryable: false } }))
    expect(outcome.type).toBe('turn.failed')
    expect(h.requests).toHaveLength(1)
  })

  it('text already produced: no retry', async () => {
    const h = harness()
    const outcome = await h.run('t1', 'q1', () => of({ type: 'text', delta: 'partial' }, { type: 'done', reason: 'error', error: { kind: 'bad_request', message: TOO_LONG, retryable: false } }))
    expect(outcome.type).toBe('turn.failed')
    expect(h.requests).toHaveLength(1)
  })

  it('does not use up the rate-limit retries, either order', async () => {
    const h = harness()
    const outcome = await h.run('t1', 'q1', n => {
      if (n === 1 || n === 2) return refuse('slow', 'rate_limit')
      if (n === 3) return refuse(TOO_LONG)
      return n === 4 ? say('ok') : refuse('unexpected')
    })
    expect(outcome.type).toBe('turn.ended')
    expect(h.requests).toHaveLength(4)

    const j = harness()
    const again = await j.run('t1', 'q1', n => {
      if (n === 1) return refuse(TOO_LONG)
      if (n === 2 || n === 3) return refuse('slow', 'rate_limit')
      return n === 4 ? say('ok') : refuse('unexpected')
    })
    expect(again.type).toBe('turn.ended')
    expect(j.requests).toHaveLength(4)
  })

  it('the retry is per step: a later step can overflow and recover too', async () => {
    const h = harness()
    const outcome = await h.run('t1', 'q1', n => {
      if (n === 1) return refuse(TOO_LONG)
      if (n === 2) return calling('c1')
      if (n === 3) return refuse(TOO_LONG)
      return say('ok')
    })
    expect(outcome.type).toBe('turn.ended')
    expect(h.requests).toHaveLength(4)
  })
})

// 规则来自 Anthropic 的 preserved thinking 文档:推理的签名绑定它产生时的前缀,keep-tail 压缩留下的推理整个请求 400;
// 假模型按这条拒绝。真实厂商的行为在实测清单
describe('thinking blocks across a rebuild', () => {
  const REPLAY = { type: 'thinking', thinking: 'T', signature: 'S' }
  const thinkingCall = (id: string) => of({ type: 'reasoning', replay: REPLAY }, { type: 'tool_call', id, name: 'read', argsDelta: `{"path":"${id}"}` }, { type: 'done', reason: 'tool_calls' })
  const hasThinking = (m: Message[]) => allText(m).includes('"thinking":"T"')
  /** 和 eventLog 的 redact 一样:reasoning part 去掉 replay */
  const stripReplay = (h: ReturnType<typeof harness>) => {
    const step = h.events.filter(e => e.type === 'message.assistant').pop()!
    for (const p of (step.payload as { parts: { type: string; replay?: unknown }[] }).parts) if (p.type === 'reasoning') delete p.replay
  }

  it('no switch inside a thinking tool round; the next turn switches, and what it keeps carries no thinking from before the marker', async () => {
    const h = harness()
    const through = h.past('t1', 'q1', CHARS(0.8)).seq
    const outcome = await h.run('t2', 'q2', (n, req) => {
      expect(anthropicRefuses(req)).toBe(false)
      if (n === 1) h.checkpoint(through)
      return n <= 2 ? thinkingCall(`c${n}`) : say('ok')
    })
    expect(outcome.type).toBe('turn.ended')
    expect(h.markers()).toEqual([])
    expect(hasThinking(h.requests[2].messages)).toBe(true)

    await h.run('t3', 'q3', n => (n === 4 ? thinkingCall('c9') : say('ok')))
    expect(h.markers().map(m => m.turnId)).toEqual(['t3'])
    const switched = h.requests[3].messages
    expect(hasThinking(switched)).toBe(false)
    expect(allText(switched)).toContain('result of c1') // 文本和调用留着

    // 切换之后产生的推理绑定新前缀:留下,而且之后每次都一样
    const after = h.requests[4].messages
    expect(JSON.stringify(after.slice(0, switched.length))).toBe(JSON.stringify(switched))
    expect(hasThinking(after)).toBe(true)
    await h.run('t4', 'q4')
    expect(JSON.stringify(lastOf(h.requests).messages.slice(0, after.length))).toBe(JSON.stringify(after))
  })

  it('a replay removed on the current step (memory.delete while the turn runs): the live request goes out, no switch', async () => {
    const h = harness()
    const through = h.past('t1', 'q1', CHARS(0.8)).seq
    const outcome = await h.run('t2', 'q2', (n, req) => {
      expect(anthropicRefuses(req)).toBe(false)
      if (n === 1) {
        h.checkpoint(through)
        return thinkingCall('c1')
      }
      return say('ok')
    }, {
      tools: {
        list: () => [],
        call: async (name: string, _a: string, ctx: { callId: string }) => {
          h.ev('tool.ended', { turnId: 't2', callId: ctx.callId, name, ok: true, ms: 1, content: 'r' })
          stripReplay(h)
          return { content: 'r' }
        },
      } as unknown as ToolsService,
    })
    expect(outcome.type).toBe('turn.ended')
    expect(h.markers()).toEqual([])
    expect(hasThinking(h.requests[1].messages)).toBe(true)
  })

  it('a step without thinking still switches mid-turn', async () => {
    const h = harness()
    const through = h.past('t1', 'q1', CHARS(0.8)).seq
    await h.run('t2', 'q2', n => {
      if (n === 1) h.checkpoint(through)
      return n === 1 ? calling('c1') : say('ok')
    })
    expect(h.markers().map(m => m.step)).toEqual([2])
  })

  it('above 90% in a thinking round: nothing is dropped until the provider refuses; then the retry carries no stale thinking', async () => {
    const h = harness()
    for (let i = 0; i < 12; i++) h.past(`t${i}`, `q${i} ${'u'.repeat(CHARS(0.1))}`)
    let step = 0
    const outcome = await h.run('last', 'the question', () => {
      step++
      if (step === 1) return thinkingCall('c1')
      if (step === 2) return refuse('prompt is too long')
      return say('ok')
    })
    expect(outcome.type).toBe('turn.ended')
    // 第一步的尾部没有推理,照常丢了;之后的请求前缀不变
    expect(allText(h.requests[0].messages)).toContain('[已省略')
    expect(hasThinking(h.requests[1].messages)).toBe(true)
    expect(hasThinking(h.requests[2].messages)).toBe(false)
  })

  it('a tool result that jumps above 90% inside a thinking round is not dropped around', async () => {
    const h = harness()
    h.past('t1', 'q1')
    await h.run('t2', 'q2', n => (n === 1 ? thinkingCall('c1') : say('ok')), {
      tools: {
        list: () => [],
        call: async (name: string, _a: string, ctx: { callId: string }) => {
          const content = 'x'.repeat(CHARS(0.95))
          h.ev('tool.ended', { turnId: 't2', callId: ctx.callId, name, ok: true, ms: 1, content })
          return { content }
        },
      } as unknown as ToolsService,
    })
    expect(allText(h.requests[1].messages)).not.toContain('[已省略')
    expect(hasThinking(h.requests[1].messages)).toBe(true)
  })

  it('a turn-start drop leaves no thinking from the old prefix, and the tail keeps its calls', async () => {
    const h = harness()
    h.ev('message.user', { turnId: 't0', text: 'q0' })
    h.ev('message.assistant', { turnId: 't0', step: 1, text: 'a', parts: [{ type: 'reasoning', replay: REPLAY, accountId: REF.accountId, modelId: REF.modelId }, { type: 'text', text: 'a' }] })
    h.ev('turn.ended', { turnId: 't0' })
    for (let i = 1; i < 12; i++) h.past(`t${i}`, `q${i} ${'u'.repeat(CHARS(0.1))}`)
    h.ev('message.user', { turnId: 'tz', text: 'qz' })
    h.ev('message.assistant', { turnId: 'tz', step: 1, text: 'z', parts: [{ type: 'reasoning', replay: REPLAY, accountId: REF.accountId, modelId: REF.modelId }, { type: 'text', text: 'KEPT-TEXT' }] })
    h.ev('turn.ended', { turnId: 'tz' })
    await h.run('last', 'the question')
    const sent = h.requests[0].messages
    expect(allText(sent)).toContain('[已省略')
    expect(allText(sent)).toContain('KEPT-TEXT')
    expect(hasThinking(sent)).toBe(false)
  })

  it('an overflow in a thinking round with a checkpoint: forced, and the retry carries no stale thinking', async () => {
    const h = harness()
    const through = h.past('t1', 'q1', CHARS(0.3)).seq
    const outcome = await h.run('t2', 'q2', n => {
      if (n === 1) {
        h.checkpoint(through)
        return thinkingCall('c1')
      }
      return n === 2 ? refuse('prompt is too long') : say('ok')
    })
    expect(outcome.type).toBe('turn.ended')
    expect(h.markers().map(m => m.step)).toEqual([2])
    expect(hasThinking(h.requests[1].messages)).toBe(true)
    expect(hasThinking(h.requests[2].messages)).toBe(false)
    expect(allText(h.requests[2].messages)).toContain('<checkpoint')
  })

  it('a voided marker still changed the prefix: thinking from before it stays out', async () => {
    const h = harness()
    h.ev('message.user', { turnId: 't1', text: 'q1' })
    h.ev('message.assistant', { turnId: 't1', step: 1, text: 'a', parts: [{ type: 'reasoning', replay: REPLAY, accountId: REF.accountId, modelId: REF.modelId }, { type: 'text', text: 'a' }] })
    const end = h.ev('turn.ended', { turnId: 't1' })
    h.marker(h.checkpoint(end.seq, '[已删除]', { redacted: true }), end.seq)
    await h.run('t2', 'q2')
    expect(allText(h.requests[0].messages)).not.toContain('<checkpoint')
    expect(hasThinking(h.requests[0].messages)).toBe(false)
  })
})

describe('parked and resumed turns (04)', () => {
  function runs() {
    const state = { active: 0, notices: [] as RunNotice[], wake: undefined as (() => void) | undefined }
    const service: BackgroundRuns = {
      active: () => state.active,
      pending: () => state.notices.length,
      take: () => state.notices.splice(0),
      wait: (_turn, signal) =>
        new Promise<void>(resolve => {
          if (state.notices.length > 0 || signal.aborted) return resolve()
          state.wake = resolve
          signal.addEventListener('abort', () => resolve(), { once: true })
        }),
      abandon: async () => { state.active = 0 },
    }
    return {
      service,
      start: (n: number) => { state.active = n },
      finish(runId: string, text: string) {
        state.active--
        state.notices.push({ runId, text } as RunNotice)
        state.wake?.()
      },
    }
  }
  const until = async (fn: () => boolean) => {
    for (let i = 0; i < 2000 && !fn(); i++) await new Promise(res => setImmediate(res))
    expect(fn()).toBe(true)
  }

  it('a boundary between a notice and a follow-up: the follow-up stays verbatim and appears once; the notice is covered', async () => {
    const r = runs()
    const h = harness({ runs: r.service })
    h.past('t1', 'first', CHARS(0.8))
    r.start(2)
    const parks = () => h.events.filter(e => e.type === 'turn.parked').length
    const finished = h.run('t2', 'the job', n => (n <= 3 ? say(`step ${n}`) : say('end')))
    await until(() => parks() === 1)
    r.finish('run1', 'NOTICE-ONE')
    await until(() => parks() === 2)
    // 边界:通知之后、后续消息之前。写手这时交卷
    const through = h.events[h.events.length - 1].seq
    h.checkpoint(through)
    h.box.send('FOLLOW-UP-TEXT')
    await until(() => parks() === 3)
    r.finish('run2', 'NOTICE-TWO')
    await finished

    expect(h.markers()).toHaveLength(1)
    const live = h.requests[2].messages
    const body = allText(live)
    expect(body.split('FOLLOW-UP-TEXT').length - 1).toBe(1)
    expect(body).not.toContain('NOTICE-ONE')
    const follow = h.events.filter(e => e.type === 'message.user').pop()!
    const at = live.findIndex(m => textsOf(m).includes('FOLLOW-UP-TEXT'))
    expect(textsOf(live[at])).toEqual([dateOf(follow.ts), 'FOLLOW-UP-TEXT'])
    expect(live.slice(0, at).some(m => textsOf(m).some(t => t.startsWith('<checkpoint')))).toBe(true)
    expect(lastOf(h.requests).messages.flatMap(textsOf).some(t => t === 'NOTICE-TWO')).toBe(true)

    const sent = [...lastOf(h.requests).messages, { role: 'assistant', parts: [{ type: 'text', text: 'end' }] } as Message]
    expect(JSON.stringify(h.rebuilt('later', 'x').slice(0, sent.length))).toBe(JSON.stringify(sent))
  })

  it('no marker: includeCurrent gives the live bytes after a notice and a follow-up', async () => {
    const r = runs()
    const h = harness({ runs: r.service })
    h.past('t1', 'first', 200)
    r.start(2)
    const parks = () => h.events.filter(e => e.type === 'turn.parked').length
    const finished = h.run('t2', 'the job', n => (n === 1 ? calling('c1') : say(`step ${n}`)))
    await until(() => parks() === 1)
    r.finish('run1', 'N1')
    await until(() => parks() === 2)
    h.box.send('F1')
    await until(() => parks() === 3)
    r.finish('run2', 'N2')
    await finished
    const last = lastOf(h.requests).messages
    const live = [...last, { role: 'assistant', parts: [{ type: 'text', text: `step ${h.requests.length}` }] } as Message]
    expect(JSON.stringify(h.rebuilt('t2', 'ignored', { includeCurrent: true }))).toBe(JSON.stringify(live))
  })
})

describe('Review Focus 5: a generated log stays valid at every boundary', () => {
  /** 确定性的小生成器:工具步、通知、后续消息、中断的调用、回滚、重复的 id */
  function generated(seed: number) {
    let state = seed
    const roll = (n: number) => {
      state = (state * 1103515245 + 12345) & 0x7fffffff
      return state % n
    }
    const events: KernelEvent[] = []
    const ev = (type: KernelEvent['type'], payload: object) => {
      const e = { seq: events.length + 1, ts: events.length + 1, type, sessionId: 's', payload } as KernelEvent
      events.push(e)
      return e
    }
    ev('session.created', {})
    const turns = 2 + roll(5)
    for (let t = 0; t < turns; t++) {
      const turnId = `t${t}`
      ev('message.user', { turnId, text: `q${t} ${'u'.repeat(roll(300))}` })
      if (roll(2)) ev('memory.injected', { turnId, kind: t === 0 ? 'session' : 'turn', text: `B${t}`, items: [] })
      const steps = 1 + roll(5)
      for (let s = 0; s < steps; s++) {
        const kind = roll(5)
        if (kind === 0) {
          ev('executor.notice', { turnId, step: s, runId: 'r', text: `notice ${t}.${s}` })
        } else if (kind === 1) {
          ev('message.user', { turnId, text: `follow ${t}.${s}`, followUp: true })
        } else if (kind === 2) {
          ev('message.assistant', { turnId, step: s, text: `say ${t}.${s}`, parts: [{ type: 'text', text: `say ${t}.${s}` }] })
        } else {
          const ids = roll(3) === 0 ? ['same'] : [`c${t}.${s}.0`, `c${t}.${s}.1`]
          ev('message.assistant', { turnId, step: s, text: '', parts: ids.map(id => ({ type: 'tool_call', id, name: 'read', args: `{"path":"${id}"}` })) })
          const answered = roll(4) === 0 ? ids.slice(0, ids.length - 1) : ids
          answered.forEach((id, i) => {
            if (i === 1 && roll(3) === 0) ev('executor.notice', { turnId, step: s, runId: 'r', text: `between ${t}.${s}` })
            if (i === 1 && roll(3) === 0) ev('message.user', { turnId, text: `between-follow ${t}.${s}`, followUp: true })
            ev('tool.ended', { turnId, callId: id, name: 'read', ok: true, ms: 1, content: 'x'.repeat(roll(800)) })
          })
        }
      }
      ev(roll(4) === 0 ? 'turn.failed' : 'turn.ended', { turnId })
      if (t === turns - 1 || (t > 0 && roll(5) === 0)) {
        if (t < turns - 1 || roll(2)) ev('turn.rolledBack', { turnId, files: 0 })
      }
    }
    return events
  }
  const rolledOf = (events: KernelEvent[]) => new Set(events.filter(e => e.type === 'turn.rolledBack').map(e => (e.payload as { turnId: string }).turnId))
  const OPTS: BuildOpts = { environment: 'ENV', reminder: ts => `R${ts}` }

  it('the writer boundary: for every value, the first thing above it is a message.user or message.assistant', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const events = generated(seed)
      const rolled = rolledOf(events)
      for (const b of safeBoundaries(events, rolled)) {
        const next = events.find(e => e.seq > b)!
        expect(['message.user', 'message.assistant']).toContain(next.type)
      }
    }
  })

  it('any throughSeq, safe or not: every request pairs its calls through the three codecs and keeps the first user message', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const events = generated(seed)
      const rolled = rolledOf(events)
      const firstTurn = events.find(e => e.type === 'message.user' && !rolled.has((e.payload as { turnId: string }).turnId))
      for (const e of events) {
        const out = buildMessages(events, 'tn', 'NEXT', { ...OPTS, now: 1, rebuild: { throughSeq: e.seq, text: 'S' } })
        expectValid(out)
        expect(lastOf(textsOf(lastOf(out)))).toBe('NEXT')
        if (firstTurn) expect(JSON.stringify(out[0])).toContain((firstTurn.payload as { text: string }).text.slice(0, 40))
      }
    }
  })

  it('a safe boundary: nothing above it is lost, nothing at or below it is repeated', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const events = generated(seed)
      const rolled = rolledOf(events)
      const walk = (e: KernelEvent) => !rolled.has((e.payload as { turnId?: string }).turnId ?? '')
      const answered = (e: KernelEvent) => e.type === 'tool.ended' || e.type === 'executor.notice' || (e.type === 'message.user' && (e.payload as { followUp?: boolean }).followUp)
      for (const b of safeBoundaries(events, rolled)) {
        const out = JSON.stringify(buildMessages(events, 'tn', 'NEXT', { ...OPTS, now: 1, rebuild: { throughSeq: b, text: 'S' } }))
        for (const e of events.filter(x => x.seq > b && walk(x) && answered(x))) {
          const p = e.payload as { text?: string; content?: string; callId?: string }
          if (e.type !== 'tool.ended' && p.text) expect(out).toContain(p.text)
        }
        for (const e of events.filter(x => x.seq <= b && walk(x) && x.type === 'executor.notice')) {
          expect(out).not.toContain(`"${(e.payload as { text: string }).text}"`)
        }
      }
    }
  })

  it('dropOldest over any of those, at any target: still valid, the first message and the current opening stay', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const events = generated(seed)
      const rolled = rolledOf(events)
      for (const b of [undefined, ...safeBoundaries(events, rolled)]) {
        const opts = { ...OPTS, now: 1, ...(b !== undefined && { rebuild: { throughSeq: b, text: 'S' } }) }
        const { messages, opening } = rebuildHistory(events, 'tn', 'NEXT', opts)
        for (const target of [0.5, 0.1, 0.01]) {
          const out = dropOldest(messages, { context: Math.max(1, estimateTokens(messages)), target, keepRecent: 0, currentOpening: opening })
          expectValid(out)
          expect(out.filter(m => m === messages[opening])).toHaveLength(1)
          expect(JSON.stringify(out[0])).toBe(JSON.stringify(messages[0]))
        }
      }
    }
  })

  it('an active marker and includeCurrent agree with the override, at every boundary', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const events = generated(seed)
      const rolled = rolledOf(events)
      for (const b of safeBoundaries(events, rolled)) {
        const withEvent = [...events]
        const asOf = events[events.length - 1].seq + 1
        withEvent.push({ seq: asOf, ts: asOf, type: 'memory.checkpoint', sessionId: 's', payload: { throughSeq: b, asOfSeq: asOf, text: 'S', model: 'm', tokens: 1, covers: 1 } } as KernelEvent)
        withEvent.push({ seq: asOf + 1, ts: asOf + 1, type: 'context.rebuilt', sessionId: 's', payload: { turnId: 'x', step: 1, checkpointSeq: asOf, throughSeq: b, before: 2, after: 1 } } as KernelEvent)
        expect(buildMessages(withEvent, 'tn', 'NEXT', { ...OPTS, now: 1 })).toEqual(buildMessages(events, 'tn', 'NEXT', { ...OPTS, now: 1, rebuild: { throughSeq: b, text: 'S' } }))
      }
    }
  })
})

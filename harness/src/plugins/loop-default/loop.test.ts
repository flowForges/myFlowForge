import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKernel, type Kernel } from '../../kernel/kernel'
import type { Plugin } from '../../kernel/pluginHost'
import type { Message, ModelEvent, ModelRequest, ModelsService } from '../../lib/models/types'
import type { KernelEvent } from '../../protocol/index'
import type { ModelRef } from '../../protocol/models'
import loopDirect from '../loop-direct'
import loopEcho from '../loop-echo'
import { createToolsCoding } from '../tools-coding'
import toolsRegistry from '../tools-registry'
import { createLoopDefault, type LoopDefaultOpts } from './index'
import { LOOP_REMINDER } from './loopGuard'

const posix = process.platform !== 'win32'

let root: string
let dataDir: string
let home: string
let cwd: string
let kernels: Kernel[] = []

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function waitFor(fn: () => boolean, ms = 5000) {
  const end = Date.now() + ms
  while (Date.now() < end && !fn()) await sleep(5)
  expect(fn()).toBe(true)
}
const pidFile = () => join(cwd, 'pid')
const pidOf = () => (existsSync(pidFile()) ? Number(readFileSync(pidFile(), 'utf8').trim()) : undefined)

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'mffai-loopdefault-')))
  dataDir = join(root, 'data')
  home = join(root, 'home')
  cwd = join(root, 'repo')
  mkdirSync(dataDir)
  mkdirSync(home)
  mkdirSync(cwd)
  writeFileSync(join(cwd, 'a.txt'), 'hello\n')
})
afterEach(async () => {
  for (const k of kernels) await k.close().catch(() => {})
  kernels = []
  const pid = pidOf()
  if (pid && alive(pid)) process.kill(pid, 'SIGKILL')
  rmSync(root, { recursive: true, force: true })
})

/** 隔离的基础环境:家目录与 git 全局配置都在临时目录 */
const baseEnv = () => ({
  PATH: process.env.PATH ?? '',
  HOME: home,
  USERPROFILE: home,
  GIT_CONFIG_GLOBAL: join(root, 'gitconfig'),
  GIT_CONFIG_NOSYSTEM: '1',
  ...(process.platform === 'win32' && { ComSpec: process.env.ComSpec, SystemRoot: process.env.SystemRoot, PATHEXT: process.env.PATHEXT }),
})
const noGit = async (): Promise<string> => {
  throw new Error('git disabled in tests')
}

type Req = Omit<ModelRequest, 'model'>
interface Call { ref: ModelRef | 'default'; req: Req; messages: Message[] }
type Script = (n: number, req: Req) => AsyncIterable<ModelEvent>
const GPT: ModelRef = { accountId: 'acc', modelId: 'gpt-5' }
const CLAUDE: ModelRef = { accountId: 'acc', modelId: 'claude-sonnet-4-5' }

function fakeModels(calls: Call[], script: Script, def?: ModelRef | (() => ModelRef | undefined)): Plugin {
  const service = {
    catalog: () => ({ presets: [], models: {}, default: typeof def === 'function' ? def() : def }),
    accounts: () => [],
    stream(ref: ModelRef | 'default', req: Req) {
      calls.push({ ref, req, messages: structuredClone(req.messages) })
      return script(calls.length, req)
    },
  } as unknown as ModelsService
  return {
    manifest: { id: 'fake-models', version: '0', kernel: '^0.1.0', provides: ['models'] },
    activate: ctx => ctx.services.provide('models', service),
  }
}
async function* seq(...evs: ModelEvent[]) {
  for (const e of evs) yield e
}
const done = (reason: 'stop' | 'tool_calls' = 'stop'): ModelEvent => ({ type: 'done', reason })
/** 一个工具调用,参数分两段到达 */
function* toolCall(id: string, name: string, args: object | string): Generator<ModelEvent> {
  const s = typeof args === 'string' ? args : JSON.stringify(args)
  const mid = Math.floor(s.length / 2)
  yield { type: 'tool_call', id, name, argsDelta: s.slice(0, mid) }
  yield { type: 'tool_call', id, argsDelta: s.slice(mid) }
}
const calling = (id: string, name: string, args: object | string) => seq(...toolCall(id, name, args), done('tool_calls'))
const say = (text: string) => seq({ type: 'text', delta: text }, { type: 'usage', input: 1, output: 1 }, done())

interface BootOpts { disabled?: string[]; loop?: LoopDefaultOpts; extra?: Plugin[] }
async function boot(calls: Call[], script: Script, opts: BootOpts = {}, def?: ModelRef | (() => ModelRef | undefined)) {
  if (opts.disabled) writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ plugins: { disabled: opts.disabled } }))
  const k = await createKernel({
    dataDir,
    home,
    secrets: { osBackend: false },
    injectTimeoutMs: 100,
    plugins: [
      fakeModels(calls, script, def),
      toolsRegistry,
      createToolsCoding({ shellEnv: baseEnv(), loginPath: async () => '', git: noGit, minTimeoutMs: 100 }),
      createLoopDefault(opts.loop),
      loopDirect,
      loopEcho,
      ...(opts.extra ?? []),
    ],
  })
  kernels.push(k)
  return k
}
async function create(k: Kernel, o: { model?: ModelRef; cwd?: string | null; approvalMode?: 'ask' | 'auto'; toolset?: 'patch' | 'edit' } = {}) {
  const dir = o.cwd === null ? undefined : (o.cwd ?? cwd)
  const r = (await k.handle('session.create', {
    commandId: `c${Math.random()}`,
    ...(o.model && { model: o.model }),
    ...(dir && { cwd: dir }),
    ...(o.approvalMode && { approvalMode: o.approvalMode }),
    ...(o.toolset && { toolset: o.toolset }),
  })) as { sessionId: string }
  return r.sessionId
}
const prompt = async (k: Kernel, sid: string, text: string) =>
  ((await k.handle('session.prompt', { commandId: `p${Math.random()}`, sessionId: sid, text })) as { turnId: string }).turnId
const evs = (k: Kernel, sid: string) => k.events.bySession(sid)
const terminal = (k: Kernel, sid: string) => evs(k, sid).filter(e => e.type === 'turn.ended' || e.type === 'turn.failed')
async function turn(k: Kernel, sid: string, text: string) {
  const want = terminal(k, sid).length + 1
  const turnId = await prompt(k, sid, text)
  await waitFor(() => terminal(k, sid).length === want)
  return turnId
}
const pay = <T = Record<string, unknown>>(e: KernelEvent | undefined) => e?.payload as T
const toolNames = (c: Call) => (c.req.tools ?? []).map(t => t.name)
const toolResults = (m: Message[]) => m.filter(x => x.role === 'tool').flatMap(x => x.parts).filter(p => p.type === 'tool_result') as { callId: string; content: string; isError?: boolean }[]
const node = JSON.stringify(process.execPath)

describe('loop-default: bail chain', () => {
  it('no cwd → loop-direct answers (no tools in the request)', async () => {
    const calls: Call[] = []
    const k = await boot(calls, () => say('plain'))
    const sid = await create(k, { model: GPT, cwd: null })
    await turn(k, sid, 'hi')
    expect(calls).toHaveLength(1)
    expect(calls[0].req.tools).toBeUndefined()
    expect(pay(evs(k, sid).find(e => e.type === 'message.assistant'))).toEqual({ turnId: expect.any(String), text: 'plain' })
  })

  it('cwd but no model and no default → loop-echo answers', async () => {
    const calls: Call[] = []
    const k = await boot(calls, () => say('x'))
    const sid = await create(k)
    await turn(k, sid, 'hi')
    expect(calls).toHaveLength(0)
    expect(pay(evs(k, sid).find(e => e.type === 'message.assistant'))).toMatchObject({ text: 'echo: hi' })
  })

  it('cwd + model but tools-registry disabled → turn.failed tools_unavailable, no model request', async () => {
    const calls: Call[] = []
    const k = await boot(calls, () => say('x'), { disabled: ['tools-registry'] })
    const sid = await create(k, { model: GPT })
    await turn(k, sid, 'hi')
    expect(calls).toHaveLength(0)
    expect(terminal(k, sid).map(e => [e.type, pay(e).reason])).toEqual([['turn.failed', 'tools_unavailable']])
    expect(evs(k, sid).some(e => e.type === 'message.assistant')).toBe(false)
  })

  it('uses the registry default model when the session has none', async () => {
    const calls: Call[] = []
    const k = await boot(calls, () => say('ok'), {}, CLAUDE)
    const sid = await create(k)
    await turn(k, sid, 'hi')
    expect(calls[0].ref).toBe('default')
    expect(toolNames(calls[0])).toContain('edit')
    expect(terminal(k, sid)[0].type).toBe('turn.ended')
  })
})

describe('loop-default: one coding turn', () => {
  it.skipIf(!posix)('read → apply_patch → shell → final text: events in order, file changed, results fed back', async () => {
    const patch = '*** Begin Patch\n*** Update File: a.txt\n@@\n-hello\n+hello mff\n*** End Patch'
    const calls: Call[] = []
    const k = await boot(calls, n => {
      if (n === 1) return seq({ type: 'reasoning', delta: 'think' }, { type: 'reasoning', replay: { id: 'r1' } }, { type: 'text', delta: 'Reading.' }, ...toolCall('c1', 'read', { path: 'a.txt' }), { type: 'usage', input: 10, output: 2 }, done('tool_calls'))
      if (n === 2) return calling('c2', 'apply_patch', { patch })
      if (n === 3) return calling('c3', 'shell', { command: `${node} -e "process.exit(0)"` })
      return say('done')
    })
    const sid = await create(k, { model: GPT, approvalMode: 'auto' })
    const turnId = await turn(k, sid, 'fix it')

    const keep = new Set(['turn.started', 'message.assistant', 'tool.started', 'tool.ended', 'turn.ended', 'turn.failed'])
    const main = evs(k, sid).filter(e => keep.has(e.type))
    expect(main.map(e => e.type)).toEqual([
      'turn.started',
      'message.assistant', 'tool.started', 'tool.ended',
      'message.assistant', 'tool.started', 'tool.ended',
      'message.assistant', 'tool.started', 'tool.ended',
      'message.assistant', 'turn.ended',
    ])
    expect(main.every(e => pay(e).turnId === turnId)).toBe(true)
    const steps = main.filter(e => e.type === 'message.assistant').map(e => pay<{ step: number; parts: unknown[] }>(e))
    expect(steps.map(s => s.step)).toEqual([1, 2, 3, 4])
    expect(steps[0]).toEqual({
      turnId, step: 1, text: 'Reading.',
      parts: [{ type: 'reasoning', replay: { id: 'r1' }, accountId: 'acc', modelId: 'gpt-5' }, { type: 'text', text: 'Reading.' }, { type: 'tool_call', id: 'c1', name: 'read', args: '{"path":"a.txt"}' }],
    })
    expect(steps[3]).toMatchObject({ step: 4, text: 'done', parts: [{ type: 'text', text: 'done' }] })
    expect(main.filter(e => e.type === 'tool.ended').map(e => pay(e).ok)).toEqual([true, true, true])
    expect(String(pay(main[9]).content)).toMatch(/^exit 0/)
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('hello mff\n')

    // 每步的 delta / usage 带 step
    expect(evs(k, sid).filter(e => e.type === 'message.reasoning.delta').map(e => pay(e))).toEqual([{ turnId, step: 1, text: 'think' }])
    expect(pay(evs(k, sid).find(e => e.type === 'message.assistant.delta'))).toEqual({ turnId, step: 1, text: 'Reading.' })
    expect(evs(k, sid).filter(e => e.type === 'turn.usage').map(e => pay(e).step)).toEqual([1, 4])

    // 第 2 步的请求带着第 1 步的工具调用与结果
    expect(calls).toHaveLength(4)
    const m2 = calls[1].messages
    expect(m2.at(-2)).toEqual({ role: 'assistant', parts: [{ type: 'reasoning', replay: { id: 'r1' } }, ...steps[0].parts.slice(1)] })
    expect(toolResults(m2)).toEqual([{ type: 'tool_result', callId: 'c1', content: expect.stringContaining('hello') }])
    expect(calls[0].req).toMatchObject({ interactive: true, reasoning: 'medium' })
    expect(calls[0].req.toolChoice).toBeUndefined()
  })

  it('gpt gets apply_patch and not edit/write; claude the reverse; toolset override wins', async () => {
    const calls: Call[] = []
    const k = await boot(calls, () => say('ok'))
    for (const o of [{ model: GPT }, { model: CLAUDE }, { model: GPT, toolset: 'edit' as const }, { model: CLAUDE, toolset: 'patch' as const }]) {
      const sid = await create(k, o)
      await turn(k, sid, 'hi')
    }
    expect(toolNames(calls[0])).toEqual(['read', 'list', 'glob', 'grep', 'apply_patch', 'shell'])
    expect(toolNames(calls[1])).toEqual(['read', 'list', 'glob', 'grep', 'write', 'edit', 'shell'])
    expect(toolNames(calls[2])).toEqual(['read', 'list', 'glob', 'grep', 'write', 'edit', 'shell'])
    expect(toolNames(calls[3])).toEqual(['read', 'list', 'glob', 'grep', 'apply_patch', 'shell'])
    expect(calls[0].req.system).not.toBe(calls[1].req.system)
  })

  it('tool-call arguments are redacted in message.assistant but the tool gets the original', async () => {
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz0123'
    const calls: Call[] = []
    const k = await boot(calls, n => (n === 1 ? calling('c1', 'write', { path: 'k.txt', content: secret }) : say('ok')))
    const sid = await create(k, { model: CLAUDE })
    await turn(k, sid, 'hi')
    expect(readFileSync(join(cwd, 'k.txt'), 'utf8')).toBe(secret)
    expect(JSON.stringify(evs(k, sid))).not.toContain(secret)
    const parts = pay<{ parts: { type: string; args?: string }[] }>(evs(k, sid).find(e => e.type === 'message.assistant')).parts
    expect(parts.find(p => p.type === 'tool_call')?.args).toContain('***')
    // 本轮内模型拿到原文
    expect(JSON.stringify(calls[1].messages)).toContain(secret)
  })

  it('logged args keep the raw string byte for byte when nothing was redacted', async () => {
    const raw = '{ "path" : "a.txt",\n  "limit": 5 }'
    const calls: Call[] = []
    const k = await boot(calls, n => (n === 1 ? calling('c1', 'read', raw) : say('ok')))
    const sid = await create(k, { model: CLAUDE })
    await turn(k, sid, 'q1')
    await turn(k, sid, 'q2')
    const parts = pay<{ parts: { type: string; args?: string }[] }>(evs(k, sid).find(e => e.type === 'message.assistant')).parts
    expect(parts.find(p => p.type === 'tool_call')?.args).toBe(raw)
    // 下一轮重建的历史与当时发出的完全一样
    expect(calls[2].messages[1]).toEqual(calls[1].messages[1])
    expect((calls[2].messages[1].parts[0] as { args: string }).args).toBe(raw)
  })

  it('logged args stay valid JSON (PEM without END) and odd names are redacted and capped', async () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEabc'
    const longName = `sk-abcdefghijklmnopqrstuvwxyz0123.${'y'.repeat(500)}`
    const calls: Call[] = []
    const k = await boot(calls, n => (n === 1 ? seq(...toolCall('c1', 'write', { path: 'k.pem', content: pem }), ...toolCall('c2', longName, '{"a":'), done('tool_calls')) : say('ok')))
    const sid = await create(k, { model: CLAUDE })
    await turn(k, sid, 'hi')
    const parts = pay<{ parts: { type: string; name?: string; args?: string }[] }>(evs(k, sid).find(e => e.type === 'message.assistant')).parts.filter(p => p.type === 'tool_call')
    expect(JSON.parse(parts[0].args!)).toEqual({ path: 'k.pem', content: '***' })
    expect(JSON.parse(parts[1].args!)).toEqual({ _unparsed: '{"a":' })
    expect(parts[1].name!.length).toBe(200)
    expect(parts[1].name!.startsWith('***.')).toBe(true)
    expect(readFileSync(join(cwd, 'k.pem'), 'utf8')).toBe(pem)
  })
})

describe('loop-default: approvals', () => {
  const marker = () => join(cwd, 'marker')
  const writeMarker = () => ({ command: `${node} -e "require('fs').writeFileSync('marker','x')"` })

  it.skipIf(!posix)('ask → approval.requested → allow → the command runs', async () => {
    const calls: Call[] = []
    const k = await boot(calls, n => (n === 1 ? calling('c1', 'shell', writeMarker()) : say('ran')))
    const sid = await create(k, { model: GPT })
    await prompt(k, sid, 'go')
    await waitFor(() => evs(k, sid).some(e => e.type === 'approval.requested'))
    const req = pay<{ approvalId: string; summary: string }>(evs(k, sid).find(e => e.type === 'approval.requested'))
    expect(req.summary).toContain('marker')
    expect(await k.handle('approval.respond', { approvalId: req.approvalId, decision: 'allow' })).toEqual({ ok: true })
    await waitFor(() => terminal(k, sid).length === 1)
    expect(terminal(k, sid)[0].type).toBe('turn.ended')
    expect(existsSync(marker())).toBe(true)
    expect(String(toolResults(calls[1].messages)[0].content)).toMatch(/^exit 0/)
  })

  it.skipIf(!posix)('deny → the model sees 用户拒绝了该操作 and the loop continues', async () => {
    const calls: Call[] = []
    const k = await boot(calls, n => (n === 1 ? calling('c1', 'shell', writeMarker()) : say('ok, not running it')))
    const sid = await create(k, { model: GPT })
    await prompt(k, sid, 'go')
    await waitFor(() => evs(k, sid).some(e => e.type === 'approval.requested'))
    const { approvalId } = pay<{ approvalId: string }>(evs(k, sid).find(e => e.type === 'approval.requested'))
    await k.handle('approval.respond', { approvalId, decision: 'deny' })
    await waitFor(() => terminal(k, sid).length === 1)
    expect(terminal(k, sid)[0].type).toBe('turn.ended')
    expect(existsSync(marker())).toBe(false)
    expect(calls).toHaveLength(2)
    expect(toolResults(calls[1].messages)).toEqual([{ type: 'tool_result', callId: 'c1', content: '用户拒绝了该操作', isError: true }])
  })

  it.skipIf(!posix)('Review Focus 3: cancel while waiting for approval → resolved by cancel, no command, turn.failed cancelled, no further model request', async () => {
    const calls: Call[] = []
    // 同一步里第二个调用:取消后不再发起
    const k = await boot(calls, n => (n === 1 ? seq(...toolCall('c1', 'shell', writeMarker()), ...toolCall('c2', 'write', { path: 'later.txt', content: 'x' }), done('tool_calls')) : say('should not happen')))
    const sid = await create(k, { model: CLAUDE })
    await prompt(k, sid, 'go')
    await waitFor(() => evs(k, sid).some(e => e.type === 'approval.requested'))
    await k.handle('session.cancel', { commandId: 'cx', sessionId: sid })
    await waitFor(() => terminal(k, sid).length === 1)
    await sleep(100)
    const resolved = evs(k, sid).filter(e => e.type === 'approval.resolved')
    expect(resolved.map(e => pay(e))).toEqual([expect.objectContaining({ by: 'cancel', decision: 'deny' })])
    expect(existsSync(marker())).toBe(false)
    expect(terminal(k, sid).map(e => [e.type, pay(e).reason])).toEqual([['turn.failed', 'cancelled']])
    expect(calls).toHaveLength(1)
    expect(evs(k, sid).filter(e => e.type === 'message.assistant')).toHaveLength(1)
    expect(evs(k, sid).filter(e => e.type === 'tool.started').map(e => pay(e).callId)).toEqual(['c1'])
    expect(existsSync(join(cwd, 'later.txt'))).toBe(false)
  })
})

describe('loop-default: cancel and shutdown', () => {
  it.skipIf(!posix)('cancel during a running shell kills the process tree and fails the turn as cancelled', async () => {
    const calls: Call[] = []
    const k = await boot(calls, n => (n === 1 ? calling('c1', 'shell', { command: 'sleep 60 & echo $! > pid; wait' }) : say('no')))
    const sid = await create(k, { model: GPT, approvalMode: 'auto' })
    await prompt(k, sid, 'go')
    await waitFor(() => pidOf() !== undefined)
    await k.handle('session.cancel', { commandId: 'cx', sessionId: sid })
    await waitFor(() => terminal(k, sid).length === 1)
    expect(pay(terminal(k, sid)[0]).reason).toBe('cancelled')
    await waitFor(() => !alive(pidOf()!), 2000)
    expect(calls).toHaveLength(1)
  })

  it.skipIf(!posix)('a shell that ignores SIGTERM: cancel still yields exactly one terminal event', async () => {
    const calls: Call[] = []
    const k = await boot(calls, n => (n === 1 ? calling('c1', 'shell', { command: "trap '' TERM; sleep 30 & echo $! > pid; wait" }) : say('no')))
    const sid = await create(k, { model: GPT, approvalMode: 'auto' })
    await prompt(k, sid, 'go')
    await waitFor(() => pidOf() !== undefined)
    await sleep(50)
    await k.handle('session.cancel', { commandId: 'cx', sessionId: sid })
    // 内核 1 s 宽限后写 cancelled;shell 2 s 后 SIGKILL,循环随后也想写一条
    await waitFor(() => evs(k, sid).some(e => e.type === 'tool.ended'), 5000)
    await waitFor(() => !alive(pidOf()!), 2000)
    await sleep(100)
    expect(terminal(k, sid).map(e => [e.type, pay(e).reason])).toEqual([['turn.failed', 'cancelled']])
    expect(calls).toHaveLength(1)
  })

  it.skipIf(!posix)('kernel.close aborts a running shell before it returns', async () => {
    const calls: Call[] = []
    const k = await boot(calls, n => (n === 1 ? calling('c1', 'shell', { command: 'sleep 60 & echo $! > pid; wait' }) : say('no')))
    const sid = await create(k, { model: GPT, approvalMode: 'auto' })
    await prompt(k, sid, 'go')
    await waitFor(() => pidOf() !== undefined)
    await k.close()
    kernels = []
    await waitFor(() => !alive(pidOf()!), 2000)
    // 重开:这一轮已以 cancelled 收尾,不是 interrupted
    const k2 = await boot(calls, () => say('x'))
    expect(terminal(k2, sid).map(e => pay(e).reason)).toEqual(['cancelled'])
  })

  it('a cancelled model stream fails the turn as cancelled', async () => {
    const calls: Call[] = []
    const k = await boot(calls, async function* (_n, req) {
      yield { type: 'text', delta: 'x' } as ModelEvent
      await new Promise<void>(r => req.signal.addEventListener('abort', () => r()))
      yield { type: 'done', reason: 'cancelled' } as ModelEvent
    })
    const sid = await create(k, { model: GPT })
    await prompt(k, sid, 'go')
    await waitFor(() => evs(k, sid).some(e => e.type === 'message.assistant.delta'))
    await k.handle('session.cancel', { commandId: 'cx', sessionId: sid })
    await waitFor(() => terminal(k, sid).length === 1)
    expect(terminal(k, sid).map(e => pay(e).reason)).toEqual(['cancelled'])
    expect(evs(k, sid).some(e => e.type === 'message.assistant')).toBe(false)
  })
})

describe('loop-default: limits', () => {
  it('maxSteps 3: request #3 has toolChoice none; still calling tools → turn.failed max_steps', async () => {
    const calls: Call[] = []
    const k = await boot(calls, n => calling(`c${n}`, 'read', { path: 'a.txt', offset: n }), { loop: { maxSteps: 3 } })
    const sid = await create(k, { model: GPT })
    await turn(k, sid, 'go')
    expect(calls).toHaveLength(3)
    expect(calls.map(c => c.req.toolChoice)).toEqual([undefined, undefined, 'none'])
    expect(terminal(k, sid).map(e => [e.type, pay(e).reason])).toEqual([['turn.failed', 'max_steps']])
    expect(evs(k, sid).filter(e => e.type === 'tool.started')).toHaveLength(2)
    expect(evs(k, sid).filter(e => e.type === 'message.assistant')).toHaveLength(3)
  })

  it('maxSteps: the last step answering in text ends the turn normally', async () => {
    const calls: Call[] = []
    const k = await boot(calls, n => (n < 2 ? calling(`c${n}`, 'read', { path: 'a.txt' }) : say('summary')), { loop: { maxSteps: 2 } })
    const sid = await create(k, { model: GPT })
    await turn(k, sid, 'go')
    expect(calls[1].req.toolChoice).toBe('none')
    expect(terminal(k, sid)[0].type).toBe('turn.ended')
  })

  it('loop guard: warns on the 3rd identical call (keys in any order) and stops on the 5th', async () => {
    const calls: Call[] = []
    const k = await boot(calls, n => calling(`c${n}`, 'read', n % 2 ? '{"path":"a.txt","limit":5}' : '{"limit":5,"path":"a.txt"}'))
    const sid = await create(k, { model: GPT })
    await turn(k, sid, 'go')
    expect(terminal(k, sid).map(e => [e.type, pay(e).reason])).toEqual([['turn.failed', 'loop']])
    expect(calls).toHaveLength(5)
    expect(evs(k, sid).filter(e => e.type === 'tool.started')).toHaveLength(4)
    const results = toolResults(calls[4].messages)
    expect(results.map(r => r.content.includes(LOOP_REMINDER))).toEqual([false, false, true, true])
  })
})

describe('loop-default: model errors', () => {
  const rateLimited: ModelEvent = { type: 'done', reason: 'error', error: { kind: 'rate_limit', message: 'slow down', retryable: true, retryAfterMs: 1234 } }

  it('rate_limit before any output → waits retryAfterMs (injected sleep) and retries', async () => {
    const calls: Call[] = []
    const slept: number[] = []
    const k = await boot(calls, n => (n === 1 ? seq({ type: 'reasoning', delta: 'hm' }, rateLimited) : say('ok')), {
      loop: { sleep: async ms => { slept.push(ms) } },
    })
    const sid = await create(k, { model: GPT })
    await turn(k, sid, 'go')
    expect(slept).toEqual([1234])
    expect(calls).toHaveLength(2)
    expect(terminal(k, sid)[0].type).toBe('turn.ended')
  })

  it('rate_limit retries at most twice per turn, wait capped at 60 s, default 5 s', async () => {
    const calls: Call[] = []
    const slept: number[] = []
    const k = await boot(calls, n => seq(n === 1 ? { ...rateLimited, error: { ...rateLimited.error!, retryAfterMs: 999_999 } } : { type: 'done', reason: 'error', error: { kind: 'rate_limit', message: 'x', retryable: true } }), {
      loop: { sleep: async ms => { slept.push(ms) } },
    })
    const sid = await create(k, { model: GPT })
    await turn(k, sid, 'go')
    expect(slept).toEqual([60_000, 5_000])
    expect(calls).toHaveLength(3)
    expect(terminal(k, sid).map(e => [e.type, pay(e).reason])).toEqual([['turn.failed', 'rate_limit']])
  })

  it('rate_limit after output → no retry, turn.failed rate_limit', async () => {
    const calls: Call[] = []
    const slept: number[] = []
    const k = await boot(calls, () => seq({ type: 'text', delta: 'partial' }, rateLimited), { loop: { sleep: async ms => { slept.push(ms) } } })
    const sid = await create(k, { model: GPT })
    await turn(k, sid, 'go')
    expect(slept).toEqual([])
    expect(calls).toHaveLength(1)
    expect(terminal(k, sid).map(e => [e.type, pay(e).reason, pay(e).message])).toEqual([['turn.failed', 'rate_limit', 'slow down']])
  })

  it('non-retryable error → turn.failed with its kind', async () => {
    const calls: Call[] = []
    const k = await boot(calls, () => seq({ type: 'done', reason: 'error', error: { kind: 'auth', message: 'bad key', retryable: false } }))
    const sid = await create(k, { model: GPT })
    await turn(k, sid, 'go')
    expect(terminal(k, sid).map(e => pay(e).reason)).toEqual(['auth'])
  })
})

describe('loop-default: history and prompts', () => {
  it('history across turns includes the previous turn tool calls and results; system prompt is stable; no environment in events', async () => {
    const calls: Call[] = []
    const k = await boot(calls, n => (n === 1 ? calling('c1', 'read', { path: 'a.txt' }) : say(`answer${n}`)))
    const sid = await create(k, { model: CLAUDE })
    await turn(k, sid, 'q1')
    await turn(k, sid, 'q2')
    expect(calls).toHaveLength(3)
    const m = calls[2].messages
    expect(m.map(x => x.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'user'])
    expect(m[0].parts).toHaveLength(3) // 环境块 + 日期提醒 + 原文,每轮重建都一样
    expect(m[0].parts[0]).toMatchObject({ type: 'text', text: expect.stringMatching(/^<environment>[\s\S]*<\/environment>$/) })
    expect((m[0].parts[0] as { text: string }).text).toContain(cwd)
    expect(m[0].parts[1]).toMatchObject({ type: 'text', text: expect.stringMatching(/^<reminder>date: \d{4}-\d{2}-\d{2}<\/reminder>$/) })
    expect(m[0].parts[2]).toEqual({ type: 'text', text: 'q1' })
    // 前缀逐字节相同:第 1 轮最后一次请求的消息原样是第 2 轮请求的开头
    expect(m.slice(0, calls[1].messages.length)).toEqual(calls[1].messages)
    expect(calls[1].messages[0]).toEqual(calls[0].messages[0])
    expect(m[1].parts).toEqual([{ type: 'tool_call', id: 'c1', name: 'read', args: '{"path":"a.txt"}' }])
    expect(toolResults(m)[0]).toMatchObject({ callId: 'c1', content: expect.stringContaining('hello') })
    expect(m[3].parts).toEqual([{ type: 'text', text: 'answer2' }])
    const last = m.at(-1)!.parts
    expect(last).toHaveLength(2)
    expect(last[0]).toMatchObject({ type: 'text', text: expect.stringMatching(/^<reminder>date: /) })
    expect(last[1]).toEqual({ type: 'text', text: 'q2' })
    expect(calls[0].req.system).toBeTruthy()
    expect(calls[2].req.system).toBe(calls[0].req.system)
    expect(calls[0].req.system).not.toContain(cwd)
    expect(JSON.stringify(k.events.after(0))).not.toMatch(/<environment>|<reminder>/)
  })

  it('synthetic crash mid-tool (events written by hand, then restart) → the unpaired call gets the 已中断 pad', async () => {
    const calls: Call[] = []
    let writer: ((e: Omit<KernelEvent, 'seq' | 'ts'>) => KernelEvent) | undefined
    const probe: Plugin = { manifest: { id: 'probe', version: '0', kernel: '^0.1.0' }, activate: ctx => { writer = e => ctx.append(e) } }
    const k = await boot(calls, () => say('x'), { extra: [probe] })
    const sid = await create(k, { model: CLAUDE })
    // 崩在工具执行中:有 tool.started,没有 tool.ended,也没有终态
    writer!({ type: 'message.user', sessionId: sid, payload: { turnId: 't0', text: 'q0' } })
    writer!({ type: 'turn.started', sessionId: sid, payload: { turnId: 't0' } })
    writer!({ type: 'message.assistant', sessionId: sid, payload: { turnId: 't0', step: 1, text: '', parts: [{ type: 'tool_call', id: 'c9', name: 'shell', args: '{"command":"make"}' }] } })
    writer!({ type: 'tool.started', sessionId: sid, payload: { turnId: 't0', callId: 'c9', name: 'shell', argsPreview: '' } })
    await k.close()
    kernels = []
    const k2 = await boot(calls, () => say('after'))
    expect(terminal(k2, sid).map(e => pay(e).reason)).toEqual(['interrupted'])
    await turn(k2, sid, 'q1')
    const m = calls[0].messages
    expect(m.map(x => x.role)).toEqual(['user', 'assistant', 'tool', 'user'])
    expect(toolResults(m)).toEqual([{ type: 'tool_result', callId: 'c9', content: '已中断', isError: true }])
  })

  it("a 'default' session whose default switches model does not replay the old model's reasoning", async () => {
    const calls: Call[] = []
    let def: ModelRef = CLAUDE
    const k = await boot(calls, n => (n === 1 ? seq({ type: 'reasoning', replay: { type: 'thinking', signature: 's' } }, { type: 'text', delta: 'a1' }, done()) : say('a')), {}, () => def)
    const sid = await create(k)
    await turn(k, sid, 'q1')
    await turn(k, sid, 'q2')
    expect(calls[1].messages[1].parts).toEqual([{ type: 'reasoning', replay: { type: 'thinking', signature: 's' } }, { type: 'text', text: 'a1' }])
    def = GPT
    await turn(k, sid, 'q3')
    expect(calls[2].messages[1].parts).toEqual([{ type: 'text', text: 'a1' }])
  })
})

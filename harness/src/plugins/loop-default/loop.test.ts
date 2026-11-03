import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKernel, type Kernel } from '../../kernel/kernel'
import { createGit } from '../../lib/git/snapshot'
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
import { buildMessages, INTERRUPTED, noticeMessage } from './history'
import { runTurn, type LoopDeps, type TurnOutcome } from './loop'
import { dateReminder } from './prompts/index'
import type { BackgroundRuns, FollowUp, RunNotice, ToolsService, TurnInbox } from '../../lib/tools/types'
import { ERR_BUSY } from '../../protocol/index'
import { NO_SANDBOX, seedUnsandboxedAuto } from '../../../test/sandboxStub'

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
/** 快照用的 git:同样隔离,且不往临时目录之外找仓库(cwd 不是仓库 → not_git) */
const snapshotGit = () =>
  createGit({ base: { PATH: process.env.PATH ?? '', HOME: home, USERPROFILE: home }, extraEnv: { GIT_CONFIG_GLOBAL: join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', HOME: home, GIT_CEILING_DIRECTORIES: root } })
const noGit = async (): Promise<string> => {
  throw new Error('git disabled in tests')
}

type Req = Omit<ModelRequest, 'model'>
interface Call { ref: ModelRef | 'default'; req: Req; messages: Message[] }
type Script = (n: number, req: Req) => AsyncIterable<ModelEvent>
const GPT: ModelRef = { accountId: 'acc', modelId: 'gpt-5' }
const CLAUDE: ModelRef = { accountId: 'acc', modelId: 'claude-sonnet-4-5' }

function fakeModels(calls: Call[], script: Script, def?: ModelRef | (() => ModelRef | undefined), context?: number): Plugin {
  const entry = (id: string) => ({ id, name: id, context: context!, output: 1000, image: false, reasoning: 'none', toolCall: true })
  const service = {
    catalog: () => ({ presets: [], models: {}, default: typeof def === 'function' ? def() : def }),
    accounts: () => (context ? [{ id: 'acc', presetId: 'p', label: 'acc', state: 'ok', models: [entry(GPT.modelId), entry(CLAUDE.modelId)] }] : []),
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

interface BootOpts { disabled?: string[]; loop?: LoopDefaultOpts; extra?: Plugin[]; context?: number }
async function boot(calls: Call[], script: Script, opts: BootOpts = {}, def?: ModelRef | (() => ModelRef | undefined)) {
  // auto 会话的 03 用例:NO_SANDBOX 下显式放开无沙箱 auto(R22)
  seedUnsandboxedAuto(dataDir, opts.disabled ? { plugins: { disabled: opts.disabled } } : {})
  const k = await createKernel({ sandbox: NO_SANDBOX,
    dataDir,
    home,
    secrets: { osBackend: false },
    injectTimeoutMs: 100,
    plugins: [
      fakeModels(calls, script, def, opts.context),
      toolsRegistry,
      createToolsCoding({ shellEnv: baseEnv(), loginPath: async () => '', git: noGit, minTimeoutMs: 100 }),
      createLoopDefault({ git: snapshotGit(), ...opts.loop }),
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
    expect(evs(k, sid).some(e => e.type === 'turn.snapshot')).toBe(false)
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

    const keep = new Set(['turn.started', 'turn.snapshot', 'message.assistant', 'tool.started', 'tool.ended', 'turn.ended', 'turn.failed'])
    const main = evs(k, sid).filter(e => keep.has(e.type))
    expect(main.map(e => e.type)).toEqual([
      'turn.started', 'turn.snapshot',
      'message.assistant', 'tool.started', 'tool.ended',
      'message.assistant', 'tool.started', 'tool.ended',
      'message.assistant', 'tool.started', 'tool.ended',
      'message.assistant', 'turn.snapshot', 'turn.ended',
    ])
    // cwd 不是 git 仓库:两张快照都只带 reason
    expect(main.filter(e => e.type === 'turn.snapshot').map(e => pay(e))).toEqual([
      { turnId, phase: 'start', reason: 'not_git' },
      { turnId, phase: 'end', reason: 'not_git' },
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
    expect(String(pay(main[10]).content)).toMatch(/^exit 0/)
    expect(pay(main.at(-1))).toEqual({ turnId }) // turn.ended 的载荷不变
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

describe('loop-default: compaction', () => {
  it('over the model context: an older read of the same file is folded in the request, the events keep the full result', async () => {
    const calls: Call[] = []
    const k = await boot(calls, n => (n <= 2 ? calling(`c${n}`, 'read', { path: n === 1 ? 'a.txt' : './a.txt' }) : say('ok')), { context: 1 })
    const sid = await create(k, { model: CLAUDE })
    await turn(k, sid, 'go')
    expect(calls).toHaveLength(3)
    expect(toolResults(calls[1].messages).map(r => r.content)).toEqual([expect.stringContaining('hello')])
    expect(toolResults(calls[2].messages).map(r => r.content)).toEqual(['[已折叠:read a.txt,需要时重新读取]', expect.stringContaining('hello')])
    expect(calls[2].messages[0]).toEqual(calls[0].messages[0]) // 第一条用户消息(含环境块)不动
    expect(evs(k, sid).filter(e => e.type === 'tool.ended').map(e => String(pay(e).content))).toEqual([expect.stringContaining('hello'), expect.stringContaining('hello')])
  })

  it('under the threshold nothing is folded (default 128 000 context)', async () => {
    const calls: Call[] = []
    const k = await boot(calls, n => (n <= 2 ? calling(`c${n}`, 'read', { path: n === 1 ? 'a.txt' : './a.txt' }) : say('ok')))
    const sid = await create(k, { model: CLAUDE })
    await turn(k, sid, 'go')
    expect(toolResults(calls[2].messages).every(r => r.content.includes('hello'))).toBe(true)
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

/** 脚本化的 BackgroundRuns:`wait` 在已有通知时立刻 resolve(运行结束在 active() 与 wait() 之间的情形) */
function scriptedRuns(onAbandon?: (reason?: string) => Promise<void>) {
  let active = 0
  const notices: RunNotice[] = []
  const wakers = new Set<() => void>()
  const calls = { abandon: [] as (string | undefined)[], activeAtAbandon: [] as number[], waits: 0 }
  const runs: BackgroundRuns & { start(n?: number): void; end(runId: string, text?: string): void; calls: typeof calls } = {
    calls,
    start: (n = 1) => { active += n },
    end(runId, text = `<executor-notice run="${runId}" status="ok">done</executor-notice>`) {
      active--
      notices.push({ runId, text })
      for (const w of [...wakers]) w()
    },
    active: () => active,
    pending: () => notices.length,
    take: () => notices.splice(0),
    wait: (_turnId, signal) => {
      calls.waits++
      return new Promise<void>(resolve => {
        if (notices.length || signal.aborted) return resolve()
        const done = () => {
          wakers.delete(done)
          signal.removeEventListener('abort', done)
          resolve()
        }
        wakers.add(done)
        signal.addEventListener('abort', done, { once: true })
      })
    },
    abandon: async (_turnId, reason) => {
      calls.abandon.push(reason)
      calls.activeAtAbandon.push(active)
      await onAbandon?.(reason)
    },
  }
  return runs
}

const FAR_APART = 86_400_000 * 3 // 每个事件隔 3 天:每条用户消息的日期提醒都不同

/** 直接跑 runTurn:内存事件日志、脚本化的模型 / 工具 / 收件箱(真正的收件箱由内核提供) */
function drive(script: (n: number) => AsyncIterable<ModelEvent>, o: { runs?: ReturnType<typeof scriptedRuns>; inbox?: boolean; maxSteps?: number; onTool?: (name: string, id: string) => void; warn?: (msg: string, data?: unknown) => void } = {}) {
  const turnId = 't1'
  const events: KernelEvent[] = []
  const requests: { messages: Message[]; toolChoice?: string }[] = []
  const controller = new AbortController()
  const append = (e: Omit<KernelEvent, 'seq' | 'ts'>) => {
    const full = { ...e, seq: events.length + 1, ts: 1_700_000_000_000 + events.length * FAR_APART } as KernelEvent
    events.push(full)
    return full
  }
  const pendingFollowUps: FollowUp[] = []
  let wake: (() => void) | undefined
  const box = {
    parked: false,
    parks: 0,
    /** 内核的做法:写 message.user,提交后清 parked、放进收件箱、叫醒 */
    send(text: string) {
      if (!box.parked) throw new Error('ERR_BUSY')
      const e = append({ type: 'message.user', sessionId: 's', payload: { turnId, text, followUp: true } })
      box.parked = false
      pendingFollowUps.push({ text, ts: e.ts })
      wake?.()
    },
  }
  const inbox: TurnInbox = {
    park() {
      box.parked = true
      box.parks++
      return new Promise<void>(resolve => {
        wake = resolve
        controller.signal.addEventListener('abort', () => resolve(), { once: true })
      })
    },
    unpark() { box.parked = false },
    take: () => pendingFollowUps.splice(0),
  }
  append({ type: 'message.user', sessionId: 's', payload: { turnId, text: 'go' } })
  const models = {
    catalog: () => ({ presets: [], models: {} }),
    accounts: () => [],
    stream(_ref: unknown, req: Req) {
      requests.push({ messages: structuredClone(req.messages), ...(req.toolChoice && { toolChoice: req.toolChoice }) })
      return script(requests.length)
    },
  } as unknown as ModelsService
  const tools = {
    list: () => [],
    async call(name: string, _args: string, ctx: { callId: string }) {
      o.onTool?.(name, ctx.callId)
      const content = `result of ${ctx.callId}`
      append({ type: 'tool.ended', sessionId: 's', payload: { turnId, callId: ctx.callId, name, ok: true, ms: 1, content } })
      return { content }
    },
  } as unknown as ToolsService
  const deps: LoopDeps = {
    models, tools, append, signal: controller.signal,
    sessions: { spillDir: () => '/nonexistent-spill' },
    log: { info() {}, warn: (msg, data) => o.warn?.(msg, data), error() {} },
    history: () => events.slice(),
    platform: 'linux',
    now: () => new Date(0),
    ...(o.maxSteps !== undefined && { maxSteps: o.maxSteps }),
    ...(o.runs && { background: o.runs }),
    ...(o.inbox && { inbox }),
  }
  const result: Promise<TurnOutcome> = runTurn(deps, { sessionId: 's', turnId, text: 'go', info: { sessionId: 's', cwd: '/nonexistent-cwd' } as never, ref: GPT })
  const parkedCount = () => events.filter(e => e.type === 'turn.parked').length
  return {
    events, requests, controller, box, result, turnId,
    types: (...only: string[]) => events.filter(e => only.includes(e.type)).map(e => e.type),
    parked: (n: number) => waitFor(() => parkedCount() === n),
    /** 下一次 setImmediate 之后:所有已就绪的微任务都跑完了 */
    settled: () => new Promise(r => setImmediate(r)),
    rebuilt() {
      const first = requests[0].messages[0].parts[0] as { text: string }
      return buildMessages(events, 'later', 'next', { origin: { accountId: 'acc', protocol: undefined, modelId: 'gpt-5' }, environment: first.text, reminder: dateReminder })
    },
  }
}
const textOf = (m: Message | undefined) => (m?.parts ?? []).map(p => (p.type === 'text' ? p.text : p.type)).join('|')
const ended = { type: 'turn.ended', payload: { turnId: 't1' } }

describe('loop-default: Review Focus 3, the turn waits for runs', () => {
  it('two runs: parked, then exactly one request per notice, then turn.ended', async () => {
    const runs = scriptedRuns()
    runs.start(2)
    const d = drive(n => say(`answer ${n}`), { runs })
    await d.parked(1)
    await d.settled()
    expect(d.requests).toHaveLength(1)
    expect(d.types('turn.ended', 'turn.failed')).toEqual([])
    expect(d.events.find(e => e.type === 'turn.parked')?.payload).toEqual({ turnId: 't1', step: 1, active: 2, pending: 0 })

    runs.end('run_a', 'NOTICE A')
    await d.parked(2)
    await d.settled()
    expect(d.requests).toHaveLength(2)
    expect(textOf(d.requests[1].messages.at(-1))).toBe('NOTICE A')
    expect(d.requests[1].messages.at(-1)).toEqual(noticeMessage('NOTICE A'))

    runs.end('run_b', 'NOTICE B')
    expect(await d.result).toEqual(ended)
    expect(d.requests).toHaveLength(3)
    expect(textOf(d.requests[2].messages.at(-1))).toBe('NOTICE B')
    expect(d.events.filter(e => e.type === 'turn.resumed').map(e => e.payload)).toEqual([
      { turnId: 't1', step: 1, cause: 'notice' },
      { turnId: 't1', step: 2, cause: 'notice' },
    ])
    expect(d.events.filter(e => e.type === 'executor.notice').map(e => e.payload)).toEqual([
      { turnId: 't1', step: 2, runId: 'run_a', text: 'NOTICE A' },
      { turnId: 't1', step: 3, runId: 'run_b', text: 'NOTICE B' },
    ])
    expect(d.events.map(e => e.type).filter(t => t !== 'message.assistant.delta' && t !== 'turn.usage')).toEqual([
      'message.user',
      'message.assistant', 'turn.parked', 'turn.resumed',
      'executor.notice', 'message.assistant', 'turn.parked', 'turn.resumed',
      'executor.notice', 'message.assistant',
    ])
  })

  it('without a run nothing parks: inbox untouched, wait never called', async () => {
    const runs = scriptedRuns()
    const d = drive(() => say('hi'), { runs, inbox: true })
    expect(await d.result).toEqual(ended)
    expect(d.box.parks).toBe(0)
    expect(runs.calls.waits).toBe(0)
    expect(d.types('turn.parked', 'turn.resumed')).toEqual([])
  })

  it('a run that ended before the model stopped is pending: wait returns at once and it gets a request', async () => {
    const runs = scriptedRuns()
    runs.start()
    runs.end('run_a', 'EARLY')
    // 第 1 步开始前已取走;所以再起一个在第 1 步期间结束
    runs.start()
    const d = drive(n => {
      if (n === 1) runs.end('run_b', 'DURING')
      return say(`a${n}`)
    }, { runs })
    expect(await d.result).toEqual(ended)
    expect(d.requests).toHaveLength(2)
    expect(textOf(d.requests[0].messages.at(-1))).toBe('EARLY')
    expect(textOf(d.requests[1].messages.at(-1))).toBe('DURING')
    expect(d.types('turn.parked', 'turn.resumed')).toEqual(['turn.parked', 'turn.resumed'])
  })

  it('a run ending during other tools is delivered at the next step, after that step\'s tool message', async () => {
    const runs = scriptedRuns()
    runs.start()
    const d = drive(n => (n === 1 ? calling('c1', 'read', { path: 'a' }) : say('done')), { runs, onTool: () => runs.end('run_a', 'NOTICE') })
    expect(await d.result).toEqual(ended)
    expect(d.requests[1].messages.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'user'])
    expect(d.requests[1].messages.at(-1)).toEqual(noticeMessage('NOTICE'))
    expect(d.requests[0].messages).toHaveLength(1)
    expect(d.types('turn.parked')).toEqual([])
  })

  it('the request after a wake holds the assistant\'s own words; a reasoning-only step is not pushed', async () => {
    const runs = scriptedRuns()
    runs.start(2)
    const d = drive(n => {
      if (n === 1) return say('I started it')
      if (n === 2) return seq({ type: 'reasoning', replay: { r: 1 } }, done())
      return say('final')
    }, { runs })
    await d.parked(1)
    runs.end('run_a', 'A')
    await d.parked(2)
    runs.end('run_b', 'B')
    await d.result
    expect(d.requests[1].messages.map(textOf).slice(1)).toEqual(['I started it', 'A'])
    expect(d.requests[2].messages.map(textOf).slice(1)).toEqual(['I started it', 'A', 'B'])
  })

  it('step limit with a run active: no further model request, the notice is logged, turn.ended', async () => {
    const runs = scriptedRuns()
    runs.start()
    const d = drive(() => say('wrapping up'), { runs, maxSteps: 1 })
    await d.parked(1)
    expect(d.requests[0].toolChoice).toBe('none')
    runs.end('run_a', 'LATE')
    expect(await d.result).toEqual(ended)
    expect(d.requests).toHaveLength(1)
    expect(d.events.filter(e => e.type === 'executor.notice').map(e => (e.payload as { text: string }).text)).toEqual(['LATE'])
    expect(d.rebuilt().map(textOf).at(-2)).toBe('LATE')
  })

  it('a notice waking the last step before the limit gets its request with toolChoice none, and parks again without another', async () => {
    const runs = scriptedRuns()
    runs.start(2)
    const d = drive(n => say(`a${n}`), { runs, maxSteps: 2 })
    await d.parked(1)
    runs.end('run_a', 'A')
    await d.parked(2)
    expect(d.requests.map(r => r.toolChoice)).toEqual([undefined, 'none'])
    runs.end('run_b', 'B')
    expect(await d.result).toEqual(ended)
    expect(d.requests).toHaveLength(2)
  })

  it('a model error with a run active: the failure waits for the run and is the same failure', async () => {
    const runs = scriptedRuns()
    runs.start()
    const d = drive(() => seq({ type: 'done', reason: 'error', error: { kind: 'unavailable', message: 'boom', retryable: false } }), { runs })
    await d.parked(1)
    expect(d.types('turn.failed')).toEqual([])
    runs.end('run_a', 'N')
    expect(await d.result).toEqual({ type: 'turn.failed', payload: { turnId: 't1', reason: 'unavailable', message: 'boom' } })
    expect(d.requests).toHaveLength(1)
    expect(d.types('executor.notice')).toEqual(['executor.notice'])
    expect(runs.calls.abandon).toEqual([])
  })

  it('max_steps with a run active: same failure after the run, notice logged', async () => {
    const runs = scriptedRuns()
    runs.start()
    const d = drive(() => calling('c1', 'read', { path: 'a' }), { runs, maxSteps: 1 })
    await d.parked(1)
    runs.end('run_a', 'N')
    expect(await d.result).toEqual({ type: 'turn.failed', payload: { turnId: 't1', reason: 'max_steps' } })
    expect(d.types('executor.notice')).toEqual(['executor.notice'])
  })

  it('loop with a run active: same failure after the run', async () => {
    const runs = scriptedRuns()
    runs.start()
    const d = drive(() => calling('c', 'read', { path: 'same' }), { runs })
    await d.parked(1)
    expect(d.requests).toHaveLength(5)
    runs.end('run_a', 'N')
    expect(await d.result).toEqual({ type: 'turn.failed', payload: { turnId: 't1', reason: 'loop' } })
  })

  it('a failed run is only a notice: the turn still ends', async () => {
    const runs = scriptedRuns()
    runs.start()
    const text = '<executor-notice run="run_a" executor="codex" status="failed">x</executor-notice>'
    const d = drive(n => say(`a${n}`), { runs })
    await d.parked(1)
    runs.end('run_a', text)
    expect(await d.result).toEqual(ended)
    expect(textOf(d.requests[1].messages.at(-1))).toContain('status="failed"')
  })

  it('cancel while parked: no further request, cancelled, turn.resumed says abort, the notice waits for index.ts', async () => {
    const runs = scriptedRuns()
    runs.start()
    const d = drive(() => say('x'), { runs, inbox: true })
    await d.parked(1)
    d.controller.abort()
    expect(await d.result).toEqual({ type: 'turn.failed', payload: { turnId: 't1', reason: 'cancelled' } })
    expect(d.requests).toHaveLength(1)
    expect(d.box.parked).toBe(false)
    expect(d.events.find(e => e.type === 'turn.resumed')?.payload).toEqual({ turnId: 't1', step: 1, cause: 'abort' })
  })

  it('cancel while waiting after a failure does not write the failure', async () => {
    const runs = scriptedRuns()
    runs.start()
    const d = drive(() => seq({ type: 'done', reason: 'error', error: { kind: 'unavailable', message: 'boom', retryable: false } }), { runs })
    await d.parked(1)
    d.controller.abort()
    expect(await d.result).toEqual({ type: 'turn.failed', payload: { turnId: 't1', reason: 'cancelled' } })
  })

  it('byte identity: a later turn rebuilds exactly what the model received, with follow-ups and notices', async () => {
    const runs = scriptedRuns()
    runs.start(2)
    const d = drive(n => {
      if (n === 1) return seq({ type: 'reasoning', replay: { r: 1 } }, { type: 'text', delta: 'started' }, ...toolCall('c1', 'read', { path: 'a' }), done('tool_calls'))
      if (n === 3) return seq({ type: 'reasoning', replay: { r: 2 } }, done()) // 只有推理:不进历史
      return say(`a${n}`)
    }, { runs, inbox: true, onTool: () => runs.end('run_a', 'NOTICE A') })
    await d.parked(1)
    d.box.send('more please')
    await d.parked(2)
    runs.end('run_b', 'NOTICE B')
    await d.result
    const last = d.requests.at(-1)!.messages
    const rebuilt = d.rebuilt()
    expect(rebuilt.slice(0, last.length)).toEqual(last)
    expect(JSON.stringify(rebuilt.slice(0, last.length))).toBe(JSON.stringify(last))
    expect(rebuilt.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'user', 'assistant', 'user', 'user', 'assistant', 'user'])
    // 模型每次请求的前缀都不变
    for (let i = 1; i < d.requests.length; i++) {
      const before = d.requests[i - 1].messages
      expect(d.requests[i].messages.slice(0, before.length)).toEqual(before)
    }
  })
})

describe('loop-default: Review Focus 3a, only a parked turn accepts (real kernel, real loop)', () => {
  const refused = async (k: Kernel, sid: string) => {
    await expect(k.handle('session.prompt', { commandId: 'second', sessionId: sid, text: 'b' })).rejects.toMatchObject({ code: ERR_BUSY })
    expect(evs(k, sid).filter(e => e.type === 'message.user')).toHaveLength(1)
  }

  it('while streaming → ERR_BUSY, no receipt, and the same commandId works after the turn', async () => {
    const calls: Call[] = []
    let release = () => {}
    const k = await boot(calls, n => (n === 1
      ? (async function* (): AsyncGenerator<ModelEvent> {
          yield { type: 'text', delta: 'x' }
          await new Promise<void>(r => { release = r })
          yield done()
        })()
      : say('next')))
    const sid = await create(k, { model: CLAUDE })
    await prompt(k, sid, 'go')
    await waitFor(() => evs(k, sid).some(e => e.type === 'message.assistant.delta'))
    await refused(k, sid)
    release()
    await waitFor(() => terminal(k, sid).length === 1)
    // 终态之后处理者还要收尾片刻:回忙就再试,同一个 commandId
    let accepted = false
    for (let i = 0; i < 200 && !accepted; i++) {
      accepted = await k.handle('session.prompt', { commandId: 'second', sessionId: sid, text: 'b' }).then(() => true, () => false)
      if (!accepted) await sleep(5)
    }
    expect(accepted).toBe(true)
    await waitFor(() => terminal(k, sid).length === 2)
  })

  it.skipIf(!posix)('during a tool → ERR_BUSY', async () => {
    const calls: Call[] = []
    const k = await boot(calls, n => (n === 1 ? calling('c1', 'shell', { command: 'sleep 60 & echo $! > pid; wait' }) : say('no')))
    const sid = await create(k, { model: CLAUDE, approvalMode: 'auto' })
    await prompt(k, sid, 'go')
    await waitFor(() => pidOf() !== undefined)
    await refused(k, sid)
    await k.handle('session.cancel', { commandId: 'cx', sessionId: sid })
  })

  it.skipIf(!posix)('during an approval wait → ERR_BUSY', async () => {
    const calls: Call[] = []
    const k = await boot(calls, n => (n === 1 ? calling('c1', 'shell', { command: 'touch marker' }) : say('no')))
    const sid = await create(k, { model: CLAUDE })
    await prompt(k, sid, 'go')
    await waitFor(() => evs(k, sid).some(e => e.type === 'approval.requested'))
    await refused(k, sid)
    await k.handle('session.cancel', { commandId: 'cx', sessionId: sid })
  })

  it('during the rate-limit sleep → ERR_BUSY', async () => {
    const calls: Call[] = []
    let sleeping = false
    const k = await boot(
      calls,
      () => seq({ type: 'done', reason: 'error', error: { kind: 'rate_limit', message: 'slow down', retryable: true } }),
      { loop: { sleep: (_ms, signal) => new Promise<void>(r => { sleeping = true; signal.addEventListener('abort', () => r(), { once: true }) }) } },
    )
    const sid = await create(k, { model: CLAUDE })
    await prompt(k, sid, 'go')
    await waitFor(() => sleeping)
    await refused(k, sid)
    await k.handle('session.cancel', { commandId: 'cx', sessionId: sid })
  })
})

describe('loop-default: Review Focus 3a, a message wakes the parked turn', () => {
  it('turn.parked is written with parked already set, in one tick', async () => {
    const runs = scriptedRuns()
    runs.start()
    let parkedAtEvent: boolean | undefined
    const d = drive(n => say(`a${n}`), { runs, inbox: true })
    const push = d.events.push.bind(d.events)
    d.events.push = (...e: KernelEvent[]) => {
      if (e[0].type === 'turn.parked') parkedAtEvent = d.box.parked
      return push(...e)
    }
    await d.parked(1)
    expect(parkedAtEvent).toBe(true)
    d.box.send('hi')
    await d.parked(2)
    runs.end('run_a')
    await d.result
  })

  it('a message: cause message, exactly one request ending in that text with its own reminder and no environment; the run\'s notice comes later', async () => {
    const runs = scriptedRuns()
    runs.start()
    const d = drive(n => say(`a${n}`), { runs, inbox: true })
    await d.parked(1)
    expect(d.box.parked).toBe(true)
    d.box.send('and also this')
    expect(d.box.parked).toBe(false)
    await d.parked(2)
    expect(d.requests).toHaveLength(2)
    const user = d.events.filter(e => e.type === 'message.user')[1]
    expect(d.requests[1].messages.at(-1)).toEqual({ role: 'user', parts: [{ type: 'text', text: dateReminder(user.ts) }, { type: 'text', text: 'and also this' }] })
    expect(JSON.stringify(d.requests[1].messages.at(-1))).not.toContain('<environment>')
    expect(d.events.find(e => e.type === 'turn.resumed')?.payload).toEqual({ turnId: 't1', step: 1, cause: 'message' })
    expect(runs.calls.abandon).toEqual([])
    runs.end('run_a', 'NOTICE')
    expect(await d.result).toEqual(ended)
    expect(d.requests).toHaveLength(3)
    expect(textOf(d.requests[2].messages.at(-1))).toBe('NOTICE')
  })

  it('message and notice in one wake: message first, notice next, matching seq', async () => {
    const runs = scriptedRuns()
    runs.start(2)
    const d = drive(n => say(`a${n}`), { runs, inbox: true })
    await d.parked(1)
    d.box.send('MSG')
    runs.end('run_a', 'NOTICE')
    await d.parked(2)
    expect(d.requests[1].messages.slice(-2).map(textOf)).toEqual([expect.stringMatching(/\|MSG$/), 'NOTICE'])
    const types = d.events.map(e => e.type)
    expect(types.indexOf('executor.notice')).toBeGreaterThan(types.lastIndexOf('message.user'))
    expect(d.events.filter(e => e.type === 'turn.resumed').map(e => (e.payload as { cause: string }).cause)).toEqual(['message'])
    runs.end('run_b', 'B')
    await d.result
  })

  it('notice wins the race and a message lands before unpark, at the step limit: the message is delivered, not dropped', async () => {
    const runs = scriptedRuns()
    runs.start(2)
    const d = drive(n => say(`a${n}`), { runs, inbox: true, maxSteps: 1 })
    await d.parked(1)
    runs.end('run_a', 'NOTICE') // wait 先 resolve,race 的续延还没跑
    d.box.send('MSG')
    await d.parked(2)
    expect(d.requests).toHaveLength(2)
    expect(d.requests[1].toolChoice).toBeUndefined()
    expect(d.requests[1].messages.slice(-2).map(textOf)).toEqual([expect.stringMatching(/\|MSG$/), 'NOTICE'])
    expect(d.events.find(e => e.type === 'turn.resumed')?.payload).toMatchObject({ cause: 'message' })
    runs.end('run_b', 'B')
    expect(await d.result).toEqual(ended)
  })

  it('with a service and no inbox, parking works and only notices wake it', async () => {
    const runs = scriptedRuns()
    runs.start()
    const d = drive(n => say(`a${n}`), { runs })
    await d.parked(1)
    await d.settled()
    expect(d.requests).toHaveLength(1)
    runs.end('run_a', 'N')
    expect(await d.result).toEqual(ended)
    expect(d.events.find(e => e.type === 'turn.resumed')?.payload).toMatchObject({ cause: 'notice' })
  })

  it('parked at the limit with maxSteps 1: the next request has no toolChoice none and can call tools again', async () => {
    const runs = scriptedRuns()
    runs.start()
    const d = drive(n => (n === 2 ? calling('c1', 'read', { path: 'a' }) : say(`a${n}`)), { runs, inbox: true, maxSteps: 1 })
    await d.parked(1)
    expect(d.requests[0].toolChoice).toBe('none')
    d.box.send('keep going')
    await d.parked(2)
    expect(d.requests.map(r => r.toolChoice)).toEqual(['none', undefined, 'none'])
    expect(d.types('tool.ended')).toEqual(['tool.ended'])
    runs.end('run_a', 'N')
    expect(await d.result).toEqual(ended)
    expect(d.types('executor.notice')).toEqual(['executor.notice'])
  })

  it('a follow-up gives a full new budget of maxSteps past its own step', async () => {
    const runs = scriptedRuns()
    runs.start()
    const d = drive(n => (n === 3 ? say('stop') : n === 1 ? say('first') : calling(`c${n}`, 'read', { path: String(n) })), { runs, inbox: true, maxSteps: 2 })
    await d.parked(1)
    d.box.send('go on')
    await d.parked(2)
    // 第 2 步收到消息 → limit = 2 + 2 = 4:第 2、3 步不带 none,第 4 步才带
    expect(d.requests.map(r => r.toolChoice)).toEqual([undefined, undefined, undefined])
    runs.end('run_a', 'N')
    await d.settled()
    await waitFor(() => d.requests.length === 4)
    expect(d.requests[3].toolChoice).toBe('none')
    d.controller.abort()
    await d.result
  })

  it('LoopGuard starts fresh after a follow-up', async () => {
    const runs = scriptedRuns()
    runs.start()
    let n4 = 0
    const d = drive(n => {
      if (n === 5) return say('pause')
      n4++
      return n4 > 8 ? say('done') : calling('c', 'read', { path: 'same' })
    }, { runs, inbox: true })
    await d.parked(1)
    expect(d.requests).toHaveLength(5)
    expect(d.types('turn.failed')).toEqual([])
    d.box.send('again')
    await d.parked(2)
    // 又连续 4 次相同调用也没到 stop(不重置的话第 1 次就是第 5 次相同的)
    expect(d.types('tool.ended')).toHaveLength(8)
    runs.end('run_a', 'N')
    expect(await d.result).toEqual(ended)
  })

  it('a message during the wait after max_steps: the request is valid, every call has a result, and it rebuilds the same', async () => {
    const runs = scriptedRuns()
    runs.start()
    const d = drive(n => (n === 1 ? seq({ type: 'text', delta: 'trying' }, ...toolCall('c1', 'read', { path: 'a' }), ...toolCall('c2', 'read', { path: 'b' }), done('tool_calls')) : say('ok')), { runs, inbox: true, maxSteps: 1 })
    await d.parked(1)
    d.box.send('continue')
    await d.parked(2)
    const m = d.requests[1].messages
    expect(m.map(x => x.role)).toEqual(['user', 'assistant', 'tool', 'user'])
    expect(m[2].parts).toEqual([
      { type: 'tool_result', callId: 'c1', content: INTERRUPTED, isError: true },
      { type: 'tool_result', callId: 'c2', content: INTERRUPTED, isError: true },
    ])
    expect(d.requests[1].toolChoice).toBeUndefined()
    expect(d.types('turn.failed')).toEqual([])
    runs.end('run_a', 'N')
    expect(await d.result).toEqual(ended)
    expect(JSON.stringify(d.rebuilt().slice(0, m.length))).toBe(JSON.stringify(m))
  })

  it('a message during the wait after a loop stop: the stopped call and those after it are padded', async () => {
    const runs = scriptedRuns()
    runs.start()
    const d = drive(n => {
      if (n === 1) return seq(...toolCall('a', 'read', { path: 'same' }), ...toolCall('b', 'read', { path: 'same' }), ...toolCall('c', 'read', { path: 'same' }), ...toolCall('d', 'read', { path: 'same' }), ...toolCall('e', 'read', { path: 'same' }), ...toolCall('f', 'read', { path: 'x' }), done('tool_calls'))
      return say('ok')
    }, { runs, inbox: true })
    await d.parked(1)
    expect(d.types('tool.ended')).toHaveLength(4)
    d.box.send('continue')
    await d.parked(2)
    const m = d.requests[1].messages
    expect(m.map(x => x.role)).toEqual(['user', 'assistant', 'tool', 'user'])
    expect(m[2].parts.map(p => (p as { callId: string }).callId)).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
    expect(m[2].parts.slice(4)).toEqual([
      { type: 'tool_result', callId: 'e', content: INTERRUPTED, isError: true },
      { type: 'tool_result', callId: 'f', content: INTERRUPTED, isError: true },
    ])
    runs.end('run_a', 'N')
    await d.result
  })

  it('a message during the wait after a model error resumes; notices logged during that wait stay before it', async () => {
    const runs = scriptedRuns()
    runs.start(2)
    const d = drive(n => (n === 1 ? seq({ type: 'done', reason: 'error', error: { kind: 'unavailable', message: 'boom', retryable: false } }) : say('recovered')), { runs, inbox: true, maxSteps: 3 })
    await d.parked(1)
    runs.end('run_a', 'EARLIER')
    await d.parked(2) // 记下通知后再次挂起,不请求模型
    expect(d.requests).toHaveLength(1)
    d.box.send('retry please')
    await d.parked(3)
    const m = d.requests[1].messages
    expect(m.slice(1).map(textOf)).toEqual(['EARLIER', expect.stringMatching(/\|retry please$/)])
    runs.end('run_b', 'LATER')
    expect(await d.result).toEqual(ended)
    expect(d.types('turn.failed')).toEqual([])
    expect(JSON.stringify(d.rebuilt().slice(0, m.length))).toBe(JSON.stringify(m))
  })

  it('a message replacing a model error: the failure is still logged, kind and message, and the secret in it is masked', async () => {
    const runs = scriptedRuns()
    runs.start()
    const warnings: { msg: string; data: unknown }[] = []
    const key = 'sk-' + 'a'.repeat(32)
    const d = drive(n => (n === 1 ? seq({ type: 'done', reason: 'error', error: { kind: 'unavailable', message: `boom ${key}`, retryable: false } }) : say('recovered')), {
      runs, inbox: true, warn: (msg, data) => warnings.push({ msg, data }),
    })
    await d.parked(1)
    expect(warnings).toEqual([])
    d.box.send('retry please')
    await d.parked(2)
    expect(warnings).toEqual([{ msg: 'turn failure replaced by a follow-up', data: { turnId: 't1', kind: 'unavailable', message: expect.stringContaining('boom') } }])
    expect(JSON.stringify(warnings)).not.toContain(key)
    runs.end('run_a', 'N')
    expect(await d.result).toEqual(ended)
  })

  it('a message replacing loop or max_steps: logged with its kind, no message field', async () => {
    const runs = scriptedRuns()
    runs.start()
    const warnings: unknown[] = []
    const d = drive(n => (n === 1 ? calling('c1', 'read', { path: 'a' }) : say('ok')), { runs, inbox: true, maxSteps: 1, warn: (_m, data) => warnings.push(data) })
    await d.parked(1)
    d.box.send('go on')
    await d.parked(2)
    expect(warnings).toEqual([{ turnId: 't1', kind: 'max_steps' }])
    runs.end('run_a', 'N')
    await d.result
  })

  it('no failure was replaced → nothing logged: a message after a clean stop at the limit, or a failure that is written as usual', async () => {
    const runs = scriptedRuns()
    runs.start()
    const warnings: unknown[] = []
    const d = drive(n => say(`a${n}`), { runs, inbox: true, maxSteps: 1, warn: (_m, data) => warnings.push(data) })
    await d.parked(1)
    runs.end('run_a', 'N')
    expect(await d.result).toEqual(ended)
    expect(warnings).toEqual([])

    const runs2 = scriptedRuns()
    runs2.start()
    const d2 = drive(() => seq({ type: 'done', reason: 'error', error: { kind: 'unavailable', message: 'boom', retryable: false } }), { runs: runs2, inbox: true, warn: (_m, data) => warnings.push(data) })
    await d2.parked(1)
    runs2.end('run_a', 'N')
    expect(await d2.result).toMatchObject({ type: 'turn.failed', payload: { reason: 'unavailable' } })
    expect(warnings).toEqual([])
  })

  it('a message during the wait after the limit, with notices logged first: both reach the model in seq order', async () => {
    const runs = scriptedRuns()
    runs.start(2)
    const d = drive(n => say(`a${n}`), { runs, inbox: true, maxSteps: 1 })
    await d.parked(1)
    runs.end('run_a', 'LOGGED')
    await d.parked(2)
    expect(d.requests).toHaveLength(1)
    d.box.send('still there?')
    await d.parked(3)
    expect(d.requests).toHaveLength(2)
    expect(d.requests[1].messages.slice(-2).map(textOf)).toEqual(['LOGGED', expect.stringMatching(/\|still there\?$/)])
    runs.end('run_b', 'B')
    expect(await d.result).toEqual(ended)
  })
})

describe('loop-default: executors service through the plugin', () => {
  const executors = (runs: BackgroundRuns): Plugin => ({
    manifest: { id: 'fake-executors', version: '0', kernel: '^0.1.0', provides: ['executors'] },
    activate: ctx => ctx.services.provide('executors', runs),
  })
  const codes = async (fn: () => Promise<unknown>) => fn().then(() => undefined, (e: { code?: number }) => e.code)

  it('no service: the turn runs as before with no parking events', async () => {
    const calls: Call[] = []
    const k = await boot(calls, () => say('ok'))
    const sid = await create(k, { model: GPT })
    await turn(k, sid, 'hi')
    expect(evs(k, sid).some(e => e.type === 'turn.parked' || e.type === 'executor.notice')).toBe(false)
    expect(terminal(k, sid)[0].type).toBe('turn.ended')
  })

  it('a normal end: abandon runs with nothing open, before the end snapshot', async () => {
    const calls: Call[] = []
    const runs = scriptedRuns()
    const k = await boot(calls, () => say('ok'), { extra: [executors(runs)] })
    const sid = await create(k, { model: GPT })
    await turn(k, sid, 'hi')
    expect(runs.calls.abandon).toEqual([undefined])
    expect(runs.calls.activeAtAbandon).toEqual([0])
  })

  it('cancel while parked, fake exits at once: abandon ran, undelivered notices are in the log, end snapshot before the terminal', async () => {
    const calls: Call[] = []
    const runs = scriptedRuns(async () => {
      runs.end('run_a', 'KILLED')
    })
    runs.start()
    const k = await boot(calls, () => say('waiting'), { extra: [executors(runs)] })
    const sid = await create(k, { model: GPT })
    await prompt(k, sid, 'go')
    await waitFor(() => evs(k, sid).some(e => e.type === 'turn.parked'))
    await k.handle('session.cancel', { commandId: 'cx', sessionId: sid })
    await waitFor(() => terminal(k, sid).length === 1)
    expect(runs.calls.abandon).toHaveLength(1)
    const order = evs(k, sid).map(e => e.type).filter(t => ['executor.notice', 'turn.snapshot', 'turn.failed', 'turn.resumed'].includes(t))
    expect(order).toEqual(['turn.snapshot', 'turn.resumed', 'executor.notice', 'turn.snapshot', 'turn.failed'])
    expect(pay(terminal(k, sid)[0]).reason).toBe('cancelled')
    expect(pay(evs(k, sid).find(e => e.type === 'executor.notice'))).toEqual({ turnId: pay(terminal(k, sid)[0]).turnId, runId: 'run_a', text: 'KILLED' })
    expect(calls).toHaveLength(1)
    // 下一轮的历史看得到这条通知
    await turn(k, sid, 'next')
    expect(calls[1].messages.map(textOf).some(t => t === 'KILLED')).toBe(true)
  })

  it('cancel while parked, stubborn fake: the kernel\'s cancelled comes first at 1 s, then notice and end snapshot; busy until the handler returns', async () => {
    const calls: Call[] = []
    let release!: () => void
    const held = new Promise<void>(r => { release = r })
    const runs = scriptedRuns(async () => {
      await held
      runs.end('run_a', 'KILLED LATE')
    })
    runs.start()
    const k = await boot(calls, () => say('waiting'), { extra: [executors(runs)] })
    const sid = await create(k, { model: GPT })
    const turnId = await prompt(k, sid, 'go')
    await waitFor(() => evs(k, sid).some(e => e.type === 'turn.parked'))
    await k.handle('session.cancel', { commandId: 'cx', sessionId: sid })
    try {
      expect(terminal(k, sid).map(e => pay(e).reason)).toEqual(['cancelled'])
      expect(evs(k, sid).some(e => e.type === 'executor.notice')).toBe(false)
      const retryId = 'retry-1'
      expect(await codes(() => k.handle('session.prompt', { commandId: retryId, sessionId: sid, text: 'x' }))).toBe(ERR_BUSY)
      expect(await codes(() => k.handle('turn.rollback', { commandId: 'rb1', sessionId: sid, turnId }))).toBe(ERR_BUSY)
    } finally {
      release()
    }
    await waitFor(() => evs(k, sid).filter(e => e.type === 'turn.snapshot').length === 2)
    const order = evs(k, sid).map(e => e.type).filter(t => ['executor.notice', 'turn.snapshot', 'turn.failed'].includes(t))
    expect(order).toEqual(['turn.snapshot', 'turn.failed', 'executor.notice', 'turn.snapshot'])
    expect(terminal(k, sid)).toHaveLength(1)
    // 处理者结束后不再忙;被拒的那个 commandId 没留回执,可以重试
    let accepted: { accepted?: boolean } | undefined
    for (let i = 0; i < 400 && !accepted; i++) {
      accepted = await (k.handle('session.prompt', { commandId: 'retry-1', sessionId: sid, text: 'x' }) as Promise<{ accepted: boolean }>).catch(() => undefined)
      if (!accepted) await sleep(5)
    }
    expect(accepted?.accepted).toBe(true)
  })

  it('a rejecting abandon still logs leftovers, takes the end snapshot and writes the terminal', async () => {
    const calls: Call[] = []
    const runs = scriptedRuns(async () => {
      runs.end('run_a', 'LEFT')
      throw new Error('kill failed')
    })
    runs.start()
    const k = await boot(calls, () => say('x'), { extra: [executors(runs)] })
    const sid = await create(k, { model: GPT })
    await prompt(k, sid, 'go')
    await waitFor(() => evs(k, sid).some(e => e.type === 'turn.parked'))
    await k.handle('session.cancel', { commandId: 'cx', sessionId: sid })
    await waitFor(() => terminal(k, sid).length === 1)
    expect(evs(k, sid).map(e => e.type).filter(t => ['executor.notice', 'turn.snapshot', 'turn.failed'].includes(t))).toEqual(['turn.snapshot', 'executor.notice', 'turn.snapshot', 'turn.failed'])
  })

  it('a model error with a run active: abandon comes only after the run ended, then the same failure', async () => {
    const calls: Call[] = []
    const runs = scriptedRuns()
    runs.start()
    const k = await boot(calls, () => seq({ type: 'done', reason: 'error', error: { kind: 'unavailable', message: 'boom', retryable: false } }), { extra: [executors(runs)] })
    const sid = await create(k, { model: GPT })
    await prompt(k, sid, 'go')
    await waitFor(() => evs(k, sid).some(e => e.type === 'turn.parked'))
    expect(runs.calls.abandon).toEqual([])
    runs.end('run_a', 'N')
    await waitFor(() => terminal(k, sid).length === 1)
    expect(runs.calls.activeAtAbandon).toEqual([0])
    expect(pay(terminal(k, sid)[0])).toMatchObject({ reason: 'unavailable', message: 'boom' })
    expect(calls).toHaveLength(1)
  })
})

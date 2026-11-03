// 插件装配的端到端:真内核、真权限门、假模型、假 CLI(04 Review Focus 2、3、3a、4、6)
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKernel, type Kernel, type KernelOpts } from '../../kernel/kernel'
import { CONFIG_SECTIONS, type Plugin } from '../../kernel/pluginHost'
import { CLOSE_GRACE_MS, KILL_LIVE_MS } from '../../kernel/shutdown'
import { createGit } from '../../lib/git/snapshot'
import type { Message, ModelEvent, ModelRequest, ModelsService } from '../../lib/models/types'
import type { Tool, ToolsService } from '../../lib/tools/types'
import { ERR_BUSY, type KernelEvent } from '../../protocol/index'
import type { ModelRef } from '../../protocol/models'
import { cleanupFakes, disposeReusableFakes, installFake, isAlive, reusableFake, waitDead, type FakeCli } from '../../../test/fakeCli'
import { NO_SANDBOX } from '../../../test/sandboxStub'
import { BUILTIN_PLUGINS } from '../index'
import { createLoopDefault } from '../loop-default'
import { createToolsCoding } from '../tools-coding'
import toolsRegistry from '../tools-registry'
import { createExecutorCli, manifestFor, type ExecutorCliOpts } from './index'
import { parseExecutorsConfig } from './runs'

const fixture = (name: string) => readFileSync(join(__dirname, '../../../test/fixtures/executors', name), 'utf8').split('\n').filter(Boolean)
const CODEX_OK = fixture('codex-exec-0.154.jsonl')
const FINISH = '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
const FULL: NonNullable<KernelOpts['sandbox']> = { detect: () => ({ level: 'full', missing: [] }), upstream: null }
const REF: ModelRef = { accountId: 'acc', modelId: 'gpt-5' }

let root: string
let dataDir: string
let home: string
let cwd: string
let kernels: Kernel[] = []
const bins = realpathSync(mkdtempSync(join(tmpdir(), 'mffai-execcli-bins-')))

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function waitFor(fn: () => boolean, ms = 15_000) {
  const end = Date.now() + ms
  while (Date.now() < end && !fn()) await sleep(10)
  expect(fn()).toBe(true)
}
const gitEnv = (): NodeJS.ProcessEnv => ({ PATH: '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin', HOME: home, GIT_CONFIG_GLOBAL: join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_CEILING_DIRECTORIES: root })
const isolatedGit = () => createGit({ base: gitEnv() })
const sh = (...args: string[]) => execFileSync('git', args, { cwd, env: gitEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'mffai-execcli-')))
  dataDir = join(root, 'data')
  home = join(root, 'home')
  cwd = join(root, 'repo')
  for (const d of [dataDir, home, cwd]) mkdirSync(d)
  writeFileSync(join(root, 'gitconfig'), '[user]\n\tname = t\n\temail = t@example.invalid\n')
  writeFileSync(join(cwd, 'a.txt'), 'a\n')
  writeFileSync(join(cwd, 'b.txt'), 'b\n')
  sh('init', '-q')
  sh('add', '-A')
  sh('commit', '-qm', 'init')
})
afterEach(async () => {
  for (const k of kernels) await k.close().catch(() => {})
  kernels = []
  cleanupFakes()
  rmSync(root, { recursive: true, force: true })
  rmSync(`${root}-worktrees`, { recursive: true, force: true })
})
afterAll(() => {
  disposeReusableFakes()
  rmSync(bins, { recursive: true, force: true })
})

type Req = Omit<ModelRequest, 'model'>
type Script = (n: number, req: Req) => AsyncIterable<ModelEvent>
async function* seq(...evs: ModelEvent[]) {
  for (const e of evs) yield e
}
const done = (reason: 'stop' | 'tool_calls' = 'stop'): ModelEvent => ({ type: 'done', reason })
const calling = (id: string, name: string, args: object) => seq({ type: 'tool_call', id, name, argsDelta: JSON.stringify(args) }, done('tool_calls'))
const say = (text: string) => seq({ type: 'text', delta: text }, { type: 'usage', input: 1, output: 1 }, done())
const delegate = (args: object = { prompt: 'do it' }, id = 'c1', name = 'delegate_codex') => calling(id, name, args)

function fakeModels(calls: Message[][], script: Script): Plugin {
  const service = {
    catalog: () => ({ presets: [], models: {}, default: REF }),
    accounts: () => [],
    stream(_ref: unknown, req: Req) {
      calls.push(structuredClone(req.messages))
      return script(calls.length, req)
    },
  } as unknown as ModelsService
  return { manifest: { id: 'fake-models', version: '0', kernel: '^0.1.0', provides: ['models'] }, activate: ctx => ctx.services.provide('models', service) }
}

interface Rig {
  k: Kernel
  calls: Message[][]
  tools(): Tool[]
}
interface BootOpts {
  script?: Script
  sandbox?: KernelOpts['sandbox']
  rules?: { effect: 'deny' | 'ask' | 'allow'; rule: string }[]
  allowUnsandboxedAuto?: boolean
  executors?: Record<string, unknown>
  plugin?: ExecutorCliOpts
  extra?: Plugin[]
  path?: string
}

/** executorDirs:放假程序的目录排在 PATH 最前;qoder 默认关掉,否则会找到机器上真的那个 */
async function boot(fake: Pick<FakeCli, 'dir'> | undefined, o: BootOpts = {}): Promise<Rig> {
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
    permissions: { rules: o.rules ?? [], ...(o.allowUnsandboxedAuto && { allowUnsandboxedAuto: true }) },
    executors: { disabled: ['qoder'], ...o.executors },
  }))
  const calls: Message[][] = []
  let tools: ToolsService | undefined
  const env = { PATH: o.path ?? `${fake ? `${fake.dir}:` : ''}/usr/bin:/bin`, HOME: home, GIT_CONFIG_GLOBAL: join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' }
  const k = await createKernel({
    dataDir, home, secrets: { osBackend: false }, env, sandbox: { ...(o.sandbox ?? FULL), git: isolatedGit() },
    plugins: [
      fakeModels(calls, o.script ?? (() => say('ok'))),
      toolsRegistry,
      { manifest: { id: 'spy', version: '0', kernel: '^0.1.0', inject: ['tools'] }, activate: ctx => { tools = ctx.services.get<ToolsService>('tools') } },
      createToolsCoding({ shellEnv: env, loginPath: async () => '', git: async () => { throw new Error('no git') } }),
      createExecutorCli({ env, loginPath: async () => '', git: isolatedGit(), ...o.plugin }),
      createLoopDefault({ git: isolatedGit() }),
      ...(o.extra ?? []),
    ],
  })
  kernels.push(k)
  return { k, calls, tools: () => tools!.list(t => t.delegate === true) }
}

type Info = { id: string; installed: boolean; version?: string; auth: string; isolation: string; missing: string[] }
const list = async (k: Kernel) => ((await k.handle('executor.list', {})) as { executors: Info[] }).executors
const infoOf = async (k: Kernel, id = 'codex') => (await list(k)).find(e => e.id === id)!
async function detected(k: Kernel) {
  for (let i = 0; i < 1500; i++) {
    if (!(await list(k)).some(e => e.missing.includes('detecting'))) return
    await sleep(10)
  }
  throw new Error('detection never finished')
}
const create = async (k: Kernel, o: { approvalMode?: 'ask' | 'auto'; origin?: 'app' | 'im' | 'schedule'; dir?: string } = {}) =>
  ((await k.handle('session.create', { commandId: `c${Math.random()}`, cwd: o.dir ?? cwd, model: REF, approvalMode: o.approvalMode ?? 'auto', ...(o.origin && { origin: o.origin }) })) as { sessionId: string }).sessionId
const prompt = async (k: Kernel, sid: string, text = 'go') => (await k.handle('session.prompt', { commandId: `p${Math.random()}`, sessionId: sid, text })) as { accepted: boolean; turnId: string; followUp?: boolean }
const evs = (k: Kernel, sid: string) => k.events.bySession(sid)
const pay = <T = Record<string, any>>(e: KernelEvent | undefined) => e?.payload as T
const ofType = (k: Kernel, sid: string, t: string) => evs(k, sid).filter(e => e.type === t)
const terminal = (k: Kernel, sid: string) => evs(k, sid).filter(e => e.type === 'turn.ended' || e.type === 'turn.failed')
const execCalls = (f: FakeCli) => f.calls().filter(c => c.argv[0] === 'exec' || c.argv[0] === '-p')
async function turn(k: Kernel, sid: string, text = 'go') {
  const want = terminal(k, sid).length + 1
  const { turnId } = await prompt(k, sid, text)
  await waitFor(() => terminal(k, sid).length >= want)
  return turnId
}
const toolResult = (m: Message[]) => m.filter(x => x.role === 'tool').flatMap(x => x.parts).filter(p => p.type === 'tool_result') as { callId: string; content: string; isError?: boolean }[]
const lastText = (m: Message[]) => {
  const last = m[m.length - 1]
  return last.parts.map(p => (p.type === 'text' ? p.text : '')).join('')
}
async function approval(k: Kernel, sid: string, nth = 0) {
  await waitFor(() => ofType(k, sid, 'approval.requested').length > nth)
  return pay<{ approvalId: string; key?: string; unsandboxed?: boolean; summary: string }>(ofType(k, sid, 'approval.requested')[nth])
}
const respond = (k: Kernel, approvalId: string, decision: 'allow' | 'allow_session' | 'deny') => k.handle('approval.respond', { approvalId, decision })

/** 假 CLI 一直跑到 go 文件出现 */
const untilGo = (go: string, also: object = {}) => ({ ...also, run: `while [ ! -e '${go}' ]; do sleep 0.02; done; printf '%s\\n' '${FINISH}'` })
const fake = (scenario: object = { lines: CODEX_OK }) => reusableFake(scenario, 'codex', bins)

describe('registration and detection', () => {
  it('manifest: injects what it uses, pgids only on posix', () => {
    expect(manifestFor('darwin')).toMatchObject({ id: 'executor-cli', provides: ['executors'], inject: ['tools', 'sessions', 'sandbox', 'permissionGate', 'pgids'] })
    expect(manifestFor('win32').inject).toEqual(['tools', 'sessions', 'sandbox', 'permissionGate'])
  })

  it('in the builtin list between tools-coding and loop-default', () => {
    const ids = BUILTIN_PLUGINS.map(p => p.manifest.id)
    expect(ids.indexOf('executor-cli')).toBe(ids.indexOf('tools-coding') + 1)
    expect(ids.indexOf('loop-default')).toBe(ids.indexOf('executor-cli') + 1)
  })

  it('a found CLI: one delegate tool, verbatim description, schema without a $schema head, nothing internal on the wire', async () => {
    const f = fake()
    const { k, tools } = await boot(f)
    await detected(k)
    const [t, ...rest] = tools()
    expect(rest).toEqual([])
    expect(t.name).toBe('delegate_codex')
    expect(t.delegate).toBe(true)
    expect(t.description).toBe('Run a sub-task with the user\'s local Codex CLI, on the user\'s own subscription. Do not delegate unless the user asked for it. Returns at once with a run id; the outcome arrives later as an `<executor-notice>` in this conversation, so do not poll. You may keep working or finish your reply: the turn stays open until every run ends. Sub-tasks that run at the same time must not write overlapping files. The prompt must stand alone, because the CLI cannot see this conversation. A failed sub-task is reported in the notice, not as an error of yours; decide what to do next. The user may message you while you wait; running sub-tasks keep running. Set readOnly for reviews and questions.')
    expect(t.parameters).not.toHaveProperty('$schema')
    expect(Object.keys((t.parameters as { properties: object }).properties).sort()).toEqual(['model', 'prompt', 'readOnly', 'timeoutMinutes'])
    const info = await infoOf(k)
    expect(info).toMatchObject({ installed: true, auth: 'ok', isolation: 'own', missing: [] })
    expect(Object.keys(info).sort()).toEqual(['auth', 'id', 'installed', 'isolation', 'missing', 'version'])
  })

  it('a missing CLI: no tool, installed:false; refresh registers it after it appears', async () => {
    const { k, tools } = await boot({ dir: bins }, { plugin: { bins: { codex: 'mffai-late-codex' } } })
    await detected(k)
    expect(tools()).toEqual([])
    expect(await infoOf(k)).toMatchObject({ installed: false, missing: ['not_installed'] })
    const late = installFake({ lines: CODEX_OK }, 'mffai-late-codex')
    renameSync(late.file, join(bins, 'mffai-late-codex'))
    writeFileSync(join(bins, 'scenario.json'), '{}')
    try {
      const r = (await k.handle('executor.refresh', {})) as { executors: Info[] }
      expect(r.executors.find(e => e.id === 'codex')).toMatchObject({ installed: true, isolation: 'own' })
      expect(tools().map(t => t.name)).toEqual(['delegate_codex'])
      // 又没了:工具也撤掉
      rmSync(join(bins, 'mffai-late-codex'))
      await k.handle('executor.refresh', {})
      expect(tools()).toEqual([])
    } finally {
      rmSync(join(bins, 'mffai-late-codex'), { force: true })
      rmSync(join(bins, 'scenario.json'), { force: true })
    }
  })

  it('a disabled executor runs nothing and has no tool', async () => {
    const f = installFake({ lines: CODEX_OK })
    const { k, tools } = await boot(f, { executors: { disabled: ['codex', 'qoder'] } })
    await detected(k)
    expect(tools()).toEqual([])
    expect(await infoOf(k)).toMatchObject({ installed: false, missing: ['disabled'] })
    expect(f.calls()).toEqual([])
  })

  it('detection does not hold up kernel start: tools come when it finishes', async () => {
    let release = () => {}
    const gate = new Promise<void>(res => { release = res })
    const run: ExecutorCliOpts['run'] = async () => {
      await gate
      return { code: 0, out: 'Logged in using ChatGPT\ncodex-cli 1.2.3\n', stdout: 'codex-cli 1.2.3\n' }
    }
    const f = fake()
    const { k, tools } = await boot(f, { plugin: { run } })
    expect(k.status().state).toBe('running')
    expect(tools()).toEqual([])
    expect(await infoOf(k)).toMatchObject({ installed: false, missing: ['detecting'] })
    release()
    await detected(k)
    expect((await infoOf(k)).installed).toBe(true)
    expect(tools().map(t => t.name)).toEqual(['delegate_codex'])
  })

  it('a detection that finishes after deactivation registers nothing, and close aborted the probe', async () => {
    let release = () => {}
    const gate = new Promise<void>(res => { release = res })
    const signals: (AbortSignal | undefined)[] = []
    const run: ExecutorCliOpts['run'] = async (_f, _a, _t, _e, context) => {
      signals.push(context?.signal)
      await gate
      return { code: 0, out: 'Logged in\n', stdout: 'codex-cli 1.2.3\n' }
    }
    const { k, tools } = await boot(fake(), { plugin: { run } })
    await waitFor(() => signals.length > 0)
    await k.close()
    kernels = []
    expect(signals[0]?.aborted).toBe(true)
    release()
    await sleep(50)
    expect(tools()).toEqual([])
  })

  it('win32: no tools, everything reports unsupported, no service', async () => {
    const f = installFake({ lines: CODEX_OK })
    const { k, tools } = await boot(f, { plugin: { platform: 'win32' }, executors: { disabled: [] } })
    expect(tools()).toEqual([])
    for (const id of ['codex', 'qoder']) expect(await infoOf(k, id)).toEqual({ id, installed: false, auth: 'unknown', isolation: 'none', missing: ['unsupported'] })
    expect((await k.handle('executor.refresh', {})) as object).toMatchObject({ executors: expect.any(Array) })
    expect(await k.handle('executor.cancel', { commandId: 'x', sessionId: 's', runId: 'r' })).toEqual({ ok: false })
    expect(f.calls()).toEqual([])
  })
})

describe('config', () => {
  it('good values pass through', () => {
    const warn: string[] = []
    const c = parseExecutorsConfig({ maxPerExecutor: 1, maxGlobal: 2, maxPerTurn: 3, maxQueue: 4, timeoutMinutes: 5, idleMinutes: 6, disabled: ['codex'], codex: { network: true }, qoder: { hosts: ['a.example', '*.b.example'] } }, m => warn.push(m))
    expect(c).toEqual({ maxPerExecutor: 1, maxGlobal: 2, maxPerTurn: 3, maxQueue: 4, timeoutMinutes: 5, idleMinutes: 6, disabled: ['codex'], codex: { network: true }, qoder: { hosts: ['a.example', '*.b.example'] } })
    expect(warn).toEqual([])
  })

  it('nothing at all → the defaults, no warning', () => {
    const warn: string[] = []
    expect(parseExecutorsConfig(undefined, m => warn.push(m))).toEqual({ maxPerExecutor: 2, maxGlobal: 3, maxPerTurn: 6, maxQueue: 16, timeoutMinutes: 30, idleMinutes: 20, disabled: [], codex: { network: false }, qoder: {} })
    expect(warn).toEqual([])
  })

  it('bad values → that default plus a warning; network never turns on by accident', () => {
    const warn: string[] = []
    const c = parseExecutorsConfig({ maxPerExecutor: 0, maxGlobal: -1, maxPerTurn: 1.5, maxQueue: '9', timeoutMinutes: 121, idleMinutes: null, disabled: 'codex', codex: { network: 'yes' }, qoder: 7 }, m => warn.push(m))
    expect(c).toEqual({ maxPerExecutor: 2, maxGlobal: 3, maxPerTurn: 6, maxQueue: 16, timeoutMinutes: 30, idleMinutes: 20, disabled: [], codex: { network: false }, qoder: {} })
    expect(warn.length).toBeGreaterThanOrEqual(9)
    expect(parseExecutorsConfig('nope', m => warn.push(m)).maxGlobal).toBe(3)
  })

  it('qoder.hosts: invalid entries are dropped with a warning', () => {
    const warn: string[] = []
    const c = parseExecutorsConfig({ qoder: { hosts: ['good.example', 'http://bad/', 7, '*'] } }, m => warn.push(m))
    expect(c.qoder.hosts).toEqual(['good.example'])
    expect(warn.length).toBe(3)
  })
})

describe('gate through the real tool', () => {
  it('ask session: approval.requested carries the rw key, deny → isError and no spawn', async () => {
    const f = fake()
    const { k, calls } = await boot(f, { script: n => (n === 1 ? delegate() : say('done')) })
    await detected(k)
    const sid = await create(k, { approvalMode: 'ask' })
    await prompt(k, sid)
    const req = await approval(k, sid)
    expect(req).toMatchObject({ key: 'executor:codex:rw' })
    expect(req.summary).toBe('codex: do it')
    expect(req).not.toHaveProperty('unsandboxed')
    await respond(k, req.approvalId, 'deny')
    await waitFor(() => terminal(k, sid).length === 1)
    expect(toolResult(calls[1])[0].isError).toBe(true)
    expect(execCalls(f)).toEqual([])
    expect(ofType(k, sid, 'executor.run.queued')).toEqual([])
  })

  it('ask session: allow_session → the second call runs without another card; read-only has its own key', async () => {
    const f = fake()
    const { k } = await boot(f, { script: n => (n === 1 ? delegate() : n === 2 ? delegate({ prompt: 'again' }, 'c2') : n === 3 ? delegate({ prompt: 'ro', readOnly: true }, 'c3') : say('done')) })
    await detected(k)
    const sid = await create(k, { approvalMode: 'ask' })
    await prompt(k, sid)
    await respond(k, (await approval(k, sid)).approvalId, 'allow_session')
    const ro = await approval(k, sid, 1)
    expect(ro.key).toBe('executor:codex:ro')
    await respond(k, ro.approvalId, 'allow')
    await waitFor(() => terminal(k, sid).length === 1)
    expect(ofType(k, sid, 'approval.requested')).toHaveLength(2)
    expect(ofType(k, sid, 'executor.run.queued')).toHaveLength(3)
    expect(execCalls(f)).toHaveLength(3)
  })

  it('deny shell(codex*) → denied with no approval and no run', async () => {
    const f = fake()
    const { k, calls } = await boot(f, { rules: [{ effect: 'deny', rule: 'shell(codex*)' }], script: n => (n === 1 ? delegate() : say('done')) })
    await detected(k)
    const sid = await create(k, { approvalMode: 'ask' })
    await turn(k, sid)
    expect(ofType(k, sid, 'approval.requested')).toEqual([])
    expect(toolResult(calls[1])[0]).toMatchObject({ isError: true })
    expect(execCalls(f)).toEqual([])
  })

  it('deny write(src/gen/**) → translated into argv, no approval in auto', async () => {
    const f = fake()
    mkdirSync(join(cwd, 'src/gen'), { recursive: true })
    const { k } = await boot(f, { rules: [{ effect: 'deny', rule: 'write(src/gen/**)' }], script: n => (n === 1 ? delegate() : say('done')) })
    await detected(k)
    const sid = await create(k)
    await turn(k, sid)
    expect(ofType(k, sid, 'approval.requested')).toEqual([])
    expect(execCalls(f)[0].argv.join(' ')).toContain(`"${join(cwd, 'src/gen')}"="read"`)
  })

  for (const rule of ['write(**/*.env)', 'read(**/*.env)', 'shell(git push*)']) {
    it(`deny ${rule} → auto asks, and no allow_session key`, async () => {
      const f = fake()
      const { k } = await boot(f, { rules: [{ effect: 'deny', rule }], script: n => (n === 1 ? delegate() : n === 2 ? delegate({ prompt: 'p2' }, 'c2') : say('done')) })
      await detected(k)
      const sid = await create(k)
      await prompt(k, sid)
      const req = await approval(k, sid)
      expect(req).not.toHaveProperty('key')
      expect(req).not.toHaveProperty('unsandboxed') // 隔离还是 own
      await respond(k, req.approvalId, 'allow_session')
      // 本会话放行没有留下:第二次还是问
      await respond(k, (await approval(k, sid, 1)).approvalId, 'allow')
      await waitFor(() => terminal(k, sid).length === 1)
      expect(execCalls(f)).toHaveLength(2)
    })
  }

  it('violations lists the .env the fake really wrote, in the event and the notice', async () => {
    const f = fake({ lines: CODEX_OK, writeFiles: { 'x.env': 'K=1\n', 'ok.txt': 'fine\n' } })
    const { k, calls } = await boot(f, { rules: [{ effect: 'deny', rule: 'write(**/*.env)' }], script: n => (n === 1 ? delegate() : say('done')) })
    await detected(k)
    const sid = await create(k)
    await prompt(k, sid)
    await respond(k, (await approval(k, sid)).approvalId, 'allow')
    await waitFor(() => terminal(k, sid).length === 1)
    expect(pay(ofType(k, sid, 'executor.run.ended')[0])).toMatchObject({ status: 'ok', violations: ['x.env'] })
    expect(pay<{ text: string }>(ofType(k, sid, 'executor.notice')[0]).text).toContain('violations: x.env')
    expect(calls.flat().map(m => m.parts.map(p => (p.type === 'text' ? p.text : '')).join('')).join('\n')).toContain('violations: x.env')
  })

  it('deny read(**) blocks a read-only delegation', async () => {
    const f = fake()
    const { k, calls } = await boot(f, { rules: [{ effect: 'deny', rule: 'read(**)' }], script: n => (n === 1 ? delegate({ prompt: 'p', readOnly: true }) : say('done')) })
    await detected(k)
    const sid = await create(k)
    await turn(k, sid)
    expect(toolResult(calls[1])[0].isError).toBe(true)
    expect(execCalls(f)).toEqual([])
  })

  it('deny write(**): write mode denied, read-only allowed without a card', async () => {
    const f = fake()
    const { k, calls } = await boot(f, { rules: [{ effect: 'deny', rule: 'write(**)' }], script: n => (n === 1 ? delegate() : n === 2 ? delegate({ prompt: 'p', readOnly: true }, 'c2') : say('done')) })
    await detected(k)
    const sid = await create(k)
    await turn(k, sid)
    expect(toolResult(calls[1])[0].isError).toBe(true)
    expect(ofType(k, sid, 'approval.requested')).toEqual([])
    expect(execCalls(f)).toHaveLength(1)
    expect(execCalls(f)[0].argv.join(' ')).not.toContain(':project_roots')
  })

  it('a failed self-test at level full: card says unsandboxed and has no key, allow_session does not stick; it runs only after approval', async () => {
    const f = installFake({ lines: CODEX_OK, selftest: 'fail:secret_read' })
    const { k } = await boot(f, { allowUnsandboxedAuto: true, rules: [{ effect: 'allow', rule: 'shell(codex)' }], script: n => (n <= 2 ? delegate({ prompt: 'p', readOnly: true }, `c${n}`) : say('done')) })
    await detected(k)
    expect(await infoOf(k)).toMatchObject({ isolation: 'none', missing: ['codex_selftest'] })
    const sid = await create(k)
    await prompt(k, sid)
    const req = await approval(k, sid)
    expect(req).toMatchObject({ unsandboxed: true })
    expect(req).not.toHaveProperty('key')
    expect(execCalls(f)).toEqual([])
    await respond(k, req.approvalId, 'allow_session')
    const second = await approval(k, sid, 1)
    await respond(k, second.approvalId, 'allow')
    await waitFor(() => terminal(k, sid).length === 1)
    expect(execCalls(f)).toHaveLength(2)
  })

  it('session none + auto: own without the flag asks with no 未隔离; with the flag it just runs', async () => {
    const f = fake()
    const a = await boot(f, { sandbox: NO_SANDBOX, script: n => (n === 1 ? delegate() : say('done')) })
    await detected(a.k)
    const sid = await create(a.k)
    await prompt(a.k, sid)
    const req = await approval(a.k, sid)
    expect(req).not.toHaveProperty('unsandboxed')
    await respond(a.k, req.approvalId, 'allow')
    await waitFor(() => terminal(a.k, sid).length === 1)
    await a.k.close()
    kernels = []

    const b = await boot(f, { sandbox: NO_SANDBOX, allowUnsandboxedAuto: true, script: n => (n === 1 ? delegate() : say('done')) })
    await detected(b.k)
    const s2 = await create(b.k)
    await turn(b.k, s2)
    expect(ofType(b.k, s2, 'approval.requested')).toEqual([])
    expect(pay(ofType(b.k, s2, 'executor.run.ended')[0])).toMatchObject({ status: 'ok' })
  })

  it('a bracket in cwd: profile gaps make it ask as unsandboxed instead of failing later as spawn_failed', async () => {
    const odd = join(root, 'odd[x]')
    mkdirSync(odd)
    const f = fake()
    const { k } = await boot(f, { script: n => (n === 1 ? delegate({ prompt: 'p', readOnly: true }) : say('done')) })
    await detected(k)
    const sid = await create(k, { dir: odd })
    await prompt(k, sid)
    const req = await approval(k, sid)
    expect(req).toMatchObject({ unsandboxed: true })
    await respond(k, req.approvalId, 'allow')
    await waitFor(() => terminal(k, sid).length === 1)
    expect(pay(ofType(k, sid, 'executor.run.ended')[0])).toMatchObject({ status: 'ok' })
    expect(ofType(k, sid, 'executor.run.started').map(e => pay(e).isolation)).toEqual(['none'])
  })

  it('a --foo model is refused by the schema, never reaching argv', async () => {
    const f = fake()
    const { k, calls } = await boot(f, { script: n => (n === 1 ? delegate({ prompt: 'p', model: '--foo' }) : say('done')) })
    await detected(k)
    const sid = await create(k)
    await turn(k, sid)
    expect(toolResult(calls[1])[0].isError).toBe(true)
    expect(execCalls(f)).toEqual([])
  })

  it('a started result carries the run id and isolation', async () => {
    const f = fake()
    const { k, calls } = await boot(f, { script: n => (n === 1 ? delegate() : say('done')) })
    await detected(k)
    const sid = await create(k)
    await turn(k, sid)
    const runId = pay<{ runId: string }>(ofType(k, sid, 'executor.run.queued')[0]).runId
    expect(runId).toMatch(/^run_[0-9a-f]+$/)
    expect(toolResult(calls[1])[0].content).toContain(runId)
    expect(toolResult(calls[1])[0].isError).toBeFalsy()
  })
})

describe('a changed binary', () => {
  const touch = (file: string) => {
    const later = new Date(Date.now() + 60_000)
    utimesSync(file, later, later)
  }

  it('no approval card while it is changed: isError, re-detection updates info, the retry gets its card', async () => {
    const f = installFake({ lines: CODEX_OK })
    const { k, calls } = await boot(f, { script: (_n, req) => (lastText(req.messages).includes('retry please') || calls.length === 1 ? delegate() : say('done')) })
    await detected(k)
    const probes = f.calls().length
    touch(f.file)
    const sid = await create(k, { approvalMode: 'ask' })
    await turn(k, sid)
    expect(ofType(k, sid, 'approval.requested')).toEqual([])
    expect(toolResult(calls[1])[0].isError).toBe(true)
    expect(toolResult(calls[1])[0].content).toContain('reason=untrusted_binary')
    expect(execCalls(f)).toEqual([])
    // 后台重新探测:跑到结束后 info 对得上新文件,不用 refresh
    await waitFor(() => f.calls().length > probes)
    for (let i = 0; i < 500 && f.calls().filter(c => c.argv[0] === 'sandbox').length < 4; i++) await sleep(10)
    const sid2 = await create(k, { approvalMode: 'ask' })
    await prompt(k, sid2, 'retry please')
    await respond(k, (await approval(k, sid2)).approvalId, 'allow')
    await waitFor(() => terminal(k, sid2).length === 1)
    expect(execCalls(f)).toHaveLength(1)
  })

  it('changed after an unsandboxed approval: the run fails, nothing is spawned, and the retry goes through the gate', async () => {
    const f = installFake({ lines: CODEX_OK, selftest: 'fail:secret_read' })
    let retried = false
    const { k } = await boot(f, {
      script: (n, req) => {
        if (n === 1) return delegate({ prompt: 'p', readOnly: true })
        if (!retried && JSON.stringify(req.messages).includes('reason=untrusted_binary')) {
          retried = true
          return delegate({ prompt: 'p2', readOnly: true }, 'c2')
        }
        return say('done')
      },
    })
    await detected(k)
    const sid = await create(k)
    await prompt(k, sid)
    const req = await approval(k, sid)
    expect(req).toMatchObject({ unsandboxed: true })
    touch(f.file) // 人看着卡片时文件换了
    await respond(k, req.approvalId, 'allow')
    await waitFor(() => ofType(k, sid, 'executor.run.ended').length === 1)
    expect(pay(ofType(k, sid, 'executor.run.ended')[0])).toMatchObject({ status: 'failed', reason: 'untrusted_binary' })
    expect(execCalls(f)).toEqual([])
    // 模型按通知重试:新的卡片,批准后跑的是新文件
    const retry = await approval(k, sid, 1)
    await respond(k, retry.approvalId, 'allow')
    await waitFor(() => terminal(k, sid).length === 1)
    expect(execCalls(f)).toHaveLength(1)
  })

  it('refreshed before the approval was answered: the person still approved another file', async () => {
    const f = installFake({ lines: CODEX_OK, selftest: 'fail:secret_read' })
    const { k } = await boot(f, { script: n => (n === 1 ? delegate({ prompt: 'p', readOnly: true }) : say('done')) })
    await detected(k)
    const sid = await create(k)
    await prompt(k, sid)
    const req = await approval(k, sid)
    touch(f.file)
    await k.handle('executor.refresh', {})
    await respond(k, req.approvalId, 'allow')
    await waitFor(() => terminal(k, sid).length === 1)
    expect(pay(ofType(k, sid, 'executor.run.ended')[0])).toMatchObject({ status: 'failed', reason: 'untrusted_binary' })
    expect(execCalls(f)).toEqual([])
  })
})

describe('auth', () => {
  it('logged out: isError with the §14 text, no exec, the turn goes on', async () => {
    const f = fake({ lines: CODEX_OK, loginStatus: 'Not logged in', loginExit: 1 })
    const { k, calls } = await boot(f, { script: n => (n === 1 ? delegate() : say('please log in')) })
    await detected(k)
    expect(await infoOf(k)).toMatchObject({ installed: true, auth: 'missing' })
    const sid = await create(k)
    await turn(k, sid)
    const r = toolResult(calls[1])[0]
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/^\[executor\] id=codex run=- status=failed reason=auth_missing/)
    expect(execCalls(f)).toEqual([])
    expect(terminal(k, sid).map(e => e.type)).toEqual(['turn.ended'])
    expect(ofType(k, sid, 'executor.run.queued')).toEqual([])
  })

  it('missing always re-probes: after logging in the next call runs', async () => {
    const f = fake({ lines: CODEX_OK, loginStatus: 'Not logged in', loginExit: 1 })
    const { k, calls } = await boot(f, { script: n => (n === 1 ? delegate() : n === 2 ? delegate({ prompt: 'p2' }, 'c2') : say('done')), plugin: {} })
    await detected(k)
    const sid = await create(k, { approvalMode: 'ask' })
    await prompt(k, sid)
    const first = await approval(k, sid)
    await respond(k, first.approvalId, 'allow')
    await waitFor(() => calls.length >= 2)
    writeFileSync(join(f.dir, 'scenario.json'), JSON.stringify({ lines: CODEX_OK }))
    await respond(k, (await approval(k, sid, 1)).approvalId, 'allow')
    await waitFor(() => terminal(k, sid).length === 1)
    expect(execCalls(f)).toHaveLength(1)
  })

  it('ok is cached for 30 s, then probed again', async () => {
    let now = 1_000_000
    const f = fake()
    const script: Script = (n, req) => (req.messages[req.messages.length - 1].role === 'user' && !lastText(req.messages).includes('<executor-notice') ? delegate({ prompt: `p${n}`, readOnly: true }, `c${n}`) : say('done'))
    const { k, calls } = await boot(f, { script, plugin: { now: () => now } })
    await detected(k)
    const logins = () => f.calls().filter(c => c.argv[0] === 'login').length
    const before = logins()
    const sid = await create(k)
    await turn(k, sid)
    expect(logins()).toBe(before)
    // 期间退出登录:缓存还在,照跑;过期之后探到
    writeFileSync(join(f.dir, 'scenario.json'), JSON.stringify({ lines: CODEX_OK, loginStatus: 'Not logged in', loginExit: 1 }))
    await turn(k, sid)
    expect(logins()).toBe(before)
    expect(execCalls(f)).toHaveLength(2)
    now += 30_001
    await turn(k, sid)
    expect(logins()).toBe(before + 1)
    expect(execCalls(f)).toHaveLength(2)
    expect(toolResult(calls[calls.length - 1]).at(-1)).toMatchObject({ isError: true })
  })
})

describe('turn end to end', () => {
  it('start → notice → summary → turn.ended; turn.changes and turn.rollback cover what the fake wrote', async () => {
    const f = fake({ lines: CODEX_OK, writeFiles: { 'a.txt': 'changed\n', 'new.txt': 'new\n' }, deleteFiles: ['b.txt'] })
    const { k, calls } = await boot(f, { script: n => (n === 1 ? delegate() : n === 2 ? say('started it') : say('summary')) })
    await detected(k)
    const sid = await create(k)
    const turnId = await turn(k, sid)
    const types = evs(k, sid).map(e => e.type)
    expect(types.filter(t => t === 'turn.ended')).toHaveLength(1)
    expect(types.indexOf('executor.run.ended')).toBeLessThan(types.indexOf('executor.notice'))
    expect(types.indexOf('executor.notice')).toBeLessThan(types.lastIndexOf('message.assistant'))
    expect(calls).toHaveLength(3)
    expect(lastText(calls[2])).toContain('<executor-notice')
    expect(lastText(calls[2])).toContain('status="ok"')
    expect(pay(ofType(k, sid, 'executor.run.ended')[0]).changed).toMatchObject({ source: 'git', files: expect.arrayContaining(['a.txt', 'b.txt', 'new.txt']) })
    const changes = (await k.handle('turn.changes', { sessionId: sid, turnId })) as { files: { path: string }[] }
    expect(changes.files.map(x => x.path).sort()).toEqual(['a.txt', 'b.txt', 'new.txt'])
    const rb = (await k.handle('turn.rollback', { commandId: 'rb', sessionId: sid, turnId })) as { ok: boolean }
    expect(rb.ok).toBe(true)
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('a\n')
    expect(readFileSync(join(cwd, 'b.txt'), 'utf8')).toBe('b\n')
    expect(existsSync(join(cwd, 'new.txt'))).toBe(false)
    // 跑运行的 CLI 拿到的是 stdin,不是 argv
    expect(execCalls(f)[0].stdin).toContain('do it')
    expect(execCalls(f)[0].argv.join(' ')).not.toContain('do it')
  })

  it('parked → session.prompt accepted → model answers → parked again → fake ends → notice → turn.ended', async () => {
    const go = join(root, 'go')
    const f = fake(untilGo(go))
    const { k, calls } = await boot(f, { script: n => (n === 1 ? delegate() : n === 2 ? say('started') : n === 3 ? say('still going') : say('all done')) })
    await detected(k)
    const sid = await create(k)
    const { turnId } = await prompt(k, sid)
    await waitFor(() => ofType(k, sid, 'turn.parked').length === 1)
    const pid = await f.waitPid('cli')
    const r = await prompt(k, sid, 'how is it going')
    expect(r).toEqual({ accepted: true, turnId, followUp: true })
    await waitFor(() => ofType(k, sid, 'turn.parked').length === 2)
    expect(lastText(calls[2])).toContain('how is it going')
    expect(calls).toHaveLength(3)
    expect(isAlive(pid)).toBe(true)
    expect(f.pids().filter(p => p.role === 'cli').map(p => p.pid)).toEqual([pid])
    // 挂起时回滚仍是忙
    await expect(k.handle('turn.rollback', { commandId: 'rb', sessionId: sid, turnId })).rejects.toMatchObject({ code: ERR_BUSY })
    writeFileSync(go, '')
    await waitFor(() => terminal(k, sid).length === 1)
    expect(terminal(k, sid)[0].type).toBe('turn.ended')
    expect(calls).toHaveLength(4)
    expect(lastText(calls[3])).toContain('<executor-notice')
    expect(ofType(k, sid, 'turn.started')).toHaveLength(1)
    expect(pay(ofType(k, sid, 'turn.resumed')[0]).cause).toBe('message')
    expect(pay(ofType(k, sid, 'turn.resumed')[1]).cause).toBe('notice')
  })

  it('a failed run: notice with status failed, and the turn still ends', async () => {
    const f = fake({ lines: [], exit: 3 })
    const { k, calls } = await boot(f, { script: n => (n === 1 ? delegate() : n === 2 ? say('wait') : say('it failed')) })
    await detected(k)
    const sid = await create(k)
    await turn(k, sid)
    expect(terminal(k, sid)[0].type).toBe('turn.ended')
    expect(lastText(calls[2])).toContain('status="failed"')
  })

  it('a worktree session: the fake runs in the worktree, the session cwd is untouched, discard removes it', async () => {
    const f = fake({ lines: CODEX_OK, writeFiles: { 'a.txt': 'changed\n' } })
    writeFileSync(join(cwd, 'untracked.txt'), 'u\n')
    const { k } = await boot(f, { script: n => (n === 1 ? delegate() : say('done')) })
    await detected(k)
    const sid = await create(k, { origin: 'schedule' })
    await turn(k, sid)
    const end = pay<{ status: string; worktree: string; runId: string }>(ofType(k, sid, 'executor.run.ended')[0])
    expect(end.status).toBe('ok')
    expect(end.worktree).toBe(join(`${dataDir}-worktrees`, sid, end.runId))
    expect(execCalls(f)[0].cwd).toBe(end.worktree)
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('a\n')
    expect(readFileSync(join(end.worktree, 'untracked.txt'), 'utf8')).toBe('u\n')
    expect(sh('worktree', 'list')).toContain(end.worktree)
    const changes = (await k.handle('executor.changes', { sessionId: sid, runId: end.runId })) as { files: { path: string }[]; source: string }
    expect(changes).toMatchObject({ source: 'git' })
    expect(changes.files.map(x => x.path)).toEqual(['a.txt'])
    expect(await k.handle('executor.worktree.discard', { commandId: 'd', sessionId: sid, runId: end.runId })).toEqual({ ok: true })
    expect(existsSync(end.worktree)).toBe(false)
    expect(sh('worktree', 'list')).not.toContain(end.worktree)
  })

  it('a non-git session with origin im → worktree_unavailable, the fake never ran', async () => {
    const plain = join(root, 'plain')
    mkdirSync(plain)
    const f = fake()
    const { k } = await boot(f, { script: n => (n === 1 ? delegate() : say('done')) })
    await detected(k)
    const sid = await create(k, { origin: 'im', dir: plain })
    await turn(k, sid)
    expect(pay(ofType(k, sid, 'executor.run.ended')[0])).toMatchObject({ status: 'failed', reason: 'worktree_unavailable' })
    expect(execCalls(f)).toEqual([])
  })
})

describe('dequeue', () => {
  it('queued in auto, then a new ask rule nobody approved → denied, never spawned', async () => {
    const go = join(root, 'go')
    const f = fake(untilGo(go))
    const { k } = await boot(f, { executors: { disabled: ['qoder'], maxPerExecutor: 1, maxGlobal: 1 }, script: n => (n === 1 ? delegate({ prompt: 'one', readOnly: true }) : n === 2 ? delegate({ prompt: 'two', readOnly: true }, 'c2') : say('done')) })
    await detected(k)
    const sid = await create(k)
    await prompt(k, sid)
    await waitFor(() => ofType(k, sid, 'executor.run.queued').length === 2)
    await waitFor(() => ofType(k, sid, 'executor.run.started').length === 1)
    await k.handle('permissions.set', { commandId: 'ps', config: { rules: [{ effect: 'ask', rule: 'shell(codex)' }] } })
    writeFileSync(go, '')
    await waitFor(() => terminal(k, sid).length === 1)
    const ended = ofType(k, sid, 'executor.run.ended').map(e => pay<{ status: string; reason?: string }>(e))
    expect(ended).toHaveLength(2)
    expect(ended[1]).toMatchObject({ status: 'failed', reason: 'denied' })
    expect(execCalls(f)).toHaveLength(1)
  })
})

describe('cancel', () => {
  it('session.cancel on a parked turn: the run dies by SIGINT, its notice stays in the log, the end snapshot comes before the terminal event', async () => {
    const f = fake({ forwarding: true })
    const { k } = await boot(f, { script: n => (n === 1 ? delegate() : say('wait')) })
    await detected(k)
    const sid = await create(k)
    await prompt(k, sid)
    await waitFor(() => ofType(k, sid, 'turn.parked').length === 1)
    const child = await f.waitPid('child')
    await k.handle('session.cancel', { commandId: 'x', sessionId: sid })
    expect(await waitDead(child, 3000)).toBe(true)
    await waitFor(() => ofType(k, sid, 'executor.notice').length === 1)
    expect(pay(ofType(k, sid, 'executor.run.ended')[0])).toMatchObject({ status: 'cancelled', reason: 'cancelled' })
    expect(pay(terminal(k, sid)[0]).reason).toBe('cancelled')
    await waitFor(() => evs(k, sid).filter(e => e.type === 'turn.snapshot').length === 2)
    const types = evs(k, sid).map(e => e.type)
    expect(types.lastIndexOf('turn.snapshot')).toBeLessThan(types.indexOf('turn.failed'))
  })
})

describe('deactivation', () => {
  it('the plugin effect alone kills running fakes and writes interrupted, with no kernel in front of it', async () => {
    const f = fake({ stubborn: true })
    const events: { type: string; payload: Record<string, unknown> }[] = []
    const registered: Tool[] = []
    const effects: (() => void | Promise<void>)[] = []
    const allow = { check: () => 'allow', checkMany: (r: unknown[]) => r.map(() => 'allow') }
    const session = { sessionId: 's1', cwd, origin: 'app' }
    const services: Record<string, unknown> = {
      tools: { register: (t: Tool) => { registered.push(t); return () => {} } },
      sessions: { get: () => session },
      permissionGate: allow,
      sandbox: {
        status: () => ({ level: 'full', missing: [], autoDegraded: false }),
        execPolicy: () => ({ denyRead: [], persistence: [], dataDir, level: 'full', ruleDenyRead: [], ruleDenyWrite: [], untranslatedRules: 0, totalRules: 0 }),
      },
    }
    const log = { info() {}, warn() {}, error() {} }
    const plugin = createExecutorCli({ env: { PATH: `${f.dir}:/usr/bin:/bin`, HOME: home }, loginPath: async () => '', git: isolatedGit() })
    await plugin.activate({
      services: { get: <T>(k: string) => services[k] as T, provide: () => {} },
      events: { on: () => () => {}, history: () => [] },
      effect: (d: () => void | Promise<void>) => effects.push(d),
      rpc: { register: () => {} },
      log,
      config: { executors: { disabled: ['qoder'] } },
      dataDir: join(dataDir, 'plugins', 'executor-cli'),
      append: (e: { type: string; payload: Record<string, unknown> }) => { events.push(e); return e },
    } as never)
    await waitFor(() => registered.length === 1)
    const signal = new AbortController().signal
    const started = await registered[0].run({ prompt: 'x', readOnly: true }, { sessionId: 's1', turnId: 't1', callId: 'c1', cwd, spillDir: join(root, 'spill'), signal })
    expect(started.isError).toBeFalsy()
    const cli = await f.waitPid('cli')
    const grand = await f.waitPid('grandchild')
    for (const d of effects.reverse()) await d()
    // 效果只限时等一小会儿,进程按短梯死
    expect(await waitDead(cli, 3000)).toBe(true)
    expect(await waitDead(grand, 500)).toBe(true)
    await waitFor(() => events.some(e => e.type === 'executor.run.ended'))
    expect(events.find(e => e.type === 'executor.run.ended')!.payload).toMatchObject({ status: 'interrupted', reason: 'kernel_stopping' })
    // 之后再派:拒绝,不会起进程
    const after = await registered[0].run({ prompt: 'x', readOnly: true }, { sessionId: 's1', turnId: 't2', callId: 'c2', cwd, spillDir: join(root, 'spill'), signal })
    expect(after).toMatchObject({ isError: true })
    expect(after.content).toContain('reason=kernel_stopping')
  })
})

describe('RPC', () => {
  it('executor.cancel: this turn goes on and the model hears status=cancelled; another session and a finished run get ok:false', async () => {
    const f = fake({ forwarding: true })
    const { k, calls } = await boot(f, { script: n => (n === 1 ? delegate() : n === 2 ? say('wait') : say('cancelled, ok')) })
    await detected(k)
    const sid = await create(k)
    const other = await create(k)
    await prompt(k, sid)
    await waitFor(() => ofType(k, sid, 'executor.run.started').length === 1)
    const { runId } = pay<{ runId: string }>(ofType(k, sid, 'executor.run.queued')[0])
    expect(await k.handle('executor.cancel', { commandId: 'x1', sessionId: other, runId })).toEqual({ ok: false })
    expect(isAlive(await f.waitPid('cli'))).toBe(true)
    expect(await k.handle('executor.cancel', { commandId: 'x2', sessionId: sid, runId })).toEqual({ ok: true })
    await waitFor(() => terminal(k, sid).length === 1)
    expect(terminal(k, sid)[0].type).toBe('turn.ended')
    expect(lastText(calls[2])).toContain('status="cancelled"')
    expect(await k.handle('executor.cancel', { commandId: 'x3', sessionId: sid, runId })).toEqual({ ok: false })
  })

  it('a runId from another session is unknown everywhere', async () => {
    const f = fake()
    const { k } = await boot(f, { script: n => (n === 1 ? delegate() : say('done')) })
    await detected(k)
    const sid = await create(k)
    const other = await create(k)
    await turn(k, sid)
    const { runId } = pay<{ runId: string }>(ofType(k, sid, 'executor.run.queued')[0])
    await expect(k.handle('executor.changes', { sessionId: other, runId })).rejects.toMatchObject({ code: -32602 })
    expect(await k.handle('executor.worktree.discard', { commandId: 'd', sessionId: other, runId })).toEqual({ ok: false })
    expect(await k.handle('executor.changes', { sessionId: sid, runId })).toMatchObject({ source: 'git' })
  })

  it('discard of a running worktree run is busy', async () => {
    const go = join(root, 'go')
    const f = fake(untilGo(go))
    const { k } = await boot(f, { script: n => (n === 1 ? delegate() : say('done')) })
    await detected(k)
    const sid = await create(k, { origin: 'schedule' })
    await prompt(k, sid)
    await waitFor(() => ofType(k, sid, 'executor.run.started').length === 1)
    const { runId } = pay<{ runId: string }>(ofType(k, sid, 'executor.run.queued')[0])
    await expect(k.handle('executor.worktree.discard', { commandId: 'd', sessionId: sid, runId })).rejects.toMatchObject({ code: ERR_BUSY })
    writeFileSync(go, '')
    await waitFor(() => terminal(k, sid).length === 1)
  })

  it('executor.refresh passes force: a self-test that now fails is seen', async () => {
    const f = installFake({ lines: CODEX_OK })
    const { k } = await boot(f)
    await detected(k)
    expect((await infoOf(k)).isolation).toBe('own')
    writeFileSync(join(f.dir, 'scenario.json'), JSON.stringify({ selftest: 'fail:secret_read' }))
    const r = (await k.handle('executor.refresh', {})) as { executors: Info[] }
    expect(r.executors.find(e => e.id === 'codex')).toMatchObject({ isolation: 'none', missing: ['codex_selftest'] })
  })
})

describe('codex.network', () => {
  it('network:true → none, codex_network, no self-test run', async () => {
    const f = installFake({ lines: CODEX_OK })
    const { k } = await boot(f, { executors: { codex: { network: true } } })
    await detected(k)
    expect(await infoOf(k)).toMatchObject({ isolation: 'none', missing: ['codex_network'] })
    expect(f.calls().filter(c => c.argv[0] === 'sandbox')).toEqual([])
  })

  it('a change to the config section re-detects, in both directions', async () => {
    const f = installFake({ lines: CODEX_OK })
    CONFIG_SECTIONS['config-writer'] = ['executors']
    let update: (v: unknown) => void = () => {}
    const writer: Plugin = { manifest: { id: 'config-writer', version: '0', kernel: '^0.1.0' }, activate: ctx => { update = v => ctx.updateConfig('executors', v) } }
    try {
      const { k } = await boot(f, { extra: [writer] })
      await detected(k)
      expect(await infoOf(k)).toMatchObject({ isolation: 'own', missing: [] })
      update({ disabled: ['qoder'], codex: { network: true } })
      await waitFor(() => f.calls().filter(c => c.argv[0] === '--version').length === 2)
      for (let i = 0; i < 500 && (await infoOf(k)).isolation !== 'none'; i++) await sleep(10)
      expect(await infoOf(k)).toMatchObject({ isolation: 'none', missing: ['codex_network'] })
      update({ disabled: ['qoder'], codex: { network: false } })
      for (let i = 0; i < 500 && (await infoOf(k)).isolation !== 'own'; i++) await sleep(10)
      expect(await infoOf(k)).toMatchObject({ isolation: 'own', missing: [] })
    } finally {
      delete CONFIG_SECTIONS['config-writer']
    }
  })
})

describe('close', () => {
  it('kernel.close with a run: interrupted / kernel_stopping, no process left, within budget', async () => {
    const f = fake({ stubborn: true })
    const { k } = await boot(f, { script: n => (n === 1 ? delegate() : say('wait')) })
    await detected(k)
    const sid = await create(k)
    await prompt(k, sid)
    const cli = await f.waitPid('cli')
    const grand = await f.waitPid('grandchild')
    const t0 = Date.now()
    await k.close()
    kernels = []
    expect(Date.now() - t0).toBeLessThan(CLOSE_GRACE_MS + KILL_LIVE_MS)
    expect(isAlive(cli)).toBe(false)
    expect(await waitDead(grand, 500)).toBe(true)
    const again = await createKernel({ dataDir, home, secrets: { osBackend: false }, sandbox: NO_SANDBOX, plugins: [] })
    kernels.push(again)
    const ended = again.events.bySession(sid).filter(e => e.type === 'executor.run.ended')
    expect(ended).toHaveLength(1)
    expect(pay(ended[0])).toMatchObject({ status: 'interrupted', reason: 'kernel_stopping' })
    expect(again.events.bySession(sid).filter(e => e.type === 'executor.notice')).toHaveLength(1)
    expect(again.events.bySession(sid).find(e => e.type === 'turn.failed' || e.type === 'turn.ended')).toBeDefined()
  })

  it('cancelled just before close: not left on the long ladder past CLOSE_GRACE_MS', async () => {
    const f = fake({ stubborn: true })
    const { k } = await boot(f, { script: n => (n === 1 ? delegate() : say('wait')) })
    await detected(k)
    const sid = await create(k)
    await prompt(k, sid)
    const cli = await f.waitPid('cli')
    const grand = await f.waitPid('grandchild')
    await waitFor(() => ofType(k, sid, 'executor.run.started').length === 1)
    const { runId } = pay<{ runId: string }>(ofType(k, sid, 'executor.run.queued')[0])
    await k.handle('executor.cancel', { commandId: 'x', sessionId: sid, runId })
    const t0 = Date.now()
    await k.close()
    kernels = []
    expect(Date.now() - t0).toBeLessThan(CLOSE_GRACE_MS + KILL_LIVE_MS)
    expect(isAlive(cli)).toBe(false)
    expect(await waitDead(grand, 500)).toBe(true)
  })

  it('a turn stuck in a model call that ignores the signal: the run still gets SIGINT first, before killLive, and ended is logged', async () => {
    const f = fake({ forwarding: true })
    let release = () => {}
    const hold = new Promise<void>(res => { release = res })
    async function* stuck(): AsyncGenerator<ModelEvent> {
      await hold
      yield done()
    }
    const { k } = await boot(f, { script: n => (n === 1 ? delegate() : stuck()) })
    await detected(k)
    const sid = await create(k)
    await prompt(k, sid)
    const child = await f.waitPid('child')
    const ended: Record<string, unknown>[] = []
    k.events.onAppend(e => {
      if (e.type === 'executor.run.ended') ended.push(pay(e))
    })
    await k.close()
    kernels = []
    release()
    expect(ended).toHaveLength(1)
    expect(ended[0]).toMatchObject({ status: 'interrupted', reason: 'kernel_stopping' })
    // SIGINT 先到:forwarding 自己收掉自成一会话的子进程。killLive 的 SIGTERM 打头的话它活下来
    expect(await waitDead(child, 500)).toBe(true)
  })

  it('a stuck end step does not hold close past the budget, and recovery writes what is missing', async () => {
    const f = fake({ lines: CODEX_OK })
    let stuck = false
    let release = () => {}
    const hold = new Promise<void>(res => { release = res })
    const real = isolatedGit()
    const git: typeof real = async (args, o) => {
      if (stuck && args.includes('add')) await hold
      return real(args, o)
    }
    const go = join(root, 'go')
    writeFileSync(join(f.dir, 'scenario.json'), JSON.stringify(untilGo(go)))
    const { k } = await boot(f, { script: n => (n === 1 ? delegate() : say('wait')), plugin: { git } })
    await detected(k)
    const sid = await create(k)
    await prompt(k, sid)
    await waitFor(() => ofType(k, sid, 'turn.parked').length === 1)
    stuck = true
    writeFileSync(go, '')
    await sleep(300) // CLI 退了,卡在结束快照里
    const t0 = Date.now()
    await k.close()
    kernels = []
    release()
    expect(Date.now() - t0).toBeLessThan(CLOSE_GRACE_MS + KILL_LIVE_MS + 1500)
    await sleep(50)
    const again = await createKernel({ dataDir, home, secrets: { osBackend: false }, sandbox: NO_SANDBOX, plugins: [] })
    kernels.push(again)
    expect(again.events.bySession(sid).filter(e => e.type === 'executor.run.ended')).toHaveLength(1)
    expect(again.events.bySession(sid).filter(e => e.type === 'executor.notice')).toHaveLength(1)
  })
})

describe('restart', () => {
  /** 关掉内核但日志里留一个开着的运行:崩溃的样子 */
  async function crashedLog(extra: (sid: string, turnId: string) => { type: string; payload: object }[], plugins: Plugin[] = []) {
    const k = await createKernel({ dataDir, home, secrets: { osBackend: false }, sandbox: NO_SANDBOX, plugins })
    const { sessionId } = (await k.handle('session.create', { commandId: 'c', cwd, model: REF, approvalMode: 'auto' })) as { sessionId: string }
    const turnId = 't-crashed'
    k.events.append({ type: 'message.user', sessionId, payload: { turnId, text: 'hi' } })
    k.events.append({ type: 'turn.started', sessionId, payload: { turnId } })
    for (const e of extra(sessionId, turnId)) k.events.append({ ...e, sessionId } as Omit<KernelEvent, 'seq' | 'ts'>)
    await k.close()
    return { sessionId, turnId }
  }
  const queued = (runId: string, turnId: string) => ({ type: 'executor.run.queued', payload: { runId, turnId, callId: 'c1', executor: 'codex', summary: 'codex: x', readOnly: false, isolation: 'own', position: 0 } })
  const started = (runId: string, turnId: string, o: object = {}) => ({ type: 'executor.run.started', payload: { runId, turnId, executor: 'codex', cwd, isolation: 'own', ...o } })

  it('open run: ended, notice, turn.failed interrupted in that order; the next turn sees the notice; the fake is not started again', async () => {
    const f = fake()
    const { sessionId: sid } = await crashedLog((_s, t) => [queued('run_abc', t), started('run_abc', t)])
    const { k, calls } = await boot(f, { script: () => say('ok') })
    await detected(k)
    const after = evs(k, sid)
    const at = (t: string) => after.findIndex(e => e.type === t)
    expect(pay(after[at('executor.run.ended')])).toMatchObject({ status: 'interrupted', reason: 'daemon_restart', ms: 0, changed: { files: [], source: 'none' } })
    expect(at('executor.run.ended')).toBeLessThan(at('executor.notice'))
    expect(at('executor.notice')).toBeLessThan(at('turn.failed'))
    expect(pay(after[at('turn.failed')]).reason).toBe('interrupted')
    await turn(k, sid, 'what happened')
    const text = calls[0].flatMap(m => m.parts).map(p => (p.type === 'text' ? p.text : '')).join('\n')
    expect(text).toContain('status="interrupted"')
    expect(text).toContain('git status')
    expect(execCalls(f)).toEqual([])
  })

  it('recovery on the next restart writes nothing', async () => {
    const { sessionId: sid } = await crashedLog((_s, t) => [queued('run_abc', t)])
    const open = async () => createKernel({ dataDir, home, secrets: { osBackend: false }, sandbox: NO_SANDBOX, plugins: [] })
    const a = await open()
    const n = a.events.bySession(sid).length
    await a.close()
    const b = await open()
    kernels.push(b)
    expect(b.events.bySession(sid)).toHaveLength(n)
  })

  it('crash between worktree add and spawn: the worktree and its git entry go, and no worktree on the ended', async () => {
    const runId = 'run_0a0b'
    const reserved = (sid: string) => join(realpathSync(root), 'data-worktrees', sid, runId)
    const { sessionId: sid } = await crashedLog((s, t) => {
      mkdirSync(join(`${dataDir}-worktrees`, s), { recursive: true })
      sh('worktree', 'add', '--detach', reserved(s), 'HEAD')
      return [queued(runId, t)]
    })
    expect(existsSync(reserved(sid))).toBe(true)
    const k = await createKernel({ dataDir, home, secrets: { osBackend: false }, sandbox: { ...NO_SANDBOX, git: isolatedGit() }, plugins: [] })
    kernels.push(k)
    expect(existsSync(reserved(sid))).toBe(false)
    expect(sh('worktree', 'list')).not.toContain(reserved(sid))
    expect(pay(k.events.bySession(sid).find(e => e.type === 'executor.run.ended'))).not.toHaveProperty('worktree')
  })

  it('a started worktree stays, named on the ended, minus literal deny-read copies', async () => {
    const runId = 'run_0c0d'
    const path = (sid: string) => join(realpathSync(root), 'data-worktrees', sid, runId)
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ permissions: { rules: [{ effect: 'deny', rule: 'read(hidden/**)' }] } }))
    const { sessionId: sid } = await crashedLog((s, t) => {
      mkdirSync(join(path(s), 'hidden'), { recursive: true })
      writeFileSync(join(path(s), 'hidden', 'secret'), 'SECRET')
      writeFileSync(join(path(s), 'kept.txt'), 'half done')
      return [queued(runId, t), started(runId, t, { cwd: path(s), worktree: path(s) })]
    })
    const k = await createKernel({ dataDir, home, secrets: { osBackend: false }, sandbox: { ...NO_SANDBOX, git: isolatedGit() }, plugins: [] })
    kernels.push(k)
    expect(existsSync(join(path(sid), 'hidden'))).toBe(false)
    expect(readFileSync(join(path(sid), 'kept.txt'), 'utf8')).toBe('half done')
    expect(pay(k.events.bySession(sid).find(e => e.type === 'executor.run.ended')).worktree).toBe(path(sid))
    expect(pay<{ text: string }>(k.events.bySession(sid).find(e => e.type === 'executor.notice')).text).toContain(`worktree: ${path(sid)}`)
  })

  it('a forged worktree path in the log removes nothing', async () => {
    const victim = join(root, 'victim')
    mkdirSync(join(victim, 'hidden'), { recursive: true })
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ permissions: { rules: [{ effect: 'deny', rule: `read(${victim}/hidden/**)` }] } }))
    const { sessionId: sid } = await crashedLog((_s, t) => [queued('run_0e0f', t), started('run_0e0f', t, { cwd: victim, worktree: victim })])
    const k = await createKernel({ dataDir, home, secrets: { osBackend: false }, sandbox: { ...NO_SANDBOX, git: isolatedGit() }, plugins: [] })
    kernels.push(k)
    expect(existsSync(join(victim, 'hidden'))).toBe(true)
    expect(k.events.bySession(sid).some(e => e.type === 'executor.run.ended')).toBe(true)
  })
})

// executor-cli 端到端测试共用:真内核、真权限门、假模型、假 CLI(04 Review Focus 2、3、3a、4、6)
import { afterAll, afterEach, beforeAll, beforeEach, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKernel, type Kernel, type KernelOpts } from '../src/kernel/kernel'
import type { Plugin } from '../src/kernel/pluginHost'
import { createGit } from '../src/lib/git/snapshot'
import type { Message, ModelEvent, ModelRequest, ModelsService } from '../src/lib/models/types'
import type { Tool, ToolsService } from '../src/lib/tools/types'
import type { KernelEvent } from '../src/protocol/index'
import type { ModelRef } from '../src/protocol/models'
import { cleanupFakes, disposeReusableFakes, reusableFake, type FakeCli } from './fakeCli'
import { createLoopDefault } from '../src/plugins/loop-default'
import { createToolsCoding } from '../src/plugins/tools-coding'
import toolsRegistry from '../src/plugins/tools-registry'
import { createExecutorCli, type ExecutorCliOpts } from '../src/plugins/executor-cli/index'

export const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', 'executors', name), 'utf8').split('\n').filter(Boolean)
export const CODEX_OK = fixture('codex-exec-0.154.jsonl')
export const FINISH = '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
export const FULL: NonNullable<KernelOpts['sandbox']> = { detect: () => ({ level: 'full', missing: [] }), upstream: null }
export const REF: ModelRef = { accountId: 'acc', modelId: 'gpt-5' }

export let root: string
export let dataDir: string
export let home: string
export let cwd: string
export const kernels: Kernel[] = []
export let bins: string

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
export async function waitFor(fn: () => boolean, ms = 15_000) {
  const end = Date.now() + ms
  while (Date.now() < end && !fn()) await sleep(10)
  expect(fn()).toBe(true)
}
const gitEnvBase = '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin'
export const gitEnv = (): NodeJS.ProcessEnv => ({ PATH: gitEnvBase, HOME: home, GIT_CONFIG_GLOBAL: join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_CEILING_DIRECTORIES: root })
export const isolatedGit = () => createGit({ base: gitEnv() })
export const sh = (...args: string[]) => execFileSync('git', args, { cwd, env: gitEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

/** 每个用例复制一份,不重新 init:四次 git 就是 0.2 s */
export function makeTemplate(): string {
  const t = realpathSync(mkdtempSync(join(tmpdir(), 'mffai-execcli-template-')))
  const env = { PATH: gitEnvBase, HOME: t, GIT_CONFIG_GLOBAL: join(t, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' }
  writeFileSync(join(t, 'gitconfig'), '[user]\n\tname = t\n\temail = t@example.invalid\n')
  const dir = join(t, 'repo')
  mkdirSync(dir)
  writeFileSync(join(dir, 'a.txt'), 'a\n')
  writeFileSync(join(dir, 'b.txt'), 'b\n')
  const g = (...args: string[]) => execFileSync('git', args, { cwd: dir, env, stdio: 'ignore' })
  g('init', '-q')
  g('add', '-A')
  g('commit', '-qm', 'init')
  return t
}

/** 文件顶上调一次:每个用例一套临时目录和一个提交过的 repo */
export function useRig(): void {
  let template: string
  // 都在钩子里建:一个用例都不跑的文件(-t 过滤)不会跑 afterAll
  beforeAll(() => {
    bins = realpathSync(mkdtempSync(join(tmpdir(), 'mffai-execcli-bins-')))
    template = makeTemplate()
  })
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'mffai-execcli-')))
    dataDir = join(root, 'data')
    home = join(root, 'home')
    cwd = join(root, 'repo')
    for (const d of [dataDir, home]) mkdirSync(d)
    cpSync(template, root, { recursive: true })
  })
  afterEach(async () => {
    for (const k of kernels) await k.close().catch(() => {})
    kernels.length = 0
    cleanupFakes()
    rmSync(root, { recursive: true, force: true })
    rmSync(`${root}-worktrees`, { recursive: true, force: true })
  })
  afterAll(() => {
    disposeReusableFakes()
    rmSync(bins, { recursive: true, force: true })
    rmSync(template, { recursive: true, force: true })
  })
}

/** 只看卡片、argv 的用例:没有 repo 就没有快照,一轮省掉 1 s 多 */
export const noRepo = () => rmSync(join(cwd, '.git'), { recursive: true, force: true })

export type Req = Omit<ModelRequest, 'model'>
export type Script = (n: number, req: Req) => AsyncIterable<ModelEvent>
async function* seq(...evs: ModelEvent[]) {
  for (const e of evs) yield e
}
export const done = (reason: 'stop' | 'tool_calls' = 'stop'): ModelEvent => ({ type: 'done', reason })
export const calling = (id: string, name: string, args: object) => seq({ type: 'tool_call', id, name, argsDelta: JSON.stringify(args) }, done('tool_calls'))
export const say = (text: string) => seq({ type: 'text', delta: text }, { type: 'usage', input: 1, output: 1 }, done())
export const delegate = (args: object = { prompt: 'do it' }, id = 'c1', name = 'delegate_codex') => calling(id, name, args)

export function fakeModels(calls: Message[][], script: Script): Plugin {
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

export interface Rig {
  k: Kernel
  calls: Message[][]
  tools(): Tool[]
}
export interface BootOpts {
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
export async function boot(fake: Pick<FakeCli, 'dir'> | undefined, o: BootOpts = {}): Promise<Rig> {
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

export type Info = { id: string; installed: boolean; version?: string; auth: string; isolation: string; missing: string[] }
export const list = async (k: Kernel) => ((await k.handle('executor.list', {})) as { executors: Info[] }).executors
export const infoOf = async (k: Kernel, id = 'codex') => (await list(k)).find(e => e.id === id)!
export async function detected(k: Kernel) {
  for (let i = 0; i < 1500; i++) {
    if (!(await list(k)).some(e => e.missing.includes('detecting'))) return
    await sleep(10)
  }
  throw new Error('detection never finished')
}
export const create = async (k: Kernel, o: { approvalMode?: 'ask' | 'auto'; origin?: 'app' | 'im' | 'schedule' | 'acp'; dir?: string } = {}) =>
  ((await k.handle('session.create', { commandId: `c${Math.random()}`, cwd: o.dir ?? cwd, model: REF, approvalMode: o.approvalMode ?? 'auto', ...(o.origin && { origin: o.origin }) })) as { sessionId: string }).sessionId
export const prompt = async (k: Kernel, sid: string, text = 'go') => (await k.handle('session.prompt', { commandId: `p${Math.random()}`, sessionId: sid, text })) as { accepted: boolean; turnId: string; followUp?: boolean }
export const evs = (k: Kernel, sid: string) => k.events.bySession(sid)
export const pay = <T = Record<string, any>>(e: KernelEvent | undefined) => e?.payload as T
export const ofType = (k: Kernel, sid: string, t: string) => evs(k, sid).filter(e => e.type === t)
export const terminal = (k: Kernel, sid: string) => evs(k, sid).filter(e => e.type === 'turn.ended' || e.type === 'turn.failed')
export const execCalls = (f: FakeCli) => f.calls().filter(c => c.argv[0] === 'exec' || c.argv[0] === '-p')
export async function turn(k: Kernel, sid: string, text = 'go') {
  const want = terminal(k, sid).length + 1
  const { turnId } = await prompt(k, sid, text)
  await waitFor(() => terminal(k, sid).length >= want)
  return turnId
}
export const toolResult = (m: Message[]) => m.filter(x => x.role === 'tool').flatMap(x => x.parts).filter(p => p.type === 'tool_result') as { callId: string; content: string; isError?: boolean }[]
export const lastText = (m: Message[]) => {
  const last = m[m.length - 1]
  return last.parts.map(p => (p.type === 'text' ? p.text : '')).join('')
}
export async function approval(k: Kernel, sid: string, nth = 0) {
  await waitFor(() => ofType(k, sid, 'approval.requested').length > nth)
  return pay<{ approvalId: string; key?: string; unsandboxed?: boolean; summary: string }>(ofType(k, sid, 'approval.requested')[nth])
}
export const respond = (k: Kernel, approvalId: string, decision: 'allow' | 'allow_session' | 'deny') => k.handle('approval.respond', { approvalId, decision })

/** 假 CLI 一直跑到 go 文件出现 */
export const untilGo = (go: string, also: object = {}) => ({ ...also, run: `while [ ! -e '${go}' ]; do sleep 0.02; done; printf '%s\\n' '${FINISH}'` })
export const fake = (scenario: object = { lines: CODEX_OK }) => reusableFake(scenario, 'codex', bins)


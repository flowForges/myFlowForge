import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKernel, type Kernel } from '../../kernel/kernel'
import type { Plugin } from '../../kernel/pluginHost'
import { createGit, type Git } from '../../lib/git/snapshot'
import type { Message, ModelEvent, ModelRequest, ModelsService } from '../../lib/models/types'
import { ERR_BUSY, type KernelEvent } from '../../protocol/index'
import type { ModelRef } from '../../protocol/models'
import { createToolsCoding } from '../tools-coding'
import toolsRegistry from '../tools-registry'
import { createLoopDefault } from './index'

const posix = process.platform !== 'win32'

let root: string
let dataDir: string
let home: string
let repo: string
let snapTmp: string
let kernels: Kernel[] = []

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'mffai-loopsnap-')))
  dataDir = join(root, 'data')
  home = join(root, 'home')
  repo = join(root, 'repo')
  snapTmp = join(root, 'snaptmp')
  for (const d of [dataDir, home, repo]) mkdirSync(d)
})
afterEach(async () => {
  for (const k of kernels) await k.close().catch(() => {})
  kernels = []
  rmSync(root, { recursive: true, force: true })
})

/** 家目录、git 全局配置都在临时目录;不往 root 之外找仓库 */
const gitInjected = () => ({ GIT_CONFIG_GLOBAL: join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', HOME: home, GIT_CEILING_DIRECTORIES: root })
const baseEnv = () => ({ PATH: process.env.PATH ?? '', HOME: home, USERPROFILE: home })
const ug = (args: string[], cwd = repo) => execFileSync('git', args, { cwd, env: { ...baseEnv(), ...gitInjected() } }).toString()
const commit = (msg: string) => ug(['-c', 'user.name=u', '-c', 'user.email=u@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-q', '-m', msg])
const R = (p: string) => join(repo, p)
const hidden = () => ug(['for-each-ref', '--format=%(refname)', 'refs/mffai']).split('\n').filter(Boolean)
function initRepo() {
  ug(['init', '-q', '-b', 'main'])
  writeFileSync(R('a.txt'), 'a v1\n')
  writeFileSync(R('b.txt'), 'b v1\n')
  writeFileSync(R('exec.sh'), '#!/bin/sh\necho hi\n')
  chmodSync(R('exec.sh'), 0o755)
  ug(['add', '.'])
  commit('init')
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function waitFor(fn: () => boolean, ms = 10_000) {
  const end = Date.now() + ms
  while (Date.now() < end && !fn()) await sleep(5)
  expect(fn()).toBe(true)
}

type Req = Omit<ModelRequest, 'model'>
type Script = (n: number, req: Req) => AsyncIterable<ModelEvent>
const GPT: ModelRef = { accountId: 'acc', modelId: 'gpt-5' }
const CLAUDE: ModelRef = { accountId: 'acc', modelId: 'claude-sonnet-4-5' }

function fakeModels(calls: Message[][], script: () => Script): Plugin {
  const service = {
    catalog: () => ({ presets: [], models: {} }),
    accounts: () => [],
    stream(_ref: ModelRef | 'default', req: Req) {
      calls.push(structuredClone(req.messages))
      return script()(calls.length, req)
    },
  } as unknown as ModelsService
  return { manifest: { id: 'fake-models', version: '0', kernel: '^0.1.0', provides: ['models'] }, activate: ctx => ctx.services.provide('models', service) }
}
async function* seq(...evs: ModelEvent[]) {
  for (const e of evs) yield e
}
const calling = (id: string, name: string, args: object): AsyncIterable<ModelEvent> =>
  seq({ type: 'tool_call', id, name, argsDelta: JSON.stringify(args) }, { type: 'done', reason: 'tool_calls' })
const say = (text: string): AsyncIterable<ModelEvent> => seq({ type: 'text', delta: text }, { type: 'done', reason: 'stop' })
/** 每轮:第一步调用一个工具,第二步回答 */
const oneTool = (name: string, args: object): Script => (n => (n % 2 === 1 ? calling(`c${n}`, name, args) : say('done')))

async function boot(calls: Message[][], script: () => Script, wrapGit?: (g: Git) => Git) {
  const g = createGit({ base: baseEnv(), extraEnv: gitInjected() })
  const k = await createKernel({
    dataDir,
    home,
    secrets: { osBackend: false },
    injectTimeoutMs: 100,
    plugins: [
      fakeModels(calls, script),
      toolsRegistry,
      createToolsCoding({ shellEnv: baseEnv(), loginPath: async () => '', git: async () => { throw new Error('git disabled in tests') }, minTimeoutMs: 100 }),
      createLoopDefault({ git: wrapGit ? wrapGit(g) : g, snapshotTmpDir: snapTmp }),
    ],
  })
  kernels.push(k)
  return k
}
const evs = (k: Kernel, sid: string) => k.events.bySession(sid)
const pay = <T = Record<string, unknown>>(e: KernelEvent | undefined) => e?.payload as T
const snaps = (k: Kernel, sid: string, turnId: string) => evs(k, sid).filter(e => e.type === 'turn.snapshot' && pay(e).turnId === turnId).map(e => pay(e))
async function create(k: Kernel, model: ModelRef, cwd = repo) {
  return ((await k.handle('session.create', { commandId: `c${Math.random()}`, model, cwd, approvalMode: 'auto' })) as { sessionId: string }).sessionId
}
const prompt = async (k: Kernel, sid: string, text: string) =>
  ((await k.handle('session.prompt', { commandId: `p${Math.random()}`, sessionId: sid, text })) as { turnId: string }).turnId
/** 一轮跑完:终态 + 结束快照都写下 */
async function turn(k: Kernel, sid: string, text: string) {
  const turnId = await prompt(k, sid, text)
  await waitFor(() => snaps(k, sid, turnId).some(p => p.phase === 'end'))
  return turnId
}
const rollback = (k: Kernel, sessionId: string, turnId: string) => k.handle('turn.rollback', { commandId: `r${Math.random()}`, sessionId, turnId })
const changesOf = (k: Kernel, sessionId: string, turnId: string) => k.handle('turn.changes', { sessionId, turnId })

describe('loop-default snapshots', () => {
  it('writes start and end turn.snapshot with refs and the changed count', async () => {
    initRepo()
    const calls: Message[][] = []
    const k = await boot(calls, () => oneTool('write', { path: 'new.txt', content: 'n\n' }))
    const sid = await create(k, CLAUDE)
    const turnId = await turn(k, sid, 'add a file')
    const base = `refs/mffai/snapshots/${sid}/${turnId}`
    expect(snaps(k, sid, turnId)).toEqual([
      { turnId, phase: 'start', ref: `${base}-start` },
      { turnId, phase: 'end', ref: `${base}-end`, changed: 1 },
    ])
    expect(hidden().sort()).toEqual([`${base}-end`, `${base}-start`])
    // 事件顺序:开始快照在第一次模型请求之前,结束快照在终态之后
    const types = evs(k, sid).map(e => e.type).filter(t => t !== 'message.assistant.delta' && t !== 'turn.usage')
    expect(types).toEqual(['session.created', 'message.user', 'turn.started', 'turn.snapshot', 'message.assistant', 'tool.started', 'tool.ended', 'message.assistant', 'turn.ended', 'turn.snapshot'])
    expect(ug(['status', '--porcelain'])).toBe('?? new.txt\n') // 用户的索引没动
    expect(readdirSync(snapTmp)).toEqual([])
  })

  it('a non-git cwd → turn.snapshot reason not_git, and the turn still succeeds', async () => {
    const calls: Message[][] = []
    const k = await boot(calls, () => () => say('hi'))
    const sid = await create(k, CLAUDE)
    const turnId = await turn(k, sid, 'hello')
    expect(snaps(k, sid, turnId)).toEqual([
      { turnId, phase: 'start', reason: 'not_git' },
      { turnId, phase: 'end', reason: 'not_git' },
    ])
    expect(evs(k, sid).some(e => e.type === 'turn.ended')).toBe(true)
    await expect(changesOf(k, sid, turnId)).rejects.toMatchObject({ code: -32602 })
    await expect(rollback(k, sid, turnId)).rejects.toMatchObject({ code: -32602 })
  })

  it('a cancelled turn still writes the end snapshot', async () => {
    initRepo()
    const calls: Message[][] = []
    const k = await boot(calls, () => async function* (_n, req) {
      yield { type: 'text', delta: 'x' } as ModelEvent
      await new Promise<void>(r => req.signal.addEventListener('abort', () => r()))
      yield { type: 'done', reason: 'cancelled' } as ModelEvent
    })
    const sid = await create(k, CLAUDE)
    const turnId = await prompt(k, sid, 'go')
    await waitFor(() => evs(k, sid).some(e => e.type === 'message.assistant.delta'))
    await k.handle('session.cancel', { commandId: 'cx', sessionId: sid })
    await waitFor(() => snaps(k, sid, turnId).some(p => p.phase === 'end'))
    expect(evs(k, sid).find(e => e.type === 'turn.failed')).toMatchObject({ payload: { reason: 'cancelled' } })
    expect(snaps(k, sid, turnId).at(-1)).toEqual({ turnId, phase: 'end', ref: `refs/mffai/snapshots/${sid}/${turnId}-end`, changed: 0 })
  })
})

describe('Review Focus 5: turn.rollback restores only that turn files', () => {
  const patch = [
    '*** Begin Patch',
    '*** Update File: a.txt', '@@', '-a v1', '+a by turn',
    '*** Delete File: exec.sh',
    '*** Add File: new.txt', '+new',
    '*** End Patch',
  ].join('\n')

  it.skipIf(!posix)('restores a.txt, recreates exec.sh with its exec bit, removes new.txt, leaves later user edits; a second rollback is rejected', async () => {
    initRepo()
    const calls: Message[][] = []
    const k = await boot(calls, () => oneTool('apply_patch', { patch }))
    const sid = await create(k, GPT)
    const turnId = await turn(k, sid, 'change things')
    expect(readFileSync(R('a.txt'), 'utf8')).toBe('a by turn\n')
    expect(existsSync(R('exec.sh'))).toBe(false)
    expect(existsSync(R('new.txt'))).toBe(true)
    expect(snaps(k, sid, turnId).at(-1)).toMatchObject({ changed: 3 })
    expect(await changesOf(k, sid, turnId)).toEqual({
      files: [
        { path: 'a.txt', status: 'M' },
        { path: 'exec.sh', status: 'D' },
        { path: 'new.txt', status: 'A' },
      ],
    })

    // 轮结束后用户自己的改动
    writeFileSync(R('later.txt'), 'later\n')
    writeFileSync(R('b.txt'), 'b by user\n')

    expect(await rollback(k, sid, turnId)).toEqual({ ok: true, files: 3 })
    expect(readFileSync(R('a.txt'), 'utf8')).toBe('a v1\n')
    expect(readFileSync(R('exec.sh'), 'utf8')).toBe('#!/bin/sh\necho hi\n')
    expect(statSync(R('exec.sh')).mode & 0o111).not.toBe(0)
    expect(existsSync(R('new.txt'))).toBe(false)
    expect(readFileSync(R('later.txt'), 'utf8')).toBe('later\n')
    expect(readFileSync(R('b.txt'), 'utf8')).toBe('b by user\n')
    const pre = `refs/mffai/snapshots/${sid}/${turnId}-pre-rollback`
    expect(hidden()).toContain(pre)
    expect(ug(['show', `${pre}:later.txt`])).toBe('later\n') // 回滚本身可找回
    expect(evs(k, sid).filter(e => e.type === 'turn.rolledBack').map(e => pay(e))).toEqual([{ turnId, files: 3 }])

    await expect(rollback(k, sid, turnId)).rejects.toMatchObject({ code: -32602 })
    expect(evs(k, sid).filter(e => e.type === 'turn.rolledBack')).toHaveLength(1)
    expect(readdirSync(snapTmp)).toEqual([])
  })

  it('only the latest turn is rollbackable; after rolling back turn 2, turn 1 is; the rolled-back turn leaves the history', async () => {
    initRepo()
    const calls: Message[][] = []
    let script: Script = oneTool('write', { path: 'one.txt', content: '1\n' })
    const k = await boot(calls, () => script)
    const sid = await create(k, CLAUDE)
    const t1 = await turn(k, sid, 'first turn')
    script = oneTool('write', { path: 'two.txt', content: '2\n' })
    const t2 = await turn(k, sid, 'second turn')

    await expect(rollback(k, sid, t1)).rejects.toMatchObject({ code: -32602 })
    await expect(rollback(k, sid, 'no-such-turn')).rejects.toMatchObject({ code: -32602 })
    expect(existsSync(R('one.txt'))).toBe(true)

    expect(await rollback(k, sid, t2)).toEqual({ ok: true, files: 1 })
    expect(existsSync(R('two.txt'))).toBe(false)
    expect(existsSync(R('one.txt'))).toBe(true)

    // 下一轮的历史里没有被回滚的第 2 轮
    script = () => say('ok')
    const before = calls.length
    await turn(k, sid, 'third turn')
    const sent = JSON.stringify(calls[before])
    expect(sent).toContain('first turn')
    expect(sent).not.toContain('second turn')
    expect(sent).not.toContain('two.txt')

    // 第 3 轮没改文件也跑了快照:它才是最新的,第 1 轮要等它回滚之后
    await expect(rollback(k, sid, t1)).rejects.toMatchObject({ code: -32602 })
    const t3 = evs(k, sid).filter(e => e.type === 'message.user').map(e => pay<{ turnId: string }>(e).turnId).at(-1)!
    expect(await rollback(k, sid, t3)).toEqual({ ok: true, files: 0 })
    expect(await rollback(k, sid, t1)).toEqual({ ok: true, files: 1 })
    expect(existsSync(R('one.txt'))).toBe(false)
  })

  it('rollback while a turn is active → ERR_BUSY', async () => {
    initRepo()
    const calls: Message[][] = []
    let release!: () => void
    const gate = new Promise<void>(r => (release = r))
    let script: Script = oneTool('write', { path: 'one.txt', content: '1\n' })
    const k = await boot(calls, () => script)
    const sid = await create(k, CLAUDE)
    const t1 = await turn(k, sid, 'first')
    script = () => (async function* () {
      await gate
      yield* say('later')
    })()
    const t2 = await prompt(k, sid, 'second')
    await waitFor(() => calls.length === 3)
    await expect(rollback(k, sid, t1)).rejects.toMatchObject({ code: ERR_BUSY })
    await expect(rollback(k, sid, t2)).rejects.toMatchObject({ code: ERR_BUSY })
    release()
    await waitFor(() => snaps(k, sid, t2).some(p => p.phase === 'end'))
    expect(await rollback(k, sid, t2)).toEqual({ ok: true, files: 0 })
    expect(existsSync(R('one.txt'))).toBe(true)
  })

  it('rollback after the terminal event but before the end snapshot is written → ERR_BUSY', async () => {
    initRepo()
    const calls: Message[][] = []
    let hold: Promise<void> | undefined
    let release!: () => void
    // 第 2 轮的结束快照卡在 update-ref 上
    const k = await boot(calls, () => oneTool('write', { path: 'x.txt', content: 'x\n' }), real => (args, o) =>
      hold && args.includes('update-ref') && args.some(a => a.endsWith('-end')) ? hold.then(() => real(args, o)) : real(args, o))
    const sid = await create(k, CLAUDE)
    await turn(k, sid, 'first')
    hold = new Promise<void>(r => (release = r))
    const t2 = await prompt(k, sid, 'second')
    await waitFor(() => evs(k, sid).filter(e => e.type === 'turn.ended').length === 2)
    await expect(rollback(k, sid, t2)).rejects.toMatchObject({ code: ERR_BUSY })
    release()
    await waitFor(() => snaps(k, sid, t2).some(p => p.phase === 'end'))
    expect(await rollback(k, sid, t2)).toEqual({ ok: true, files: 0 })
  })

  it('turn.changes for a turn without both snapshots → -32602; unknown session → -32602', async () => {
    initRepo()
    const calls: Message[][] = []
    const k = await boot(calls, () => () => say('hi'))
    const sid = await create(k, CLAUDE)
    await expect(changesOf(k, sid, 'nope')).rejects.toMatchObject({ code: -32602 })
    await expect(changesOf(k, 'no-session', 'nope')).rejects.toMatchObject({ code: -32602 })
    await expect(rollback(k, 'no-session', 'nope')).rejects.toMatchObject({ code: -32602 })
  })
})

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
let holds: (() => void)[] = []

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'mffai-loopsnap-')))
  dataDir = join(root, 'data')
  home = join(root, 'home')
  repo = join(root, 'repo')
  snapTmp = join(root, 'snaptmp')
  for (const d of [dataDir, home, repo]) mkdirSync(d)
})
afterEach(async () => {
  for (const release of holds) release() // 断言失败时挂起的 git 也要放开,否则 close 等不完
  holds = []
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

/** 插件日志(只留消息):测试据此确认第 2 轮已在等回滚,不靠睡固定时长 */
let logs: string[] = []
const logger = { info: (m: string) => { logs.push(m) }, warn: (m: string) => { logs.push(m) }, error: (m: string) => { logs.push(m) } }
async function boot(calls: Message[][], script: () => Script, wrapGit?: (g: Git) => Git) {
  const g = createGit({ base: baseEnv(), extraEnv: gitInjected() })
  logs = []
  const k = await createKernel({
    dataDir,
    home,
    log: logger,
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
const terminalOf = (k: Kernel, sid: string, turnId: string) => evs(k, sid).filter(e => (e.type === 'turn.ended' || e.type === 'turn.failed') && pay(e).turnId === turnId)
/** 一轮跑完:终态写下(结束快照在它之前) */
async function turn(k: Kernel, sid: string, text: string) {
  const turnId = await prompt(k, sid, text)
  await waitFor(() => terminalOf(k, sid, turnId).length > 0)
  return turnId
}
/** 本轮的 pre-rollback 引用(带时间戳后缀),按名字排序 */
const preRefs = (sid: string, turnId: string) => hidden().filter(r => r.startsWith(`refs/mffai/snapshots/${sid}/${turnId}-pre-rollback-`)).sort()
/** 把满足条件的 git 调用挂起,直到 release();reached 表示已经挂住 */
function holdGit(match: (args: string[]) => boolean) {
  const h = { on: false, reached: false, release: () => {}, wrap: (real: Git): Git => (args, o) => {
    if (!h.on || !match(args)) return real(args, o)
    h.reached = true
    return gate.then(() => real(args, o))
  } }
  let gate = Promise.resolve()
  const arm = () => {
    h.on = true
    h.reached = false
    gate = new Promise<void>(r => (h.release = () => { h.on = false; r() }))
    holds.push(() => h.release())
  }
  return Object.assign(h, { arm })
}
const endUpdate = (args: string[]) => args.includes('update-ref') && args.some(a => a.endsWith('-end'))
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
    // 事件顺序:开始快照在第一次模型请求之前,结束快照在终态之前(客户端看到终态时快照已在)
    const types = evs(k, sid).map(e => e.type).filter(t => t !== 'message.assistant.delta' && t !== 'turn.usage')
    expect(types).toEqual(['session.created', 'message.user', 'turn.started', 'turn.snapshot', 'message.assistant', 'tool.started', 'tool.ended', 'message.assistant', 'turn.snapshot', 'turn.ended'])
    expect(await changesOf(k, sid, turnId)).toEqual({ files: [{ path: 'new.txt', status: 'A' }] }) // 终态之后立即可查
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
    expect(preRefs(sid, turnId)).toHaveLength(1)
    const pre = preRefs(sid, turnId)[0]
    expect(pre).toMatch(/-pre-rollback-\d+$/)
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

  it('while the end snapshot is being written there is no terminal event yet and rollback → ERR_BUSY', async () => {
    initRepo()
    const calls: Message[][] = []
    const hold = holdGit(endUpdate)
    const k = await boot(calls, () => oneTool('write', { path: 'x.txt', content: 'x\n' }), hold.wrap)
    const sid = await create(k, CLAUDE)
    const t1 = await turn(k, sid, 'first')
    hold.arm()
    const t2 = await prompt(k, sid, 'second')
    await waitFor(() => hold.reached)
    expect(terminalOf(k, sid, t2)).toEqual([])
    await expect(rollback(k, sid, t2)).rejects.toMatchObject({ code: ERR_BUSY })
    await expect(rollback(k, sid, t1)).rejects.toMatchObject({ code: ERR_BUSY })
    hold.release()
    await waitFor(() => terminalOf(k, sid, t2).length === 1)
    const order = evs(k, sid).filter(e => pay(e).turnId === t2).map(e => e.type)
    expect(order.slice(-2)).toEqual(['turn.snapshot', 'turn.ended'])
    expect(await rollback(k, sid, t2)).toEqual({ ok: true, files: 0 })
  })

  it('cancelled while the end snapshot hangs: the kernel writes cancelled after its grace, rollback stays ERR_BUSY until the snapshot lands', async () => {
    initRepo()
    const calls: Message[][] = []
    const hold = holdGit(endUpdate)
    const k = await boot(calls, () => oneTool('write', { path: 'x.txt', content: 'x\n' }), hold.wrap)
    const sid = await create(k, CLAUDE)
    hold.arm()
    const t1 = await prompt(k, sid, 'first')
    await waitFor(() => hold.reached)
    await k.handle('session.cancel', { commandId: 'cx', sessionId: sid }) // 内核等 1 s 宽限后写 cancelled
    expect(terminalOf(k, sid, t1).map(e => pay(e).reason)).toEqual(['cancelled'])
    await expect(rollback(k, sid, t1)).rejects.toMatchObject({ code: ERR_BUSY })
    hold.release()
    await waitFor(() => snaps(k, sid, t1).some(p => p.phase === 'end'))
    await expect.poll(async () => rollback(k, sid, t1).then(r => r, e => (e as { code: number }).code), { timeout: 5_000 }).toEqual({ ok: true, files: 1 })
    expect(terminalOf(k, sid, t1)).toHaveLength(1) // 循环的终态被内核丢弃,只有 cancelled
  })

  it('two concurrent rollbacks of the same turn: one succeeds, the other → -32602', async () => {
    initRepo()
    const calls: Message[][] = []
    const k = await boot(calls, () => oneTool('write', { path: 'one.txt', content: '1\n' }))
    const sid = await create(k, CLAUDE)
    const t1 = await turn(k, sid, 'first')
    const rs = await Promise.allSettled([rollback(k, sid, t1), rollback(k, sid, t1)])
    expect(rs.filter(r => r.status === 'fulfilled').map(r => (r as PromiseFulfilledResult<unknown>).value)).toEqual([{ ok: true, files: 1 }])
    expect(rs.filter(r => r.status === 'rejected').map(r => ((r as PromiseRejectedResult).reason as { code: number }).code)).toEqual([-32602])
    expect(evs(k, sid).filter(e => e.type === 'turn.rolledBack')).toHaveLength(1)
    expect(preRefs(sid, t1)).toHaveLength(1)
  })

  it('a prompt that arrives during a rollback waits for it: its start snapshot comes after turn.rolledBack and its history skips the rolled-back turn', async () => {
    initRepo()
    const calls: Message[][] = []
    const hold = holdGit(args => args.includes('--raw')) // 回滚里查子模块的 diff
    let script: Script = oneTool('write', { path: 'one.txt', content: '1\n' })
    const k = await boot(calls, () => script, hold.wrap)
    const sid = await create(k, CLAUDE)
    const t1 = await turn(k, sid, 'first turn')
    hold.arm()
    const rb = rollback(k, sid, t1)
    await waitFor(() => hold.reached)
    script = () => say('ok')
    const t2 = await prompt(k, sid, 'second turn')
    await waitFor(() => logs.some(m => m.endsWith('turn waits for a rollback')))
    expect(snaps(k, sid, t2)).toEqual([]) // 第 2 轮已开始,但在等回滚
    hold.release()
    expect(await rb).toEqual({ ok: true, files: 1 })
    // 等事件而不是睡固定时长:开始快照落下之后再比顺序
    await waitFor(() => snaps(k, sid, t2).some(p => p.phase === 'start'))
    const seqOf = (pred: (e: KernelEvent) => boolean) => evs(k, sid).find(pred)!.seq
    expect(seqOf(e => e.type === 'turn.snapshot' && pay(e).turnId === t2 && pay(e).phase === 'start')).toBeGreaterThan(seqOf(e => e.type === 'turn.rolledBack'))
    await waitFor(() => terminalOf(k, sid, t2).length === 1)
    expect(JSON.stringify(calls.at(-1))).not.toContain('first turn')
    expect(existsSync(R('one.txt'))).toBe(false)
  })

  it.skipIf(!posix || process.getuid?.() === 0)('a failed restore can be retried, and the first pre-rollback ref still holds the user edits', async () => {
    initRepo()
    const calls: Message[][] = []
    const k = await boot(calls, () => oneTool('apply_patch', { patch: '*** Begin Patch\n*** Update File: a.txt\n@@\n-a v1\n+a by turn\n*** Add File: d/new.txt\n+new\n*** End Patch' }))
    const sid = await create(k, GPT)
    const t1 = await turn(k, sid, 'change')
    writeFileSync(R('a.txt'), 'a by user\n') // 轮之后用户又改了 a.txt
    chmodSync(R('d'), 0o555) // d/new.txt 删不掉
    try {
      await expect(rollback(k, sid, t1)).rejects.toMatchObject({ code: -32603 })
    } finally {
      chmodSync(R('d'), 0o755)
    }
    expect(evs(k, sid).some(e => e.type === 'turn.rolledBack')).toBe(false)
    expect(readFileSync(R('a.txt'), 'utf8')).toBe('a v1\n') // 其余文件已写回
    await sleep(2) // 时间戳后缀不同
    expect(await rollback(k, sid, t1)).toEqual({ ok: true, files: 2 })
    expect(existsSync(R('d/new.txt'))).toBe(false)
    const pres = preRefs(sid, t1)
    expect(pres).toHaveLength(2)
    expect(ug(['show', `${pres[0]}:a.txt`])).toBe('a by user\n') // 第一次的仍在,没被重试覆盖
  })

  it('a turn that adds a submodule: rollback skips and reports it, restores the rest', async () => {
    initRepo()
    const calls: Message[][] = []
    const k = await boot(calls, () => n => {
      if (n === 1) {
        // 本轮里出现一个嵌套仓库(add -A 记成 gitlink)
        mkdirSync(R('sub'))
        ug(['init', '-q', '-b', 'main'], R('sub'))
        writeFileSync(join(R('sub'), 'f.txt'), 'f\n')
        ug(['add', '.'], R('sub'))
        ug(['-c', 'user.name=u', '-c', 'user.email=u@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-q', '-m', 's'], R('sub'))
        return calling('c1', 'write', { path: 'new.txt', content: 'n\n' })
      }
      return say('done')
    })
    const sid = await create(k, CLAUDE)
    const t1 = await turn(k, sid, 'go')
    expect(await changesOf(k, sid, t1)).toEqual({ files: [{ path: 'new.txt', status: 'A' }, { path: 'sub', status: 'A' }] })
    expect(await rollback(k, sid, t1)).toEqual({ ok: true, files: 1, skipped: ['sub'] })
    expect(existsSync(R('new.txt'))).toBe(false)
    expect(readFileSync(join(R('sub'), 'f.txt'), 'utf8')).toBe('f\n')
    expect(evs(k, sid).filter(e => e.type === 'turn.rolledBack').map(e => pay(e))).toEqual([{ turnId: t1, files: 1, skipped: ['sub'] }])
  })

  it('a git failure after the eligibility check → -32603, not -32602', async () => {
    initRepo()
    const calls: Message[][] = []
    const hold = { on: false }
    const k = await boot(calls, () => oneTool('write', { path: 'one.txt', content: '1\n' }), real => (args, o) =>
      hold.on && args.includes('diff') ? Promise.resolve({ code: 128, stdout: Buffer.alloc(0), stderr: 'fatal: boom' }) : real(args, o))
    const sid = await create(k, CLAUDE)
    const t1 = await turn(k, sid, 'first')
    hold.on = true
    await expect(changesOf(k, sid, t1)).rejects.toMatchObject({ code: -32603 })
    await expect(rollback(k, sid, t1)).rejects.toMatchObject({ code: -32603 })
    expect(existsSync(R('one.txt'))).toBe(true)
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

import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createKernel, type Kernel } from '../../kernel/kernel'
import type { Plugin } from '../../kernel/pluginHost'
import { CLOSE_GRACE_MS, KILL_LIVE_MS } from '../../kernel/shutdown'
import type { ModelEvent } from '../../lib/models/types'
import type { KernelEvent } from '../../protocol/index'
import { isAlive, waitDead } from '../../../test/fakeCli'
import { NO_SANDBOX } from '../../../test/sandboxStub'
import { CODEX_OK, REF, boot, create, cwd, dataDir, delegate, detected, done, evs, execCalls, fake, home, isolatedGit, kernels, list, ofType, pay, prompt, root, say, sh, sleep, turn, untilGo, waitFor, useRig } from '../../../test/executorRig'

useRig()

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
    kernels.length = 0
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
    kernels.length = 0
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
    kernels.length = 0
    release()
    expect(ended).toHaveLength(1)
    expect(ended[0]).toMatchObject({ status: 'interrupted', reason: 'kernel_stopping' })
    // SIGINT 先到:forwarding 自己收掉自成一会话的子进程。killLive 的 SIGTERM 打头的话它活下来
    expect(await waitDead(child, 500)).toBe(true)
  })

  it('executor.changes before a close is not what it answers afterwards', async () => {
    const f = fake({ forwarding: true, writeFiles: { 'first.txt': '1\n' } })
    const { k } = await boot(f, { script: n => (n === 1 ? delegate() : say('wait')) })
    await detected(k)
    const sid = await create(k)
    await prompt(k, sid)
    await waitFor(() => existsSync(join(cwd, 'first.txt')))
    const { runId } = pay<{ runId: string }>(ofType(k, sid, 'executor.run.queued')[0])
    const paths = async (kernel: Kernel) => ((await kernel.handle('executor.changes', { sessionId: sid, runId })) as { files: { path: string }[] }).files.map(x => x.path).sort()
    expect(await paths(k)).toEqual(['first.txt'])
    await k.close()
    kernels.length = 0
    writeFileSync(join(cwd, 'second.txt'), '2\n') // 进程收尾前写的,这次运行的结束快照没拍到
    const { k: next } = await boot(f)
    await detected(next)
    expect(await paths(next)).toEqual(expect.arrayContaining(['first.txt', 'second.txt']))
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
    kernels.length = 0
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

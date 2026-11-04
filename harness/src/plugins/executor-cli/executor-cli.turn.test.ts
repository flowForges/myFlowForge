import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createImWorktree } from '../../lib/git/imWorktree'
import type { Tool } from '../../lib/tools/types'
import { ERR_BUSY, ERR_DRAINING } from '../../protocol/index'
import { installFake, isAlive, waitDead } from '../../../test/fakeCli'
import { CODEX_OK, FINISH, boot, calling, create, cwd, dataDir, delegate, detected, done, evs, execCalls, fake, home, infoOf, isolatedGit, kernels, lastText, list, ofType, pay, prompt, root, say, sh, sleep, terminal, turn, untilGo, waitFor, type Info, useRig } from '../../../test/executorRig'
import { createExecutorCli } from './index'

useRig()

describe('an IM session in its own worktree (07 spec §8)', () => {
  /** 用户的工作区、索引、HEAD、分支和别的引用;refs/mffai 是我们自己的 */
  const userState = () => [sh('status', '--porcelain'), sh('rev-parse', 'HEAD'), sh('for-each-ref', '--format=%(refname) %(objectname)').split('\n').filter(l => !l.startsWith('refs/mffai/')).join('\n'), readFileSync(join(cwd, '.git', 'index')).toString('hex')]
  const imWorktree = async () => {
    const tmpDir = join(dataDir, 'tmp')
    mkdirSync(tmpDir, { recursive: true })
    const r = await createImWorktree({ dataDir, project: cwd, group: 'c1', id: 'wt_1', git: isolatedGit(), tmpDir, untrusted: [dataDir], denyReadOf: () => [] })
    if (!r.ok) throw new Error(r.error)
    return r.cwd
  }

  it('the session pins the linked worktree', async () => {
    const dir = await imWorktree()
    const { k } = await boot(undefined)
    const sid = await create(k, { origin: 'im', dir })
    expect(pay(evs(k, sid).find(e => e.type === 'session.created')).repo).toMatchObject({ kind: 'repo', top: dir, commonDir: join(cwd, '.git') })
  })

  it('a delegate write: in place, no -worktrees entry, turn.changes and turn.rollback cover it, the project is untouched', async () => {
    const dir = await imWorktree()
    const before = userState()
    const f = fake({ lines: CODEX_OK, writeFiles: { 'a.txt': 'changed\n', 'new.txt': 'new\n' } })
    const { k } = await boot(f, { script: n => (n === 1 ? delegate() : n === 2 ? say('started it') : say('summary')) })
    await detected(k)
    const sid = await create(k, { origin: 'im', dir })
    const turnId = await turn(k, sid)
    const end = pay(ofType(k, sid, 'executor.run.ended')[0])
    expect(end).toMatchObject({ status: 'ok' })
    expect(pay(ofType(k, sid, 'executor.run.queued')[0]).isolation).toBe('own')
    expect(end.worktree).toBeUndefined()
    expect(execCalls(f)[0].cwd).toBe(dir)
    expect(existsSync(`${dataDir}-worktrees`)).toBe(false)
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('changed\n')
    expect(userState()).toEqual(before)
    const changes = (await k.handle('turn.changes', { sessionId: sid, turnId })) as { files: { path: string }[] }
    expect(changes.files.map(x => x.path).sort()).toEqual(['a.txt', 'new.txt'])
    expect(await k.handle('turn.rollback', { commandId: 'rb', sessionId: sid, turnId })).toMatchObject({ ok: true })
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('a\n')
    expect(existsSync(join(dir, 'new.txt'))).toBe(false)
    expect(userState()).toEqual(before)
  })

  it('the session\'s own write tool: a turn and a rollback work in the worktree, the project is untouched', async () => {
    const dir = await imWorktree()
    const before = userState()
    const { k } = await boot(undefined, { script: n => (n === 1 ? calling('c1', 'write', { path: 'n.txt', content: 'n\n' }) : say('done')) })
    const sid = await create(k, { origin: 'im', dir, approvalMode: 'ask' })
    const turnId = await turn(k, sid)
    expect(terminal(k, sid)[0].type).toBe('turn.ended')
    expect(readFileSync(join(dir, 'n.txt'), 'utf8')).toBe('n\n')
    expect(existsSync(join(cwd, 'n.txt'))).toBe(false)
    expect(await k.handle('turn.rollback', { commandId: 'rb', sessionId: sid, turnId })).toMatchObject({ ok: true })
    expect(existsSync(join(dir, 'n.txt'))).toBe(false)
    expect(userState()).toEqual(before)
  })

  it.each([
    ['partial', { detect: () => ({ level: 'partial', missing: ['netns'] }), upstream: null }, false],
    ['none', { detect: () => ({ level: 'none', missing: ['sandbox-exec'] }), upstream: null }, true],
  ] as const)('auto at %s: a delegate waits for a person, even with allowUnsandboxedAuto', async (_level, sandbox, flag) => {
    const dir = await imWorktree()
    const f = fake()
    const { k } = await boot(f, { sandbox: sandbox as never, allowUnsandboxedAuto: flag, script: () => delegate() })
    await detected(k)
    const sid = await create(k, { origin: 'im', dir })
    await prompt(k, sid)
    await waitFor(() => ofType(k, sid, 'approval.requested').length === 1)
    expect(execCalls(f)).toEqual([])
    await k.handle('session.cancel', { commandId: 'x', sessionId: sid })
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

  it('an acp session writes in place like app: its new origin changes memory, not delegation', async () => {
    const f = fake({ lines: CODEX_OK, writeFiles: { 'a.txt': 'changed\n' } })
    const { k } = await boot(f, { script: n => (n === 1 ? delegate() : say('done')) })
    await detected(k)
    const sid = await create(k, { origin: 'acp' })
    await turn(k, sid)
    const end = pay<{ status: string; worktree?: string }>(ofType(k, sid, 'executor.run.ended')[0])
    expect(end.status).toBe('ok')
    expect(end.worktree).toBeUndefined()
    expect(execCalls(f)[0].cwd).toBe(realpathSync.native(cwd))
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

describe('cancel', () => {
  it('session.cancel on a parked turn: the run dies by SIGINT, its notice stays in the log, both snapshots are there', async () => {
    const f = fake({ forwarding: true })
    const { k } = await boot(f, { script: n => (n === 1 ? delegate() : say('wait')) })
    await detected(k)
    const sid = await create(k)
    await prompt(k, sid)
    await waitFor(() => ofType(k, sid, 'turn.parked').length === 1)
    const child = await f.waitPid('child')
    await k.handle('session.cancel', { commandId: 'x', sessionId: sid })
    expect(await waitDead(child, 3000)).toBe(true)
    await waitFor(() => ofType(k, sid, 'executor.notice').length === 1 && terminal(k, sid).length === 1)
    expect(pay(ofType(k, sid, 'executor.run.ended')[0])).toMatchObject({ status: 'cancelled', reason: 'cancelled' })
    expect(pay(terminal(k, sid)[0]).reason).toBe('cancelled')
    // 先后不断言:CLI 1 s 内没退干净时内核先写终态(评审修订 B3),负载高时就会这样
    await waitFor(() => ofType(k, sid, 'turn.snapshot').length === 2)
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

  it('executor.changes during a run sees each new write, and after a normal end the finish snapshot stands', async () => {
    const [go1, go2, wrote] = [join(root, 'go1'), join(root, 'go2'), join(root, 'wrote')]
    const f = fake({ run: `echo 1 > first.txt; while [ ! -e '${go1}' ]; do sleep 0.02; done; echo 2 > second.txt; touch '${wrote}'; while [ ! -e '${go2}' ]; do sleep 0.02; done; printf '%s\\n' '${FINISH}'` })
    const { k } = await boot(f, { script: n => (n === 1 ? delegate() : say('done')) })
    await detected(k)
    const sid = await create(k)
    await prompt(k, sid)
    await waitFor(() => ofType(k, sid, 'executor.run.started').length === 1 && existsSync(join(cwd, 'first.txt')))
    const { runId } = pay<{ runId: string }>(ofType(k, sid, 'executor.run.queued')[0])
    const paths = async () => ((await k.handle('executor.changes', { sessionId: sid, runId })) as { files: { path: string }[] }).files.map(x => x.path).sort()
    expect(await paths()).toEqual(['first.txt'])
    writeFileSync(go1, '')
    await waitFor(() => existsSync(wrote))
    expect(await paths()).toEqual(['first.txt', 'second.txt'])
    writeFileSync(go2, '')
    await waitFor(() => terminal(k, sid).length === 1)
    writeFileSync(join(cwd, 'later.txt'), 'not this run\n')
    expect(await paths()).toEqual(['first.txt', 'second.txt'])
  })

  it('draining: executor.cancel still works, other plugin commands do not', async () => {
    const f = fake({ forwarding: true })
    const { k } = await boot(f, { script: n => (n === 1 ? delegate() : say('done')) })
    await detected(k)
    const sid = await create(k)
    await prompt(k, sid)
    await waitFor(() => ofType(k, sid, 'turn.parked').length === 1)
    await waitFor(() => ofType(k, sid, 'executor.run.started').length === 1)
    const { runId } = pay<{ runId: string }>(ofType(k, sid, 'executor.run.queued')[0])
    const drained = k.drain(30_000)
    await expect(k.handle('executor.worktree.discard', { commandId: 'd', sessionId: sid, runId })).rejects.toMatchObject({ code: ERR_DRAINING })
    expect(await k.handle('executor.cancel', { commandId: 'x', sessionId: sid, runId })).toEqual({ ok: true })
    await drained
    expect(pay(ofType(k, sid, 'executor.run.ended')[0])).toMatchObject({ status: 'cancelled' })
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

  it('a change takes a restart, and the restart sees it, in both directions', async () => {
    const f = installFake({ lines: CODEX_OK })
    const first = await boot(f)
    await detected(first.k)
    expect(await infoOf(first.k)).toMatchObject({ isolation: 'own', missing: [] })
    await first.k.close()
    kernels.length = 0
    const on = await boot(f, { executors: { codex: { network: true } } })
    await detected(on.k)
    expect(await infoOf(on.k)).toMatchObject({ isolation: 'none', missing: ['codex_network'] })
    await on.k.close()
    kernels.length = 0
    const off = await boot(f)
    await detected(off.k)
    expect(await infoOf(off.k)).toMatchObject({ isolation: 'own', missing: [] })
  })
})

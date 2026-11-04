import { beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { installFake } from '../../../test/fakeCli'
import { NO_SANDBOX } from '../../../test/sandboxStub'
import { BUILTIN_PLUGINS } from '../index'
import { CODEX_OK, approval, bins, boot, create, cwd, delegate, detected, done, execCalls, fake, infoOf, kernels, lastText, list, noRepo, ofType, pay, prompt, respond, root, say, sleep, terminal, toolResult, turn, untilGo, waitFor, type Info, type Script, useRig } from '../../../test/executorRig'
import { manifestFor, type ExecutorCliOpts } from './index'
import { parseExecutorsConfig } from './runs'

useRig()

describe('registration and detection', () => {
  beforeEach(noRepo)

  it('manifest: injects what it uses, pgids only on posix', () => {
    expect(manifestFor('darwin')).toMatchObject({ id: 'executor-cli', provides: ['executors'], inject: ['tools', 'sessions', 'sandbox', 'permissionGate', 'pgids'] })
    expect(manifestFor('win32').inject).toEqual(['tools', 'sessions', 'sandbox', 'permissionGate'])
  })

  it('in the builtin list between tools-coding and loop-default', () => {
    const ids = BUILTIN_PLUGINS.map(p => p.manifest.id)
    expect(ids.indexOf('executor-cli')).toBe(ids.indexOf('tools-coding') + 1)
    expect(ids.indexOf('loop-default')).toBeGreaterThan(ids.indexOf('executor-cli'))
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

  it('all disabled: not even the login shell runs', async () => {
    let logins = 0
    const { k } = await boot(undefined, { executors: { disabled: ['codex', 'qoder'] }, plugin: { loginPath: async () => { logins++; return '' } } })
    await detected(k)
    expect(logins).toBe(0)
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
    kernels.length = 0
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
  beforeEach(noRepo)

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
    kernels.length = 0

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

describe('violations', () => {
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
})

describe('a changed binary', () => {
  beforeEach(noRepo)

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
    for (let i = 0; i < 500 && f.calls().filter(c => c.argv[0] === 'sandbox').length < 6; i++) await sleep(10)
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
  beforeEach(noRepo)

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

describe('dequeue', () => {
  beforeEach(noRepo)

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

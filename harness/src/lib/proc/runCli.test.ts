import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanupFakes, installFake, isAlive, trackPid, waitDead, type FakeCli } from '../../../test/fakeCli'
import { runCli, type CliOpts } from './runCli'

const posix = process.platform === 'linux' || process.platform === 'darwin'

let cwd: string
beforeEach(() => {
  cwd = realpathSync(mkdtempSync(join(tmpdir(), 'mffai-runcli-')))
})
afterEach(() => {
  cleanupFakes()
  rmSync(cwd, { recursive: true, force: true })
})

const env = () => ({ PATH: process.env.PATH, HOME: cwd })

function collect() {
  const lines: string[] = []
  const stderr: string[] = []
  const dropped: number[] = []
  return { lines, stderr, dropped, cb: { onLine: (l: string) => lines.push(l), onStderrLine: (l: string) => stderr.push(l), onDroppedLine: (n: number) => dropped.push(n) } }
}

const opts = (over: Partial<CliOpts> = {}): CliOpts => ({
  cwd,
  timeoutMs: 30_000,
  idleMs: 30_000,
  signal: new AbortController().signal,
  onLine() {},
  onSpawn: trackPid,
  ...over,
})

function planOf(file: string, args: string[] = []) {
  const plan = { file, args, env: env(), released: 0, release() { plan.released++ } }
  return plan
}
const sh = (script: string) => planOf('/bin/sh', ['-c', script])
const fakePlan = (f: FakeCli, args: string[] = []) => planOf(f.file, args)

describe.skipIf(!posix)('runCli', () => {
  it('spawns detached without a shell: exit code passes through, release runs once, onSpawn and onClose fire', async () => {
    const plan = sh('exit 7')
    const seen: string[] = []
    const r = await runCli(plan, opts({ onSpawn: pid => { trackPid(pid); seen.push(`spawn ${pid > 0}`) }, onClose: pid => seen.push(`close ${pid > 0}`) }))
    expect(r).toMatchObject({ code: 7, signal: null, timedOut: false, stalled: false, cancelled: false })
    expect(r.spawnError).toBeUndefined()
    expect(plan.released).toBe(1)
    expect(seen).toEqual(['spawn true', 'close true'])
  })

  it('metacharacters in args are data: there is no shell', async () => {
    const c = collect()
    await runCli(planOf('/bin/echo', ['$(touch pwned); `touch pwned2`']), opts(c.cb))
    expect(c.lines).toEqual(['$(touch pwned); `touch pwned2`'])
    expect(existsSync(join(cwd, 'pwned'))).toBe(false)
  })

  it('a leader killed by a signal reports that signal', async () => {
    const r = await runCli(sh('kill -KILL $$'), opts())
    expect(r).toMatchObject({ code: null, signal: 'SIGKILL' })
  })

  it('runs in cwd with exactly the plan env', async () => {
    const c = collect()
    const plan = planOf('/bin/sh', ['-c', 'pwd; echo "$MARK"; echo "${LEAK-none}"'])
    plan.env = { PATH: process.env.PATH, HOME: cwd, MARK: 'm' } as never
    process.env.LEAK = 'x'
    try {
      await runCli(plan, opts(c.cb))
    } finally {
      delete process.env.LEAK
    }
    expect(c.lines).toEqual([cwd, 'm', 'none'])
  })

  it('stdin arrives whole and is closed', async () => {
    const fake = installFake({})
    const stdin = '汉字-'.repeat(20_000) + '--dangerously-bypass-approvals-and-sandbox'
    const r = await runCli(fakePlan(fake, ['exec', '-']), opts({ stdin }))
    expect(r.code).toBe(0)
    const call = fake.calls()[0]
    expect(call.stdin).toBe(stdin)
    expect(call.argv).toEqual(['exec', '-'])
  })

  it('no stdin option → the child sees EOF at once', async () => {
    const r = await runCli(sh('cat; exit 3'), opts({ timeoutMs: 5000 }))
    expect(r).toMatchObject({ code: 3, timedOut: false })
  })

  it('EPIPE on stdin is ignored', async () => {
    const r = await runCli(sh('exec 0<&-; exit 4'), opts({ stdin: 'x'.repeat(5 * 1024 * 1024) }))
    expect(r.code).toBe(4)
  })

  it('stdout is delivered by whole line across chunk splits, UTF-8 intact, last line without newline too', async () => {
    const c = collect()
    const r = await runCli(sh(`printf '汉'; sleep 0.1; printf '字\\nsecond\\r\\n'; sleep 0.1; printf 'tail'`), opts(c.cb))
    expect(r.code).toBe(0)
    expect(c.lines).toEqual(['汉字', 'second', 'tail'])
  })

  it('stderr is delivered by line, separately', async () => {
    const c = collect()
    await runCli(sh('echo out; echo err1 >&2; printf err2 >&2'), opts(c.cb))
    expect(c.lines).toEqual(['out'])
    expect(c.stderr).toEqual(['err1', 'err2'])
  })

  it('a line over maxLine is not passed on; only onDroppedLine fires with its byte count, and later lines still arrive', async () => {
    const c = collect()
    const r = await runCli(sh(`echo before; head -c 5000 /dev/zero | tr '\\0' x; echo; echo after; head -c 3000 /dev/zero | tr '\\0' y`), opts({ ...c.cb, maxLine: 1000 }))
    expect(r.code).toBe(0)
    expect(c.lines).toEqual(['before', 'after'])
    expect(c.dropped).toEqual([5000, 3000])
  })

  it('exactly maxLine bytes is kept', async () => {
    const c = collect()
    await runCli(sh(`head -c 1000 /dev/zero | tr '\\0' x; echo`), opts({ ...c.cb, maxLine: 1000 }))
    expect(c.lines).toEqual(['x'.repeat(1000)])
    expect(c.dropped).toEqual([])
  })

  it('an over-long stderr line is dropped the same way', async () => {
    const c = collect()
    await runCli(sh(`head -c 5000 /dev/zero | tr '\\0' x >&2; echo >&2; echo ok >&2`), opts({ ...c.cb, maxLine: 1000 }))
    expect(c.stderr).toEqual(['ok'])
    expect(c.dropped).toEqual([5000])
  })

  it('a throwing callback does not break the run', async () => {
    const plan = sh('echo a; echo b >&2; exit 2')
    const r = await runCli(plan, opts({ onLine: () => { throw new Error('x') }, onStderrLine: () => { throw new Error('y') }, onClose: () => { throw new Error('z') } }))
    expect(r.code).toBe(2)
    expect(plan.released).toBe(1)
  })

  it('a throwing release does not lose the result', async () => {
    const plan = sh('exit 0')
    plan.release = () => { throw new Error('x') }
    expect((await runCli(plan, opts())).code).toBe(0)
  })

  it('a flood finishes with no line lost', async () => {
    const fake = installFake({ flood: 50_000 })
    let n = 0
    const r = await runCli(fakePlan(fake), opts({ onLine: () => void n++ }))
    expect(r.code).toBe(0)
    expect(n).toBe(50_000)
  }, 30_000)

  it('pre-aborted signal: never spawns, still releases', async () => {
    const ac = new AbortController()
    ac.abort()
    const plan = sh(`touch ${join(cwd, 'ran')}`)
    let spawned = false
    const r = await runCli(plan, opts({ signal: ac.signal, onSpawn: () => { spawned = true } }))
    expect(r).toEqual({ code: null, signal: null, timedOut: false, stalled: false, cancelled: true })
    expect(spawned).toBe(false)
    expect(plan.released).toBe(1)
    expect(existsSync(join(cwd, 'ran'))).toBe(false)
  })

  it('ENOENT gives spawnError with no throw, and releases once', async () => {
    const plan = planOf(join(cwd, 'nope'))
    const closes: number[] = []
    const r = await runCli(plan, opts({ onClose: pid => closes.push(pid) }))
    expect(r.spawnError).toMatch(/ENOENT/)
    expect(r).toMatchObject({ code: null, signal: null, cancelled: false })
    expect(plan.released).toBe(1)
    expect(closes).toEqual([])
  })

  it('a bad cwd gives spawnError too', async () => {
    const r = await runCli(sh('exit 0'), opts({ cwd: join(cwd, 'missing'), stdin: 'x' }))
    expect(r.spawnError).toBeTruthy()
  })

  it('a synchronous spawn failure gives spawnError with no throw', async () => {
    const plan = planOf('/bin/echo', ['a\0b'])
    const r = await runCli(plan, opts())
    expect(r.spawnError).toBeTruthy()
    expect(plan.released).toBe(1)
  })

  it('M-2: spawnError never quotes env values, args or the message from Node', async () => {
    const plan = planOf('/bin/echo', ['ARG-SECRET\0x'])
    plan.env = { PATH: process.env.PATH, HTTPS_PROXY: 'http://u:ENV-SECRET\0x@h' } as never
    const r = await runCli(plan, opts())
    expect(r.spawnError).toBeTruthy()
    expect(r.spawnError).not.toMatch(/SECRET/)
    const plan2 = planOf(join(cwd, 'ARG-SECRET-nope'), ['ARG-SECRET'])
    const r2 = await runCli(plan2, opts())
    expect(r2.spawnError).toBe('spawn failed: ENOENT')
  })

  it('timeout gives timedOut and kills the process', async () => {
    let pid = 0
    const t0 = Date.now()
    const r = await runCli(sh('sleep 60'), opts({ timeoutMs: 300, onSpawn: p => { trackPid(p); pid = p } }))
    expect(r).toMatchObject({ timedOut: true, stalled: false, cancelled: false })
    expect(Date.now() - t0).toBeLessThan(4000)
    expect(isAlive(pid)).toBe(false)
  })

  it('no output for idleMs gives stalled', async () => {
    const r = await runCli(sh('sleep 60'), opts({ idleMs: 200 }))
    expect(r).toMatchObject({ stalled: true, timedOut: false, cancelled: false })
  })

  it('stdout output resets the idle timer', async () => {
    const c = collect()
    const r = await runCli(sh('for i in 1 2 3 4 5 6 7 8; do echo $i; sleep 0.25; done'), opts({ ...c.cb, idleMs: 1000 })) // 跑 2 s,超过 idleMs
    expect(r).toMatchObject({ code: 0, stalled: false })
    expect(c.lines).toHaveLength(8)
  })

  it('stderr output does not reset the idle timer', async () => {
    const r = await runCli(sh('while :; do echo x >&2; sleep 0.05; done'), opts({ idleMs: 300 }))
    expect(r.stalled).toBe(true)
  })

  it('the first cause wins: a later abort does not relabel a timeout', async () => {
    const ac = new AbortController()
    const p = runCli(sh(`trap '' INT TERM; while :; do sleep 0.1; done`), opts({ timeoutMs: 100, signal: ac.signal, fast: () => true }))
    setTimeout(() => ac.abort(), 400)
    expect(await p).toMatchObject({ timedOut: true, cancelled: false, stalled: false })
  })

  describe('cancel leaves no process behind (Review Focus 1)', () => {
    it('forwarding: cancel → the own-session child is dead within 3 s, the fake exited by its SIGINT handler', async () => {
      const fake = installFake({ forwarding: true })
      const ac = new AbortController()
      const plan = fakePlan(fake)
      const p = runCli(plan, opts({ signal: ac.signal }))
      const child = await fake.waitPid('child')
      const cli = await fake.waitPid('cli')
      const t0 = Date.now()
      ac.abort()
      const r = await p
      expect(Date.now() - t0).toBeLessThan(3000)
      expect(r).toMatchObject({ code: 130, signal: null, cancelled: true }) // 130 = 自己处理了 SIGINT:SIGTERM 是 143,SIGKILL 没有退出码
      expect(isAlive(child)).toBe(false)
      expect(isAlive(cli)).toBe(false)
      expect(plan.released).toBe(1)
    })

    it('stubborn: cancel → leader and own-session grandchild dead, onClose after the kill', async () => {
      const fake = installFake({ stubborn: true })
      const ac = new AbortController()
      const closedWhile: boolean[] = []
      let grandchildPid = 0
      const p = runCli(fakePlan(fake), opts({ signal: ac.signal, onClose: () => closedWhile.push(isAlive(grandchildPid)) }))
      grandchildPid = await fake.waitPid('grandchild')
      const cli = await fake.waitPid('cli')
      const t0 = Date.now()
      ac.abort()
      const r = await p
      expect(Date.now() - t0).toBeLessThan(5000 + 1000)
      expect(r).toMatchObject({ cancelled: true, signal: 'SIGKILL' })
      expect(await waitDead(grandchildPid, 500)).toBe(true)
      expect(isAlive(cli)).toBe(false)
      expect(closedWhile).toHaveLength(1)
    })

    it('stubborn with fast(): the 2.5 s ladder, read at kill time', async () => {
      const fake = installFake({ stubborn: true })
      const ac = new AbortController()
      let fast = false
      const p = runCli(fakePlan(fake), opts({ signal: ac.signal, fast: () => fast }))
      const grandchild = await fake.waitPid('grandchild')
      fast = true
      const t0 = Date.now()
      ac.abort()
      await p
      expect(Date.now() - t0).toBeLessThan(2500 + 1000)
      expect(await waitDead(grandchild, 500)).toBe(true)
    })

    it('cancel while stdin is still being read still ends the run', async () => {
      const ac = new AbortController()
      const p = runCli(sh('sleep 60'), opts({ signal: ac.signal, stdin: 'x'.repeat(4 * 1024 * 1024) }))
      setTimeout(() => ac.abort(), 200)
      expect(await p).toMatchObject({ cancelled: true })
    })
  })

  describe('a pipe held open does not hang it', () => {
    it('cancel with an escaped process (ppid 1, own session) holding stdout: resolves after the ladder', async () => {
      const fake = installFake({ forwarding: true, escape: true })
      const ac = new AbortController()
      const plan = fakePlan(fake)
      const p = runCli(plan, opts({ signal: ac.signal }))
      const escaped = await fake.waitPid('escaped')
      await fake.waitPid('child')
      const t0 = Date.now()
      ac.abort()
      const r = await p
      expect(Date.now() - t0).toBeLessThan(3000)
      expect(r).toMatchObject({ code: 130, cancelled: true, leftovers: 'kept' })
      expect(plan.released).toBe(1)
      expect(isAlive(escaped)).toBe(true) // 进程树找不到它(spec §16):只保证不挂住。清理靠 cleanupFakes
    })

    it('leader exits by itself with an escaped process holding stdout: resolves with the real exit code', async () => {
      const fake = installFake({ escape: true, exit: 5, lines: ['done'] })
      const c = collect()
      const r = await runCli(fakePlan(fake), opts(c.cb))
      expect(r).toMatchObject({ code: 5, timedOut: false, stalled: false, cancelled: false, leftovers: 'kept' })
      expect(c.lines).toContain('done')
      expect(isAlive(await fake.waitPid('escaped'))).toBe(true) // 还拿着管道、杀不到:如实报 kept
    })

    it('leader exits leaving a same-group process holding stdout: the ladder kills it, reported as killed', async () => {
      const pidFile = join(cwd, 'bg')
      const r = await runCli(sh(`sleep 60 & echo $! > ${pidFile}; exit 6`), opts())
      expect(r).toMatchObject({ code: 6, leftovers: 'killed' })
      expect(r.killFailed).toBeUndefined()
      const bg = Number(readFileSync(pidFile, 'utf8').trim())
      expect(await waitDead(bg, 1000)).toBe(true)
    })
  })

  describe('an abort during the drain, after the CLI already exited (M-4)', () => {
    it('says the CLI exited first, with its real exit code', async () => {
      const fake = installFake({ run: 'sleep 30 & exit 0' })
      const ac = new AbortController()
      const pids: number[] = []
      const done = runCli(fakePlan(fake), opts({ signal: ac.signal, onClose: pid => pids.push(pid) }))
      await fake.waitPid('cli')
      // 假 CLI 退出后,sleep 还拿着 stdout:drain 的 1 s 正在走。等到退出后再中止
      const cli = await fake.waitPid('cli')
      for (let i = 0; i < 200 && isAlive(cli); i++) await new Promise(res => setTimeout(res, 10))
      expect(isAlive(cli)).toBe(false)
      ac.abort()
      const r = await done
      expect(r).toMatchObject({ code: 0, cancelled: true, exitedFirst: true, leftovers: 'killed' })
    }, 15_000)

    it('a CLI still running when the abort lands has no exitedFirst, even if it then exits 0', async () => {
      const fake = installFake({ run: "trap 'exit 0' INT; while :; do sleep 0.05; done" })
      const ac = new AbortController()
      const done = runCli(fakePlan(fake), opts({ signal: ac.signal }))
      await fake.waitPid('cli')
      await new Promise(res => setTimeout(res, 200))
      ac.abort()
      const r = await done
      expect(r.cancelled).toBe(true)
      expect(r.exitedFirst).toBeUndefined()
    }, 15_000)
  })

  describe('a CLI that exits by itself leaves what let go of its pipes (I-1)', () => {
    it('a nohup server that closed the pipes stays alive, reported as kept, and the result is immediate', async () => {
      const fake = installFake({ background: true, exit: 0 })
      const closes: number[] = []
      const t0 = Date.now()
      const plan = fakePlan(fake)
      const r = await runCli(plan, opts({ onClose: pid => closes.push(pid) }))
      expect(Date.now() - t0).toBeLessThan(3000)
      expect(r).toMatchObject({ code: 0, cancelled: false, leftovers: 'kept' })
      expect(r.killFailed).toBeUndefined()
      expect(isAlive(await fake.waitPid('background'))).toBe(true)
      expect(closes).toHaveLength(1)
      expect(plan.released).toBe(1)
    })

    it('nothing left over → no leftovers field', async () => {
      expect((await runCli(sh('exit 0'), opts())).leftovers).toBeUndefined()
    })
  })

  describe('a kill that could not happen is not reported as cancelled (I-3)', () => {
    it('own group unknown: killFailed, not cancelled, process still alive, and it does not hang', async () => {
      const fake = installFake({ sleep: 60_000 })
      const ac = new AbortController()
      const plan = fakePlan(fake)
      const p = runCli(plan, opts({ signal: ac.signal, fast: () => true, procDeps: { ownPgid: () => undefined } }))
      const cli = await fake.waitPid('cli')
      ac.abort()
      const r = await p
      expect(r).toMatchObject({ cancelled: false, killFailed: true, leftovers: 'kept' })
      expect(isAlive(cli)).toBe(true)
      expect(plan.released).toBe(1)
    })

    it('a timeout that could not kill says both', async () => {
      const r = await runCli(sh('sleep 30'), opts({ timeoutMs: 50, fast: () => true, procDeps: { ownPgid: () => undefined } }))
      expect(r).toMatchObject({ timedOut: true, killFailed: true })
    })
  })

  it('leaves its abort listener off the signal once finished', async () => {
    const ac = new AbortController()
    let added = 0
    let removed = 0
    const add = ac.signal.addEventListener.bind(ac.signal)
    const remove = ac.signal.removeEventListener.bind(ac.signal)
    ac.signal.addEventListener = ((...a: Parameters<typeof add>) => { added++; add(...a) }) as typeof add
    ac.signal.removeEventListener = ((...a: Parameters<typeof remove>) => { removed++; remove(...a) }) as typeof remove
    await runCli(sh('exit 0'), opts({ signal: ac.signal }))
    expect(added).toBe(1)
    expect(removed).toBe(1)
  })
})

describe.skipIf(!posix)('fake-cli probes', () => {
  const output = async (fake: FakeCli, args: string[]) => {
    const c = collect()
    const r = await runCli(fakePlan(fake, args), opts(c.cb))
    return { code: r.code, out: c.lines.join('\n') }
  }

  it('answers --version, login status, status -o json', async () => {
    const fake = installFake({ version: 'codex-cli 0.154.0', loginStatus: 'Not logged in', loginExit: 1 })
    expect(await output(fake, ['--version'])).toEqual({ code: 0, out: 'codex-cli 0.154.0' })
    expect(await output(fake, ['login', 'status'])).toEqual({ code: 1, out: 'Not logged in' })
    expect(await output(fake, ['status', '-o', 'json'])).toEqual({ code: 1, out: 'Not logged in' })
    expect(fake.calls().map(c => c.argv[0])).toEqual(['--version', 'login', 'status'])
  })

  it('answers sandbox with one marker per row; fail:<row> flips that row', async () => {
    const pass = await output(installFake({ selftest: 'pass' }), ['sandbox', '-P', 'mffai'])
    expect(pass.out.split('\n')).toEqual(['secret_read r=1', 'cwd_write r=0', 'outside_write r=1', 'git_write r=1', 'tmp_write r=0', 'rule_write r=1', 'rule_read r=1', 'secret_dir_read r=1', 'net_connect r=1'])
    const bad = await output(installFake({ selftest: 'fail:outside_write' }), ['sandbox'])
    expect(bad.out).toContain('outside_write r=0')
    expect(bad.out).toContain('secret_read r=1')
  })

  it('writes and deletes files in cwd, prints lines and stderr, exits as told, logs env names but not unrelated values', async () => {
    writeFileSync(join(cwd, 'b.txt'), 'old')
    const fake = installFake({ writeFiles: { 'sub/a.txt': 'hi' }, deleteFiles: ['b.txt'], lines: ['l1'], stderr: ['e1'], exit: 9 })
    const c = collect()
    const plan = fakePlan(fake, ['exec'])
    plan.env = { ...env(), SECRET_VALUE: 'hunter2', HTTPS_PROXY: 'http://p:1' } as never
    const r = await runCli(plan, opts({ ...c.cb, stdin: 'prompt' }))
    expect(r.code).toBe(9)
    expect(c.lines).toEqual(['l1'])
    expect(c.stderr).toEqual(['e1'])
    expect(readFileSync(join(cwd, 'sub/a.txt'), 'utf8')).toBe('hi')
    expect(existsSync(join(cwd, 'b.txt'))).toBe(false)
    const call = fake.calls()[0]
    expect(call).toMatchObject({ stdin: 'prompt', cwd })
    expect(call.envNames).toContain('SECRET_VALUE')
    expect(call.env.HTTPS_PROXY).toBe('http://p:1')
    expect(JSON.stringify(call)).not.toContain('hunter2')
  })
})

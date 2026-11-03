import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, join, relative } from 'node:path'
import { cleanupFakes, installFake, isAlive, trackPid, waitDead, type FakeCli } from '../../../test/fakeCli'
import { codexAdapter } from './adapters/codex'
import { qoderAdapter } from './adapters/qoder'
import type { Adapter } from './adapters/types'
import { binaryDirs, binaryKey, binaryTrusted, detectExecutor, findBin, isolationOf, PROBE_TIMEOUT_MS, runProbe, runSelfTest, SELF_TEST_READ_ONLY_SCRIPT, SELF_TEST_SCRIPT, trustedPath, type DetectDeps, type ExecutorInfo } from './detect'
import { PgidRegistry, reapOrphans } from '../../lib/proc/pgids'

let base: string
let scratch: string
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'mffai-detect-')))
  scratch = join(base, 'scratch')
  mkdirSync(scratch)
})
afterEach(() => {
  cleanupFakes()
  rmSync(base, { recursive: true, force: true })
})

const envFor = (dir: string): NodeJS.ProcessEnv => ({
  PATH: `${dir}:/usr/bin:/bin`,
  HOME: base,
  GIT_CONFIG_GLOBAL: join(base, 'gitconfig'),
  GIT_CONFIG_NOSYSTEM: '1',
})

function depsFor(dir: string, over: Partial<DetectDeps> = {}): DetectDeps {
  return {
    env: envFor(dir),
    run: runProbe,
    sandboxLevel: () => 'full',
    platform: 'darwin',
    tmp: () => scratch,
    policy: () => ({ denyRead: [] }),
    config: () => ({}),
    ...over,
  }
}

const sandboxCalls = (f: FakeCli) => f.calls().filter(c => c.argv[0] === 'sandbox')
const refused = (port: number) =>
  new Promise<boolean>(res => {
    const c = connect(port, '127.0.0.1', () => {
      c.destroy()
      res(false)
    })
    c.on('error', () => res(true))
  })

describe.skipIf(process.platform === 'win32')('findBin', () => {
  it('finds the absolute path of an executable file', () => {
    const fake = installFake()
    expect(findBin('codex', { PATH: `/nonexistent:${fake.dir}` }, 'darwin')).toBe(fake.file)
  })

  it('ignores a cwd-relative PATH entry even when the file is there', () => {
    const fake = installFake()
    const rel = relative(process.cwd(), fake.dir)
    expect(existsSync(join(rel, 'codex'))).toBe(true)
    expect(findBin('codex', { PATH: rel }, 'darwin')).toBeUndefined()
    expect(findBin('codex', { PATH: `.${delimiter}${rel}${delimiter}` }, 'darwin')).toBeUndefined()
  })

  it('skips a file without the x bit and a directory, and keeps looking', () => {
    const noX = join(base, 'nox')
    const isDir = join(base, 'isdir')
    mkdirSync(noX)
    mkdirSync(join(isDir, 'codex'), { recursive: true })
    writeFileSync(join(noX, 'codex'), '#!/bin/sh\n')
    chmodSync(join(noX, 'codex'), 0o644)
    expect(findBin('codex', { PATH: `${noX}:${isDir}` }, 'darwin')).toBeUndefined()
    const fake = installFake()
    expect(findBin('codex', { PATH: `${noX}:${isDir}:${fake.dir}` }, 'darwin')).toBe(fake.file)
  })

  describe('binary trust', () => {
    const uid = process.getuid!()
    const dirAt = (name: string, mode = 0o755) => {
      const d = join(base, name)
      mkdirSync(d, { recursive: true })
      chmodSync(d, mode)
      return d
    }
    const script = (dir: string, name = 'codex', mode = 0o755) => {
      const f = join(dir, name)
      writeFileSync(f, '#!/bin/sh\necho "codex 1.0"\n')
      chmodSync(f, mode)
      return f
    }

    it('a world-writable PATH dir or file is skipped and the next entry wins', () => {
      const open = dirAt('open', 0o777)
      script(open)
      const worldFile = dirAt('worldfile')
      script(worldFile, 'codex', 0o777)
      const good = dirAt('good')
      const f = script(good)
      expect(findBin('codex', { PATH: `${open}:${worldFile}:${good}` }, 'darwin')).toBe(f)
    })

    it('group-writable is fine: Homebrew on Intel Macs', () => {
      const d = dirAt('brew', 0o775)
      expect(findBin('codex', { PATH: d }, 'darwin', {})).toBeUndefined()
      const f = script(d, 'codex', 0o775)
      expect(findBin('codex', { PATH: d }, 'darwin')).toBe(f)
    })

    it('something owned by another user is not trusted; root or the user is', () => {
      const f = script(dirAt('mine'))
      expect(binaryTrusted(f, join(base, 'mine'), { uid })).toBe(true)
      expect(binaryTrusted(f, join(base, 'mine'), { uid: uid + 1 })).toBe(false)
      expect(binaryTrusted('/bin/sh', '/bin', { uid })).toBe(true)
    })

    it('a world-writable directory between the file and the PATH entry fails', () => {
      const entry = dirAt('entry')
      const sub = dirAt('entry/sub', 0o777)
      const f = script(sub)
      symlinkSync(f, join(entry, 'codex'))
      expect(binaryTrusted(join(entry, 'codex'), entry, { uid })).toBe(false)
      chmodSync(sub, 0o755)
      expect(binaryTrusted(join(entry, 'codex'), entry, { uid })).toBe(true)
    })

    it('a trusted-looking link in a world-writable entry fails, and a link to a world-writable place fails', () => {
      const real = dirAt('real')
      const f = script(real)
      const open = dirAt('openentry', 0o777)
      symlinkSync(f, join(open, 'codex'))
      expect(binaryTrusted(join(open, 'codex'), open, { uid })).toBe(false)
      const planted = script(dirAt('planted', 0o777))
      const entry = dirAt('linkentry')
      symlinkSync(planted, join(entry, 'codex'))
      expect(binaryTrusted(join(entry, 'codex'), entry, { uid })).toBe(false)
    })

    it('anything inside the session cwd is skipped, by entry or by realpath', () => {
      const cwd = dirAt('session')
      const inCwd = dirAt('session/bin')
      script(inCwd)
      expect(findBin('codex', { PATH: inCwd }, 'darwin')).toBe(join(inCwd, 'codex'))
      expect(findBin('codex', { PATH: inCwd }, 'darwin', { cwd })).toBeUndefined()
      const entry = dirAt('elsewhere')
      symlinkSync(join(inCwd, 'codex'), join(entry, 'codex'))
      expect(findBin('codex', { PATH: entry }, 'darwin', { cwd })).toBeUndefined()
      const good = dirAt('safe')
      const f = script(good)
      expect(findBin('codex', { PATH: `${inCwd}:${entry}:${good}` }, 'darwin', { cwd })).toBe(f)
    })

    it('trustedPath drops relative, missing, world-writable and in-cwd entries, and keeps order', () => {
      const a = dirAt('a')
      const open = dirAt('o', 0o777)
      const cwd = dirAt('s')
      const inCwd = dirAt('s/bin')
      const b = dirAt('b', 0o775)
      expect(trustedPath(`${a}:rel:${open}::${join(base, 'nope')}:${inCwd}:${b}`, { cwd })).toBe(`${a}:${b}`)
    })

    it('binaryDirs names the link dir and the real dir, once each', () => {
      const real = dirAt('rd')
      const f = script(real)
      const entry = dirAt('en')
      symlinkSync(f, join(entry, 'codex'))
      expect(binaryDirs({ path: join(entry, 'codex') })).toEqual([entry, real])
      expect(binaryDirs({ path: f })).toEqual([real])
      expect(binaryDirs({})).toEqual([])
    })

    it('the only candidate untrusted → installed, none, untrusted_binary, and it never ran', async () => {
      const fake = installFake()
      chmodSync(fake.dir, 0o777)
      const runs: string[][] = []
      const info = await detectExecutor(codexAdapter, depsFor(fake.dir, { env: { PATH: fake.dir }, run: (f, a, t, e) => (runs.push(a), runProbe(f, a, t, e)) }))
      chmodSync(fake.dir, 0o755)
      expect(info).toEqual({ id: 'codex', installed: true, auth: 'unknown', isolation: 'none', missing: ['untrusted_binary'] })
      expect(runs).toEqual([])
      expect(fake.calls()).toEqual([])
    })

    it('owned by someone else → untrusted_binary too (Qoder as well)', async () => {
      const fake = installFake({}, 'qodercli')
      const info = await detectExecutor(qoderAdapter, depsFor(fake.dir, { env: { PATH: fake.dir }, uid: uid + 1 }))
      expect(info).toMatchObject({ installed: true, isolation: 'none', missing: ['untrusted_binary'] })
      expect(fake.calls()).toEqual([])
    })

    it('probes do not get a world-writable PATH entry: a planted node is not reached', async () => {
      const fake = installFake()
      const open = dirAt('plant', 0o777)
      const marker = join(base, 'planted-ran')
      writeFileSync(join(open, 'node'), `#!/bin/sh\ntouch '${marker}'\n`)
      chmodSync(join(open, 'node'), 0o755)
      const seen: (string | undefined)[] = []
      await detectExecutor(codexAdapter, depsFor(fake.dir, {
        env: { ...envFor(fake.dir), PATH: `${open}:${fake.dir}:/usr/bin:/bin` },
        run: (f, a, t, e) => (seen.push(e.PATH), runProbe(f, a, t, e)),
      }))
      expect(seen.length).toBeGreaterThan(0)
      for (const p of seen) expect(p).toBe(`${fake.dir}:/usr/bin:/bin`)
      expect(existsSync(marker)).toBe(false)
    })
  })

  it('has no answer without PATH or on win32', () => {
    const fake = installFake()
    expect(findBin('codex', {}, 'darwin')).toBeUndefined()
    expect(findBin('codex', { PATH: fake.dir }, 'win32')).toBeUndefined()
  })
})

describe.skipIf(process.platform === 'win32')('detectExecutor', () => {
  it('reports an installed, logged-in Codex with a passing self-test', async () => {
    const fake = installFake({ version: 'codex-cli 0.154.0' })
    expect(await detectExecutor(codexAdapter, depsFor(fake.dir))).toEqual({
      id: 'codex', installed: true, version: 'codex-cli 0.154.0', auth: 'ok', isolation: 'own', missing: [], path: fake.file, binaryKey: binaryKey(fake.file),
    })
  })

  it('no program → not installed, nothing ran', async () => {
    const empty = join(base, 'empty')
    mkdirSync(empty)
    const runs: string[][] = []
    const info = await detectExecutor(codexAdapter, depsFor(empty, { env: { PATH: empty }, run: async (_f, a) => (runs.push(a), { code: 0, out: '', stdout: '' }) }))
    expect(info).toEqual({ id: 'codex', installed: false, auth: 'unknown', isolation: 'none', missing: ['not_installed'] })
    expect(runs).toEqual([])
  })

  it('a wrapper script without the x bit is not installed', async () => {
    const fake = installFake()
    chmodSync(fake.file, 0o644)
    const info = await detectExecutor(codexAdapter, depsFor(fake.dir))
    expect(info).toMatchObject({ installed: false, missing: ['not_installed'] })
    expect(fake.calls()).toEqual([])
  })

  it('a disabled id runs nothing', async () => {
    const fake = installFake()
    const info = await detectExecutor(codexAdapter, depsFor(fake.dir, { config: () => ({ disabled: ['codex'] }) }))
    expect(info).toEqual({ id: 'codex', installed: false, auth: 'unknown', isolation: 'none', missing: ['disabled'] })
    expect(fake.calls()).toEqual([])
    expect(readdirSync(scratch)).toEqual([])
  })

  it('win32 is unsupported and runs nothing', async () => {
    const fake = installFake()
    const info = await detectExecutor(codexAdapter, depsFor(fake.dir, { platform: 'win32' }))
    expect(info).toEqual({ id: 'codex', installed: false, auth: 'unknown', isolation: 'none', missing: ['unsupported'] })
    expect(fake.calls()).toEqual([])
  })

  it.each<[string, string, number, ExecutorInfo['auth']]>([
    ['codex logged in', 'Logged in using ChatGPT', 0, 'ok'],
    ['codex logged out', 'Not logged in', 1, 'missing'],
    ['codex nonsense', 'mystery output', 0, 'unknown'],
    // 退出码说失败、文字说登录了:读不懂
    ['codex contradiction', 'Logged in using ChatGPT', 1, 'unknown'],
  ])('auth: %s', async (_n, loginStatus, loginExit, auth) => {
    const fake = installFake({ loginStatus, loginExit })
    expect((await detectExecutor(codexAdapter, depsFor(fake.dir))).auth).toBe(auth)
  })

  it.each<[string, ExecutorInfo['auth']]>([
    ['{"logged_in":true}', 'ok'],
    ['{"logged_in":false}', 'missing'],
    ['not json', 'unknown'],
  ])('auth: qoder %s', async (loginStatus, auth) => {
    const fake = installFake({ loginStatus }, 'qodercli')
    expect((await detectExecutor(qoderAdapter, depsFor(fake.dir))).auth).toBe(auth)
  })

  it('reads a login answer that arrives on stderr', async () => {
    const fake = installFake()
    writeFileSync(fake.file, '#!/bin/sh\necho "Logged in using ChatGPT" >&2\n')
    expect((await runProbe(fake.file, ['login', 'status'], 5000, envFor(fake.dir))).out).toContain('Logged in')
  })

  it('a probe that shrugs off the timeout signal and exits 0 still has no exit code', async () => {
    const fake = installFake()
    writeFileSync(fake.file, "#!/bin/sh\ntrap 'exit 0' INT\nwhile :; do /bin/sleep 0.1; done\n")
    expect(await runProbe(fake.file, [], 500, envFor(fake.dir))).toMatchObject({ code: null })
  })

  it('a login probe that cannot run is unknown, and the run still goes ahead', async () => {
    const fake = installFake()
    const info = await detectExecutor(codexAdapter, depsFor(fake.dir, {
      run: (f, a, t, e) => (a[0] === 'login' ? Promise.reject(new Error('boom')) : runProbe(f, a, t, e)),
    }))
    expect(info).toMatchObject({ installed: true, auth: 'unknown', isolation: 'own' })
  })

  it('a hanging --version is killed at the real timeout, and detection finishes', async () => {
    // 用真实的 10 s:短超时在高负载下会抢在脚本起来、记下 pid 之前
    const fake = installFake()
    const pidFile = join(fake.dir, 'pid')
    writeFileSync(fake.file, `#!/bin/sh\necho $$ > '${pidFile}'\nexec /bin/sleep 60\n`)
    const info = await detectExecutor(codexAdapter, depsFor(fake.dir))
    const pid = Number(readFileSync(pidFile, 'utf8'))
    trackPid(pid)
    expect(PROBE_TIMEOUT_MS).toBe(10_000)
    expect(info).toMatchObject({ installed: false, auth: 'unknown', isolation: 'none', missing: ['not_runnable'] })
    expect(isAlive(pid)).toBe(false)
  })

  it('every probe gets the same timeout', async () => {
    const fake = installFake()
    const asked: number[] = []
    await detectExecutor(codexAdapter, depsFor(fake.dir, { run: (f, a, t, e) => (asked.push(t), runProbe(f, a, t, e)) }))
    expect(asked).toEqual([PROBE_TIMEOUT_MS, PROBE_TIMEOUT_MS, PROBE_TIMEOUT_MS, PROBE_TIMEOUT_MS])
  })

  it.each<[string, DetectDeps['run']]>([
    ['rejects', () => Promise.reject(new Error('boom'))],
    ['exits non-zero', async () => ({ code: 3, out: 'v 1.0', stdout: 'v 1.0' })],
    ['has no exit code', async () => ({ code: null, out: 'v 1.0', stdout: 'v 1.0' })],
  ])('a --version probe that %s is not runnable', async (_n, run) => {
    const fake = installFake()
    await expect(detectExecutor(codexAdapter, depsFor(fake.dir, { run }))).resolves.toMatchObject({ installed: false, missing: ['not_runnable'] })
  })

  it('never throws when a dependency does', async () => {
    const fake = installFake()
    const boom = () => {
      throw new Error('boom')
    }
    await expect(detectExecutor(codexAdapter, depsFor(fake.dir, { config: boom }))).resolves.toMatchObject({ installed: false, isolation: 'none', missing: ['detect_failed'] })
    await expect(detectExecutor(qoderAdapter, depsFor(installFake({}, 'qodercli').dir, { sandboxLevel: boom }))).resolves.toMatchObject({ isolation: 'none' })
  })

  it.each<[string, string | undefined]>([
    ['codex-cli 0.154.0', 'codex-cli 0.154.0'],
    ['qodercli 1.0.29', 'qodercli 1.0.29'],
    ['v1.2.3', 'v1.2.3'],
    ['0.154.0-alpha.1', '0.154.0-alpha.1'],
    ['codex version 1.2', 'codex version 1.2'],
    ['banner text\ncodex 1.2.3', 'codex 1.2.3'],
    ['warn: proxy http://user:hunter2@10.0.0.1:8080 unreachable', undefined],
    ['http://user:hunter2@10.0.0.1:8080', undefined],
    ['\u001b[1mcodex\u001b[0m 1.2.3', undefined],
    [`codex ${'1.'.repeat(200)}1`, undefined],
    ['no digits here', undefined],
    ['codex 1.2.3-sk-abcdefghijklmnopqrstuvwx', 'codex 1.2.3-***'],
  ])('version from stdout %j → %j', async (stdout, want) => {
    const fake = installFake({ version: stdout })
    const info = await detectExecutor(codexAdapter, depsFor(fake.dir))
    expect(info.version).toBe(want)
    expect(info.installed).toBe(true)
  })

  it('a stderr line shaped like a version does not win over stdout', async () => {
    const fake = installFake()
    writeFileSync(fake.file, '#!/bin/sh\necho "node 1.2.3" >&2\n/bin/sleep 0.1\necho "codex-cli 0.154.0"\n')
    const info = await detectExecutor(codexAdapter, depsFor(fake.dir, { config: () => ({ codex: { network: true } }) }))
    expect(info.version).toBe('codex-cli 0.154.0')
  })

  it('a stderr line never becomes the version, and a secret on stderr goes nowhere', async () => {
    const fake = installFake()
    const secret = 'http://user:hunter2@10.0.0.1:8080'
    writeFileSync(fake.file, `#!/bin/sh\necho "warn: proxy ${secret} unreachable" >&2\n/bin/sleep 0.1\ncase "$1" in\n  --version) echo "codex-cli 0.154.0" ;;\n  login) echo "Logged in" ;;\nesac\n`)
    const info = await detectExecutor(codexAdapter, depsFor(fake.dir, { config: () => ({ codex: { network: true } }) }))
    expect(info.version).toBe('codex-cli 0.154.0')
    expect(JSON.stringify(info)).not.toContain('hunter2')
    const probe = await runProbe(fake.file, ['--version'], 5000, envFor(fake.dir))
    expect(probe.stdout).toBe('codex-cli 0.154.0\n')
    expect(probe.out).toContain('hunter2')
  })

  describe('probes are registered and cancellable', () => {
    const hung = () => {
      const fake = installFake()
      const pidFile = join(fake.dir, 'pid')
      writeFileSync(fake.file, `#!/bin/sh\necho $$ > '${pidFile}'\nexec /bin/sleep 60\n`)
      const pid = async () => {
        await vi.waitFor(() => expect(existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '').toBe(true), { timeout: 15_000 })
        const n = Number(readFileSync(pidFile, 'utf8'))
        trackPid(n)
        return n
      }
      return { fake, pid }
    }

    it('a hung probe is gone after its timeout, and its registry entry with it', async () => {
      const { fake, pid } = hung()
      const file = join(base, 'pgids')
      const pgids = new PgidRegistry(file)
      const running = detectExecutor(codexAdapter, depsFor(fake.dir, { pgids }))
      const p = await pid()
      await vi.waitFor(() => expect(readFileSync(file, 'utf8')).toContain(String(p)), { timeout: 5000 })
      expect(await running).toMatchObject({ installed: false, missing: ['not_runnable'] })
      expect(isAlive(p)).toBe(false)
      expect(readFileSync(file, 'utf8')).not.toContain(String(p))
      pgids.dispose()
    })

    it('a crash during a probe: the next worker reaps it from the registry', async () => {
      const { fake, pid } = hung()
      const file = join(base, 'pgids')
      const pgids = new PgidRegistry(file)
      const running = detectExecutor(codexAdapter, depsFor(fake.dir, { pgids }))
      const p = await pid()
      await vi.waitFor(() => expect(readFileSync(file, 'utf8')).toContain(String(p)), { timeout: 5000 })
      expect(reapOrphans(file).killed).toContain(p)
      expect(await waitDead(p, 3000)).toBe(true)
      await running
      pgids.dispose()
    })

    it('aborting kills a hung probe at once and runs nothing further', async () => {
      const { fake, pid } = hung()
      const ac = new AbortController()
      const asked: string[][] = []
      const started = Date.now()
      const running = detectExecutor(codexAdapter, depsFor(fake.dir, { signal: ac.signal, run: (f, a, t, e, c) => (asked.push(a), runProbe(f, a, t, e, c)) }))
      const p = await pid()
      ac.abort()
      expect(await running).toEqual({ id: 'codex', installed: false, auth: 'unknown', isolation: 'none', missing: ['cancelled'] })
      expect(Date.now() - started).toBeLessThan(PROBE_TIMEOUT_MS)
      expect(isAlive(p)).toBe(false)
      expect(asked).toEqual([['--version']])
      expect(readdirSync(scratch)).toEqual([])
    })

    it('an already aborted signal runs nothing', async () => {
      const fake = installFake()
      const ac = new AbortController()
      ac.abort()
      expect(await detectExecutor(codexAdapter, depsFor(fake.dir, { signal: ac.signal }))).toMatchObject({ missing: ['cancelled'] })
      expect(fake.calls()).toEqual([])
    })

    it('aborting during the self-test is not cached as a result', async () => {
      const fake = installFake()
      const ac = new AbortController()
      await detectExecutor(codexAdapter, depsFor(fake.dir, {
        signal: ac.signal,
        run: (f, a, t, e, c) => {
          if (a[0] === 'sandbox') ac.abort()
          return runProbe(f, a, t, e, c)
        },
      }))
      expect(readdirSync(scratch)).toEqual([])
      expect(await detectExecutor(codexAdapter, depsFor(fake.dir))).toMatchObject({ isolation: 'own' })
    })
  })

  it('probes from a neutral cwd: the repo holds nothing a probe should load', async () => {
    const fake = installFake()
    await detectExecutor(codexAdapter, depsFor(fake.dir))
    expect(new Set(fake.calls().map(c => c.cwd))).toEqual(new Set([realpathSync('/')]))
  })

  it('Qoder: wrapped when the level has a sandbox, none otherwise, no self-test', async () => {
    const fake = installFake({}, 'qodercli')
    expect(await detectExecutor(qoderAdapter, depsFor(fake.dir, { sandboxLevel: () => 'partial' }))).toMatchObject({ isolation: 'wrapped', missing: [] })
    expect(await detectExecutor(qoderAdapter, depsFor(fake.dir, { sandboxLevel: () => 'none' }))).toMatchObject({ isolation: 'none' })
    expect(sandboxCalls(fake)).toEqual([])
  })
})

describe.skipIf(process.platform === 'win32')('Codex self-test', () => {
  // 每一行的判定在 codex.test.ts 逐行查过;这里每种走一遍真进程
  const ROWS = ['secret_read', 'cwd_write', 'outside_write', 'git_write', 'tmp_write', 'rule_write', 'rule_read', 'secret_dir_read', 'net_connect']

  it.each(['secret_read', 'rule_write', 'ro_cwd_write', 'ro_cwd_read'])('a failed %s row → none + codex_selftest', async row => {
    const fake = installFake({ selftest: `fail:${row}` })
    expect(await detectExecutor(codexAdapter, depsFor(fake.dir))).toMatchObject({ installed: true, isolation: 'none', missing: ['codex_selftest'] })
  })

  it.each(['net_connect', 'ro_cwd_read'])('a missing %s marker → none + codex_selftest', async row => {
    const fake = installFake({ selftest: `omit:${row}` })
    expect(await detectExecutor(codexAdapter, depsFor(fake.dir))).toMatchObject({ isolation: 'none', missing: ['codex_selftest'] })
  })

  it('the read-only pass runs only after the writable one passed, with no :project_roots', async () => {
    const fake = installFake()
    await detectExecutor(codexAdapter, depsFor(fake.dir))
    const calls = sandboxCalls(fake)
    expect(calls).toHaveLength(2)
    const fsOf = (argv: string[]) => argv.find(a => a.startsWith('permissions.mffai.filesystem='))!
    expect(fsOf(calls[0].argv)).toContain(':project_roots')
    expect(fsOf(calls[1].argv)).not.toContain(':project_roots')
    expect(calls[1].argv.slice(calls[1].argv.indexOf('--') + 1, calls[1].argv.indexOf('--') + 4)).toEqual(['/bin/sh', '-c', SELF_TEST_READ_ONLY_SCRIPT])
    const failing = installFake({ selftest: 'fail:rule_read' })
    await detectExecutor(codexAdapter, depsFor(failing.dir))
    expect(sandboxCalls(failing)).toHaveLength(1)
  })

  it('the profile holds the entries rule translation relies on: read and none inside cwd, none on a directory', async () => {
    const fake = installFake()
    await detectExecutor(codexAdapter, depsFor(fake.dir))
    const { argv } = sandboxCalls(fake)[0]
    const dir = argv[argv.indexOf('-C') + 1]
    const secretDir = argv[argv.indexOf('--') + 8]
    const fs = argv.find(a => a.startsWith('permissions.mffai.filesystem='))!
    expect(fs).toContain(`"${join(dir, 'ro')}"="read"`)
    expect(fs).toContain(`"${join(dir, 'hidden')}"="none"`)
    expect(fs).toContain(`"${secretDir}"="none"`)
    expect(secretDir.startsWith(`${dir}/`)).toBe(false)
  })

  it('every row passing but a non-zero exit → none + codex_selftest', async () => {
    const fake = installFake({ selftestExit: 2 })
    expect(await detectExecutor(codexAdapter, depsFor(fake.dir))).toMatchObject({ isolation: 'none', missing: ['codex_selftest'] })
  })

  it('the read-only pass exiting non-zero with good rows → none + codex_selftest', async () => {
    const fake = installFake()
    const run: DetectDeps['run'] = async (f, a, t, e, c) => {
      const r = await runProbe(f, a, t, e, c)
      return a.includes(SELF_TEST_READ_ONLY_SCRIPT) ? { ...r, code: 1 } : r
    }
    expect(await detectExecutor(codexAdapter, depsFor(fake.dir, { run }))).toMatchObject({ isolation: 'none', missing: ['codex_selftest'] })
  })

  it('net_connect says r=1 but the listener saw a connection → none + codex_selftest', async () => {
    const fake = installFake({ selftestConnect: true })
    expect(await detectExecutor(codexAdapter, depsFor(fake.dir))).toMatchObject({ isolation: 'none', missing: ['codex_selftest'] })
    expect(sandboxCalls(fake).at(-1)!.argv.at(-1)).toMatch(/^\d+$/)
  })

  it('the probe failing or setup failing → none + codex_selftest, no throw, not cached', async () => {
    const fake = installFake()
    const failSandbox = (run: DetectDeps['run']): DetectDeps['run'] => (f, a, t, e) => (a[0] === 'sandbox' ? run(f, a, t, e) : runProbe(f, a, t, e))
    const bad: Partial<DetectDeps>[] = [
      { run: failSandbox(() => Promise.reject(new Error('boom'))) },
      { run: failSandbox(async () => ({ code: null, out: ROWS.join('\n'), stdout: ROWS.join('\n') })) },
      { tmp: () => join(base, 'does', 'not', 'exist') },
      { policy: () => { throw new Error('boom') } },
      { policy: () => ({ denyRead: ['relative/path'] }) },
    ]
    for (const over of bad) {
      expect(await detectExecutor(codexAdapter, depsFor(fake.dir, over))).toMatchObject({ installed: true, isolation: 'none', missing: ['codex_selftest'] })
    }
  })

  it('an adapter that claims translate without a self-test never counts as own', async () => {
    const fake = installFake()
    const { selfTest: _gone, ...rest } = codexAdapter
    const adapter: Adapter = rest
    expect(await detectExecutor(adapter, depsFor(fake.dir))).toMatchObject({ isolation: 'none', missing: ['codex_selftest'] })
  })

  it('runs the same profile as a real run, with the real denyRead and a constant script', async () => {
    const fake = installFake()
    await detectExecutor(codexAdapter, depsFor(fake.dir, { policy: () => ({ denyRead: ['/h/.ssh', '/h/data'] }) }))
    const { argv } = sandboxCalls(fake)[0]
    const dash = argv.indexOf('--')
    expect(argv.slice(0, 2)).toEqual(['sandbox', '-C'])
    expect(argv.slice(dash - 2, dash)).toEqual(['-P', 'mffai'])
    expect(argv.slice(dash + 1, dash + 4)).toEqual(['/bin/sh', '-c', SELF_TEST_SCRIPT])
    const fs = argv.find(a => a.startsWith('permissions.mffai.filesystem='))!
    for (const entry of ['":root"="read"', '":project_roots"={"."="write"}', '":tmpdir"="write"', '"/h/.ssh"="none"', '"/h/data"="none"']) expect(fs).toContain(entry)
    expect(argv).toContain('permissions.mffai.network={enabled=false}')
    expect(argv).not.toContain('--dangerously-bypass-approvals-and-sandbox')
  })

  it('gets an empty CODEX_HOME and its own TMPDIR; the fake secret is denied, and cwd is a repo', async () => {
    const fake = installFake()
    let seen: { home: string; homeEntries: string[]; tmp: string; dir: string; secret: string; outside: string; gitConfig: boolean } | undefined
    const env = { ...envFor(fake.dir), CODEX_HOME: join(base, 'real-codex-home') }
    await detectExecutor(codexAdapter, depsFor(fake.dir, {
      env,
      run: (f, a, t, e) => {
        if (a.includes(SELF_TEST_SCRIPT)) {
          const dash = a.indexOf('--')
          const [secret, , outside] = a.slice(dash + 5)
          const dir = a[a.indexOf('-C') + 1]
          seen = { home: e.CODEX_HOME!, homeEntries: readdirSync(e.CODEX_HOME!), tmp: e.TMPDIR!, dir, secret, outside, gitConfig: existsSync(join(dir, '.git', 'config')) }
          expect(readFileSync(secret, 'utf8')).toContain('SECRET')
          expect(a.find(x => x.startsWith('permissions.mffai.filesystem='))).toContain(`"${secret}"="none"`)
        }
        return runProbe(f, a, t, e)
      },
    }))
    const s = seen!
    expect(s.home).not.toBe(env.CODEX_HOME)
    expect(s.homeEntries).toEqual([])
    expect(s.gitConfig).toBe(true)
    // :tmpdir 可写:cwd 外的探针不能落在它下面,否则这一行永远测不出东西
    expect(s.outside.startsWith(`${s.tmp}/`)).toBe(false)
    expect(s.outside.startsWith(`${s.dir}/`)).toBe(false)
    expect(s.secret.startsWith(`${s.dir}/`)).toBe(false)
    expect(s.secret.startsWith(realpathSync(scratch))).toBe(true)
    // 调用方自己的环境不动
    expect(env.CODEX_HOME).toBe(join(base, 'real-codex-home'))
    expect(fake.calls().filter(c => c.argv[0] === '--version')[0].env.CODEX_HOME).toBe(env.CODEX_HOME)
  })

  it('names the secret by realpath, because the profile does not resolve links', async () => {
    const fake = installFake()
    const link = join(base, 'tmp-link')
    symlinkSync(scratch, link)
    await detectExecutor(codexAdapter, depsFor(fake.dir, { tmp: () => link }))
    const { argv } = sandboxCalls(fake)[0]
    const secret = argv[argv.indexOf('--') + 5]
    expect(secret.startsWith(`${scratch}/`)).toBe(true)
    expect(argv.find(a => a.startsWith('permissions.mffai.filesystem='))).toContain(`"${secret}"="none"`)
    expect(readdirSync(scratch)).toEqual([])
  })

  it('removes temp dirs and closes the listener, on success and on failure', async () => {
    const reject = () => Promise.reject(new Error('x'))
    const cases: [object, boolean][] = [[{}, false], [{ selftest: 'fail:git_write' }, false], [{ selftestExit: 1 }, false], [{}, true]]
    for (const [scenario, rejects] of cases) {
      const fake = installFake(scenario)
      let port = 0
      await detectExecutor(codexAdapter, depsFor(fake.dir, {
        run: (f, a, t, e) => {
          if (a[0] !== 'sandbox') return runProbe(f, a, t, e)
          if (a.includes(SELF_TEST_SCRIPT)) port = Number(a.at(-1))
          return rejects ? reject() : runProbe(f, a, t, e)
        },
      }))
      expect(port).toBeGreaterThan(0)
      expect(readdirSync(scratch)).toEqual([])
      expect(await refused(port)).toBe(true)
    }
  })

  it('caches on realpath + size + mtime, never on what the binary says its version is', async () => {
    const fake = installFake({ version: 'codex 1.0' })
    await detectExecutor(codexAdapter, depsFor(fake.dir))
    expect(await detectExecutor(codexAdapter, depsFor(fake.dir))).toMatchObject({ isolation: 'own', missing: [] })
    expect(sandboxCalls(fake)).toHaveLength(2)
    // 同样的版本号、同一个路径,文件换了
    writeFileSync(join(fake.dir, 'scenario.json'), JSON.stringify({ version: 'codex 1.0', selftest: 'fail:secret_read' }))
    const t = new Date(Date.now() + 5000)
    utimesSync(fake.file, t, t)
    expect(await detectExecutor(codexAdapter, depsFor(fake.dir))).toMatchObject({ version: 'codex 1.0', isolation: 'none', missing: ['codex_selftest'] })
    expect(sandboxCalls(fake)).toHaveLength(3)
    // 确定的失败也缓存;版本号变了但文件没变,不重跑
    writeFileSync(join(fake.dir, 'scenario.json'), JSON.stringify({ version: 'codex 2.0' }))
    expect(await detectExecutor(codexAdapter, depsFor(fake.dir))).toMatchObject({ version: 'codex 2.0', isolation: 'none', missing: ['codex_selftest'] })
    expect(sandboxCalls(fake)).toHaveLength(3)
  })

  it('a repointed symlink is a different binary', async () => {
    const a = installFake()
    const b = installFake({ selftest: 'fail:secret_read' })
    const entry = join(base, 'linkbin')
    mkdirSync(entry)
    symlinkSync(a.file, join(entry, 'codex'))
    const deps = depsFor(entry)
    expect(await detectExecutor(codexAdapter, deps)).toMatchObject({ isolation: 'own' })
    rmSync(join(entry, 'codex'))
    symlinkSync(b.file, join(entry, 'codex'))
    // 假 CLI 按链接所在的目录找剧本;能看到这个结果,说明自检确实重跑了
    writeFileSync(join(entry, 'scenario.json'), JSON.stringify({ selftest: 'fail:secret_read' }))
    expect(await detectExecutor(codexAdapter, deps)).toMatchObject({ isolation: 'none', missing: ['codex_selftest'] })
  })

  it('force skips the cache, so a refresh can clear a definite failure', async () => {
    const fake = installFake({ selftestExit: 1 })
    expect(await detectExecutor(codexAdapter, depsFor(fake.dir))).toMatchObject({ isolation: 'none' })
    writeFileSync(join(fake.dir, 'scenario.json'), '{}')
    expect(await detectExecutor(codexAdapter, depsFor(fake.dir))).toMatchObject({ isolation: 'none' })
    expect(await detectExecutor(codexAdapter, depsFor(fake.dir, { force: true }))).toMatchObject({ isolation: 'own' })
  })

  it('sweeps self-test dirs a crash left behind, but not a fresh one', async () => {
    const stale = join(scratch, 'mffai-selftest-stale')
    const fresh = join(scratch, 'mffai-selftest-fresh')
    const other = join(scratch, 'not-ours')
    for (const d of [stale, fresh, other]) mkdirSync(d)
    const old = new Date(Date.now() - 3600_000)
    utimesSync(stale, old, old)
    utimesSync(other, old, old)
    await detectExecutor(codexAdapter, depsFor(installFake().dir))
    expect(readdirSync(scratch).sort()).toEqual(['mffai-selftest-fresh', 'not-ours'])
  })

  it('a probe that never finished is not cached: a refresh can try again', async () => {
    const fake = installFake()
    let times = 0
    const run: DetectDeps['run'] = (f, a, t, e) => (a[0] === 'sandbox' && times++ === 0 ? Promise.resolve({ code: null, out: '', stdout: '' }) : runProbe(f, a, t, e))
    expect(await detectExecutor(codexAdapter, depsFor(fake.dir, { run }))).toMatchObject({ isolation: 'none', missing: ['codex_selftest'] })
    expect(await detectExecutor(codexAdapter, depsFor(fake.dir, { run }))).toMatchObject({ isolation: 'own', missing: [] })
  })

  it('executors.codex.network:true → none + codex_network, and no self-test ran', async () => {
    const fake = installFake()
    const info = await detectExecutor(codexAdapter, depsFor(fake.dir, { config: () => ({ codex: { network: true } }) }))
    expect(info).toMatchObject({ installed: true, isolation: 'none', missing: ['codex_network'] })
    expect(sandboxCalls(fake)).toEqual([])
  })

  describe('the real scripts, under the fake (no Codex, no sandbox)', () => {
    const hasCurl = existsSync('/usr/bin/curl')
    const argsOf = (a: string[]) => {
      const [secret, control, outside, secretDir] = a.slice(a.indexOf('--') + 5)
      return { secret, control, outside, secretDir, dir: a[a.indexOf('-C') + 1], readOnly: a.includes(SELF_TEST_READ_ONLY_SCRIPT) }
    }
    /** 真的跑脚本;用文件权限造出"被挡住"的样子。只读那一遍的 cwd 临时收紧,跑完放开,不然删不掉 */
    function runner(confine: { write?: boolean; readOnly?: boolean; also?: (p: ReturnType<typeof argsOf>) => void }): DetectDeps['run'] {
      return async (f, a, t, e, c) => {
        if (a[0] !== 'sandbox') return runProbe(f, a, t, e, c)
        const p = argsOf(a)
        if (p.readOnly) {
          if (confine.readOnly) chmodSync(p.dir, 0o555)
          try {
            return await runProbe(f, a, t, e, c)
          } finally {
            chmodSync(p.dir, 0o755)
          }
        }
        if (confine.write) {
          chmodSync(p.secret, 0o000)
          chmodSync(join(p.secretDir, 'x'), 0o000)
          chmodSync(p.outside, 0o555)
          chmodSync(join(p.dir, '.git', 'config'), 0o444)
          chmodSync(join(p.dir, 'ro'), 0o555)
          chmodSync(join(p.dir, 'hidden', 'x'), 0o000)
        }
        confine.also?.(p)
        return runProbe(f, a, t, e, c)
      }
    }
    const selfTest = (confine: Parameters<typeof runner>[0]) => {
      const fake = installFake({ selftest: 'run' })
      return runSelfTest(codexAdapter, fake.file, depsFor(fake.dir, { run: runner(confine) }))
    }

    it('with no isolation at all, every "must fail" row is reported', async () => {
      const { failed } = await selfTest({})
      expect([...failed].sort()).toEqual([...(hasCurl ? ['net_connect'] : []), 'git_write', 'outside_write', 'rule_read', 'rule_write', 'secret_dir_read', 'secret_read'].sort())
    })

    it('under a working boundary every row passes except the network, which file modes cannot block', async () => {
      const { failed } = await selfTest({ write: true, readOnly: true })
      expect(failed).toEqual(hasCurl ? ['net_connect'] : [])
      expect(readdirSync(scratch)).toEqual([])
    })

    it('a secret that "fails" only because nothing is readable does not pass', async () => {
      const { failed } = await selfTest({ write: true, also: p => chmodSync(p.control, 0o000) })
      expect(failed).toEqual(expect.arrayContaining(['secret_read', 'secret_dir_read']))
    })

    it('a rule_read that "fails" only because cwd is unreadable does not pass', async () => {
      const { failed } = await selfTest({ write: true, also: p => chmodSync(join(p.dir, 'visible'), 0o000) })
      expect(failed).toContain('rule_read')
    })

    it('a TMPDIR the shell cannot write fails the tmp row', async () => {
      const fake = installFake({ selftest: 'run' })
      const result = await runSelfTest(codexAdapter, fake.file, depsFor(fake.dir, {
        run: (f, a, t, e, c) => (a[0] === 'sandbox' ? runProbe(f, a, t, { ...e, TMPDIR: join(base, 'gone') }, c) : runProbe(f, a, t, e, c)),
      }))
      expect(result.failed).toContain('tmp_write')
    })

    it('uses curl by absolute path, without the proxy or curlrc', () => {
      expect(SELF_TEST_SCRIPT).toMatch(/\/usr\/bin\/curl -q -s .*--noproxy/)
    })

    it('the read-only script against a cwd that really is writable, then really is read-only', async () => {
      const fake = installFake({ selftest: 'run' })
      const dir = join(base, 'ro-cwd')
      mkdirSync(dir)
      writeFileSync(join(dir, 'visible'), 'x')
      const pass = () => runProbe(fake.file, ['sandbox', '-C', dir, '--', '/bin/sh', '-c', SELF_TEST_READ_ONLY_SCRIPT, 'x'], 15_000, envFor(fake.dir))
      expect((await pass()).out).toBe('ro_cwd_write r=0\nro_cwd_read r=0\n')
      rmSync(join(dir, 'mffai-probe-ro'))
      chmodSync(dir, 0o555)
      try {
        expect((await pass()).out).toMatch(/^ro_cwd_write r=[1-9]\d*\nro_cwd_read r=0\n$/)
      } finally {
        chmodSync(dir, 0o755)
      }
    })
  })
})

describe.skipIf(process.platform === 'win32')('isolationOf', () => {
  let bin: FakeCli
  beforeEach(() => {
    bin = installFake()
  })
  const info = (over: Partial<ExecutorInfo> = {}): ExecutorInfo => ({ id: 'codex', installed: true, auth: 'ok', isolation: 'own', missing: [], path: bin.file, binaryKey: binaryKey(bin.file), ...over })
  const paths = { cwd: '/w/repo', denyRead: ['/h/.ssh'], readOnlyPaths: ['/w/repo/src/gen'] }

  it.each<[string, () => Parameters<typeof isolationOf>, string, string[]]>([
    ['self-test passed', () => [codexAdapter, info(), 'full', {}, paths], 'own', []],
    ['own does not depend on the level', () => [codexAdapter, info(), 'none', {}, paths], 'own', []],
    ['self-test failed', () => [codexAdapter, info({ missing: ['codex_selftest'] }), 'full', {}, paths], 'none', ['codex_selftest']],
    ['network on', () => [codexAdapter, info(), 'full', { codex: { network: true } }, paths], 'none', ['codex_network']],
    // 开着网络探测时没跑自检,关掉之后不能当作通过
    ['network turned off after a detection that skipped the self-test', () => [codexAdapter, info({ missing: ['codex_network'] }), 'full', {}, paths], 'none', ['codex_network', 'codex_selftest']],
    ['not installed', () => [codexAdapter, info({ installed: false, missing: ['not_installed'] }), 'full', {}, paths], 'none', ['not_installed']],
    ['untrusted at detection', () => [codexAdapter, info({ missing: ['untrusted_binary'], path: undefined, binaryKey: undefined }), 'full', {}, paths], 'none', ['untrusted_binary']],
    ['untrusted at detection, wrap', () => [qoderAdapter, info({ id: 'qoder', missing: ['untrusted_binary'], path: undefined, binaryKey: undefined }), 'full', {}, paths], 'none', ['untrusted_binary']],
    ['glob in cwd', () => [codexAdapter, info(), 'full', {}, { ...paths, cwd: '/w/re[p]o' }], 'none', ['codex_path_glob']],
    ['glob in a deny root', () => [codexAdapter, info(), 'full', {}, { ...paths, denyRead: ['/h/a*b'] }], 'none', ['codex_path_glob']],
    ['glob in a rule path', () => [codexAdapter, info(), 'full', {}, { ...paths, readOnlyPaths: ['/w/repo/src/[a]'] }], 'none', ['codex_path_glob']],
    ['no paths yet (detection itself)', () => [codexAdapter, info(), 'full', {}, undefined], 'own', []],
    ['wrap, full', () => [qoderAdapter, info({ id: 'qoder' }), 'full', {}, paths], 'wrapped', []],
    ['wrap, partial', () => [qoderAdapter, info({ id: 'qoder' }), 'partial', {}, paths], 'wrapped', []],
    ['wrap, none', () => [qoderAdapter, info({ id: 'qoder' }), 'none', {}, paths], 'none', []],
    ['wrap ignores glob paths: Seatbelt takes them literally', () => [qoderAdapter, info({ id: 'qoder' }), 'full', {}, { ...paths, cwd: '/w/re[p]o' }], 'wrapped', []],
    ['own needs a known binary: no key', () => [codexAdapter, info({ binaryKey: undefined }), 'full', {}, paths], 'none', ['codex_selftest']],
    ['own needs a known binary: no path', () => [codexAdapter, info({ path: undefined }), 'full', {}, paths], 'none', ['codex_selftest']],
  ])('%s', (_n, args, isolation, missing) => {
    expect(isolationOf(...args())).toEqual({ isolation, missing })
  })

  it('keeps earlier missing codes', () => {
    expect(isolationOf(codexAdapter, info({ missing: ['codex_selftest'] }), 'full', { codex: { network: true } }, paths)).toEqual({ isolation: 'none', missing: ['codex_selftest', 'codex_network'] })
  })

  it('the binary changed since it was proven → none + codex_selftest before the run', () => {
    const before = info()
    expect(isolationOf(codexAdapter, before, 'full', {}, paths).isolation).toBe('own')
    const t = new Date(statSync(bin.file).mtimeMs + 5000)
    utimesSync(bin.file, t, t)
    expect(isolationOf(codexAdapter, before, 'full', {}, paths)).toEqual({ isolation: 'none', missing: ['codex_selftest'] })
    expect(isolationOf(codexAdapter, before, 'full', {}, undefined).isolation).toBe('own')
    rmSync(bin.file)
    expect(isolationOf(codexAdapter, before, 'full', {}, paths)).toEqual({ isolation: 'none', missing: ['untrusted_binary'] })
  })

  it('a binary that became untrusted, or sits inside this cwd, → none + untrusted_binary before the run', () => {
    const before = info()
    expect(isolationOf(codexAdapter, before, 'full', {}, { ...paths, cwd: bin.dir })).toEqual({ isolation: 'none', missing: ['untrusted_binary'] })
    expect(isolationOf(qoderAdapter, { ...before, id: 'qoder' }, 'full', {}, { ...paths, cwd: bin.dir })).toEqual({ isolation: 'none', missing: ['untrusted_binary'] })
    chmodSync(bin.dir, 0o777)
    try {
      expect(isolationOf(codexAdapter, before, 'full', {}, paths)).toEqual({ isolation: 'none', missing: ['untrusted_binary'] })
    } finally {
      chmodSync(bin.dir, 0o755)
    }
  })
})

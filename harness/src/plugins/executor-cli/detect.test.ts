import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, join, relative } from 'node:path'
import { cleanupFakes, installFake, isAlive, trackPid, type FakeCli } from '../../../test/fakeCli'
import { codexAdapter } from './adapters/codex'
import { qoderAdapter } from './adapters/qoder'
import type { Adapter } from './adapters/types'
import { detectExecutor, findBin, isolationOf, PROBE_TIMEOUT_MS, runProbe, runSelfTest, SELF_TEST_SCRIPT, type DetectDeps, type ExecutorInfo } from './detect'

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
      id: 'codex', installed: true, version: 'codex-cli 0.154.0', auth: 'ok', isolation: 'own', missing: [], path: fake.file,
    })
  })

  it('no program → not installed, nothing ran', async () => {
    const empty = join(base, 'empty')
    mkdirSync(empty)
    const runs: string[][] = []
    const info = await detectExecutor(codexAdapter, depsFor(empty, { env: { PATH: empty }, run: async (_f, a) => (runs.push(a), { code: 0, out: '' }) }))
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
    expect(asked).toEqual([PROBE_TIMEOUT_MS, PROBE_TIMEOUT_MS, PROBE_TIMEOUT_MS])
  })

  it.each<[string, DetectDeps['run']]>([
    ['rejects', () => Promise.reject(new Error('boom'))],
    ['exits non-zero', async () => ({ code: 3, out: 'v' })],
    ['has no exit code', async () => ({ code: null, out: 'v' })],
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

  it('cleans the version line for the wire', async () => {
    const fake = installFake({ version: `\n  \u001b[1mcodex\u001b[0m ${'x'.repeat(500)}\nsecond line` })
    const { version } = await detectExecutor(codexAdapter, depsFor(fake.dir))
    expect(version).toMatch(/^\[1mcodex\[0m x+$/)
    expect(version!.length).toBeLessThanOrEqual(100)
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
  const ROWS = ['secret_read', 'cwd_write', 'outside_write', 'git_write', 'tmp_write', 'net_connect']

  it.each(ROWS)('a failed %s row → none + codex_selftest', async row => {
    const fake = installFake({ selftest: `fail:${row}` })
    expect(await detectExecutor(codexAdapter, depsFor(fake.dir))).toMatchObject({ installed: true, isolation: 'none', missing: ['codex_selftest'] })
  })

  it.each(ROWS)('a missing %s marker → none + codex_selftest', async row => {
    const fake = installFake({ selftest: `omit:${row}` })
    expect(await detectExecutor(codexAdapter, depsFor(fake.dir))).toMatchObject({ isolation: 'none', missing: ['codex_selftest'] })
  })

  it('every row passing but a non-zero exit → none + codex_selftest', async () => {
    const fake = installFake({ selftestExit: 2 })
    expect(await detectExecutor(codexAdapter, depsFor(fake.dir))).toMatchObject({ isolation: 'none', missing: ['codex_selftest'] })
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
      { run: failSandbox(async () => ({ code: null, out: ROWS.join('\n') })) },
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
        if (a[0] === 'sandbox') {
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
          port = Number(a.at(-1))
          return rejects ? reject() : runProbe(f, a, t, e)
        },
      }))
      expect(port).toBeGreaterThan(0)
      expect(readdirSync(scratch)).toEqual([])
      expect(await refused(port)).toBe(true)
    }
  })

  it('caches per path + version; a new version runs it again', async () => {
    const fake = installFake({ version: 'codex 1' })
    await detectExecutor(codexAdapter, depsFor(fake.dir))
    expect(await detectExecutor(codexAdapter, depsFor(fake.dir))).toMatchObject({ isolation: 'own', missing: [] })
    expect(sandboxCalls(fake)).toHaveLength(1)
    writeFileSync(join(fake.dir, 'scenario.json'), JSON.stringify({ version: 'codex 2', selftest: 'fail:secret_read' }))
    expect(await detectExecutor(codexAdapter, depsFor(fake.dir))).toMatchObject({ version: 'codex 2', isolation: 'none', missing: ['codex_selftest'] })
    expect(sandboxCalls(fake)).toHaveLength(2)
    // 确定的失败也缓存
    expect(await detectExecutor(codexAdapter, depsFor(fake.dir))).toMatchObject({ isolation: 'none', missing: ['codex_selftest'] })
    expect(sandboxCalls(fake)).toHaveLength(2)
  })

  it('a probe that never finished is not cached: a refresh can try again', async () => {
    const fake = installFake()
    let times = 0
    const run: DetectDeps['run'] = (f, a, t, e) => (a[0] === 'sandbox' && times++ === 0 ? Promise.resolve({ code: null, out: '' }) : runProbe(f, a, t, e))
    expect(await detectExecutor(codexAdapter, depsFor(fake.dir, { run }))).toMatchObject({ isolation: 'none', missing: ['codex_selftest'] })
    expect(await detectExecutor(codexAdapter, depsFor(fake.dir, { run }))).toMatchObject({ isolation: 'own', missing: [] })
  })

  it('executors.codex.network:true → none + codex_network, and no self-test ran', async () => {
    const fake = installFake()
    const info = await detectExecutor(codexAdapter, depsFor(fake.dir, { config: () => ({ codex: { network: true } }) }))
    expect(info).toMatchObject({ installed: true, isolation: 'none', missing: ['codex_network'] })
    expect(sandboxCalls(fake)).toEqual([])
  })

  describe('the real script, under the fake (no Codex, no sandbox)', () => {
    /** 真的跑脚本;给了 confine 就在跑之前用文件权限和假 curl 造出"被挡住"的样子 */
    function runner(confine?: (p: { secret: string; control: string; outside: string; dir: string; bin: string }) => void): DetectDeps['run'] {
      return (f, a, t, e) => {
        if (a[0] !== 'sandbox') return runProbe(f, a, t, e)
        const [secret, control, outside] = a.slice(a.indexOf('--') + 5)
        const bin = join(base, 'selftest-bin')
        confine?.({ secret, control, outside, dir: a[a.indexOf('-C') + 1], bin })
        return runProbe(f, a, t, { ...e, PATH: `${bin}:${e.PATH}` })
      }
    }

    it('with no isolation at all, every "must fail" row is reported', async () => {
      const fake = installFake({ selftest: 'run' })
      const result = await runSelfTest(codexAdapter, fake.file, depsFor(fake.dir, { run: runner() }))
      expect([...result.failed].sort()).toEqual(['git_write', 'net_connect', 'outside_write', 'secret_read'])
    })

    it('under a working boundary, all six rows pass', async () => {
      const fake = installFake({ selftest: 'run' })
      const result = await runSelfTest(codexAdapter, fake.file, depsFor(fake.dir, {
        run: runner(({ secret, outside, dir, bin }) => {
          chmodSync(secret, 0o000)
          chmodSync(outside, 0o555)
          chmodSync(join(dir, '.git', 'config'), 0o444)
          mkdirSync(bin)
          writeFileSync(join(bin, 'curl'), '#!/bin/sh\nexit 7\n')
          chmodSync(join(bin, 'curl'), 0o755)
        }),
      }))
      expect(result.failed).toEqual([])
      expect(readdirSync(scratch)).toEqual([])
    })

    it('a secret that "fails" only because nothing is readable does not pass', async () => {
      const fake = installFake({ selftest: 'run' })
      const result = await runSelfTest(codexAdapter, fake.file, depsFor(fake.dir, {
        run: runner(({ secret, control }) => {
          chmodSync(secret, 0o000)
          chmodSync(control, 0o000)
        }),
      }))
      expect(result.failed).toContain('secret_read')
    })

    it('a TMPDIR the shell cannot write fails the tmp row', async () => {
      const fake = installFake({ selftest: 'run' })
      const result = await runSelfTest(codexAdapter, fake.file, depsFor(fake.dir, {
        run: (f, a, t, e) => (a[0] === 'sandbox' ? runProbe(f, a, t, { ...e, TMPDIR: join(base, 'gone') }) : runProbe(f, a, t, e)),
      }))
      expect(result.failed).toContain('tmp_write')
    })

    it('does not follow the user\'s proxy or curlrc to reach the listener', () => {
      expect(SELF_TEST_SCRIPT).toMatch(/curl -q -s .*--noproxy/)
    })
  })
})

describe('isolationOf', () => {
  const info = (over: Partial<ExecutorInfo> = {}): ExecutorInfo => ({ id: 'codex', installed: true, auth: 'ok', isolation: 'own', missing: [], ...over })
  const paths = { cwd: '/w/repo', denyRead: ['/h/.ssh'], readOnlyPaths: ['/w/repo/src/gen'] }

  it.each<[string, Parameters<typeof isolationOf>, string, string[]]>([
    ['self-test passed', [codexAdapter, info(), 'full', {}, paths], 'own', []],
    ['own does not depend on the level', [codexAdapter, info(), 'none', {}, paths], 'own', []],
    ['self-test failed', [codexAdapter, info({ missing: ['codex_selftest'] }), 'full', {}, paths], 'none', ['codex_selftest']],
    ['network on', [codexAdapter, info(), 'full', { codex: { network: true } }, paths], 'none', ['codex_network']],
    // 开着网络探测时没跑自检,关掉之后不能当作通过
    ['network turned off after a detection that skipped the self-test', [codexAdapter, info({ missing: ['codex_network'] }), 'full', {}, paths], 'none', ['codex_network', 'codex_selftest']],
    ['not installed', [codexAdapter, info({ installed: false, missing: ['not_installed'] }), 'full', {}, paths], 'none', ['not_installed']],
    ['glob in cwd', [codexAdapter, info(), 'full', {}, { ...paths, cwd: '/w/re[p]o' }], 'none', ['codex_path_glob']],
    ['glob in a deny root', [codexAdapter, info(), 'full', {}, { ...paths, denyRead: ['/h/a*b'] }], 'none', ['codex_path_glob']],
    ['glob in a rule path', [codexAdapter, info(), 'full', {}, { ...paths, readOnlyPaths: ['/w/repo/src/[a]'] }], 'none', ['codex_path_glob']],
    ['no paths yet (detection itself)', [codexAdapter, info(), 'full', {}, undefined], 'own', []],
    ['wrap, full', [qoderAdapter, info({ id: 'qoder' }), 'full', {}, paths], 'wrapped', []],
    ['wrap, partial', [qoderAdapter, info({ id: 'qoder' }), 'partial', {}, paths], 'wrapped', []],
    ['wrap, none', [qoderAdapter, info({ id: 'qoder' }), 'none', {}, paths], 'none', []],
    ['wrap ignores glob paths: Seatbelt takes them literally', [qoderAdapter, info({ id: 'qoder' }), 'full', {}, { ...paths, cwd: '/w/re[p]o' }], 'wrapped', []],
  ])('%s', (_n, args, isolation, missing) => {
    expect(isolationOf(...args)).toEqual({ isolation, missing })
  })

  it('keeps earlier missing codes', () => {
    expect(isolationOf(codexAdapter, info({ missing: ['codex_selftest'] }), 'full', { codex: { network: true } }, paths)).toEqual({ isolation: 'none', missing: ['codex_selftest', 'codex_network'] })
  })
})

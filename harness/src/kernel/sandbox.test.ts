import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createGit } from '../lib/git/snapshot'
import { parseRule, type Rule } from '../lib/permissions/rules'
import { runCli } from '../lib/proc/runCli'
import type { DetectResult } from '../lib/sandbox/detect'
import { startProxy } from '../lib/sandbox/net/proxy'
import type { ExecPlanOpts, SandboxService } from '../lib/tools/types'
import type { PermissionsConfig } from '../protocol/index'
import { createKernel, type Kernel } from './kernel'
import type { Plugin } from './pluginHost'
import { createSandboxService, sessionTmpDir, wipeSessionTmp, type SandboxOpts } from './sandbox'

let root: string
let home: string
let dataDir: string
let repo: string
let gitEnvFile: string
const closers: (() => Promise<void>)[] = []

const gitTestEnv = () => ({ PATH: process.env.PATH ?? '', HOME: home, GIT_CONFIG_GLOBAL: gitEnvFile, GIT_CONFIG_NOSYSTEM: '1' })
const testGit = () => createGit({ base: { PATH: process.env.PATH ?? '', HOME: home }, extraEnv: { GIT_CONFIG_GLOBAL: gitEnvFile, GIT_CONFIG_NOSYSTEM: '1' } })

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'mffai-sbx-')))
  home = join(root, 'home')
  dataDir = join(root, 'data')
  repo = join(home, 'repo')
  gitEnvFile = join(root, 'gitconfig')
  writeFileSync(gitEnvFile, '')
  mkdirSync(join(home, '.ssh'), { recursive: true })
  mkdirSync(join(repo, 'sub'), { recursive: true })
  mkdirSync(dataDir)
  execFileSync('git', ['init', '-q', repo], { env: gitTestEnv() })
})
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c().catch(() => {})
  rmSync(root, { recursive: true, force: true })
})

const cfg = (over: Partial<PermissionsConfig> = {}, sandbox: Partial<PermissionsConfig['sandbox']> = {}): PermissionsConfig => ({
  rules: [], network: { allow: [] }, allowUnsandboxedAuto: false, ...over, sandbox: { enabled: true, allowLoopback: false, ...sandbox },
})

type Appended = { type: string; sessionId?: string; payload: unknown }
function service(over: Partial<Omit<SandboxOpts, 'rules'>> & { config?: () => PermissionsConfig; rules?: () => Rule[] } = {}) {
  const appended: Appended[] = []
  let config = over.config ?? (() => cfg())
  const svc = createSandboxService({
    platform: 'darwin',
    dataDir,
    home,
    env: { HOME: home, PATH: process.env.PATH },
    detected: { level: 'full', missing: [] },
    permissions: () => config(),
    rules: () => [],
    append: e => appended.push(e),
    git: testGit(),
    upstream: undefined,
    ...over,
  })
  closers.push(() => svc.close())
  return { svc, appended, setConfig: (c: () => PermissionsConfig) => { config = c } }
}

const session = (sid = 's1', cwd = join(repo, 'sub')) => ({ sessionId: sid, cwd, spillDir: join(dataDir, 'sessions', sid, 'spill') })
const baseEnv = { PATH: '/usr/bin:/bin', HOME: '/h', HTTPS_PROXY: 'http://alice:s3cret@corp.example:8080', MFFAI: '1' }
const profileOf = (args: string[]) => args[1]
const q = (s: string) => JSON.stringify(s)

function canConnect(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const s = connect({ host: '127.0.0.1', port })
    s.once('connect', () => { s.destroy(); resolve(true) })
    s.once('error', () => resolve(false))
  })
}
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
const portOf = (env: NodeJS.ProcessEnv) => Number(/:(\d+)$/.exec(env.HTTPS_PROXY ?? '')?.[1])

function connectStatus(port: number, target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = connect({ host: '127.0.0.1', port }, () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`))
    let buf = ''
    s.on('data', d => {
      buf += d.toString()
      if (buf.includes('\r\n')) { s.destroy(); resolve(buf.split('\r\n')[0]) }
    })
    s.on('error', reject)
  })
}

describe('sandbox status', () => {
  it('reports the detected level; autoDegraded only at none without allowUnsandboxedAuto', () => {
    expect(service().svc.status()).toEqual({ level: 'full', missing: [], autoDegraded: false })
    expect(service({ detected: { level: 'none', missing: ['sandbox-exec'] } }).svc.status()).toEqual({ level: 'none', missing: ['sandbox-exec'], autoDegraded: true })
    expect(service({ detected: { level: 'none', missing: ['platform'] }, config: () => cfg({ allowUnsandboxedAuto: true }) }).svc.status())
      .toEqual({ level: 'none', missing: ['platform'], autoDegraded: false })
    expect(service({ detected: { level: 'partial', missing: ['netns'] }, platform: 'linux' }).svc.status()).toEqual({ level: 'partial', missing: ['netns'], autoDegraded: false })
  })

  it('sandbox.enabled:false → none + disabled, read live from the config', () => {
    const s = service()
    s.setConfig(() => cfg({}, { enabled: false }))
    expect(s.svc.status()).toEqual({ level: 'none', missing: ['disabled'], autoDegraded: true })
    s.setConfig(() => cfg())
    expect(s.svc.status().level).toBe('full')
  })

  it('allowLoopback on darwin → partial + loopback; on linux the status is unchanged', () => {
    expect(service({ config: () => cfg({}, { allowLoopback: true }) }).svc.status()).toEqual({ level: 'partial', missing: ['loopback'], autoDegraded: false })
    expect(service({ platform: 'linux', config: () => cfg({}, { allowLoopback: true }) }).svc.status()).toEqual({ level: 'full', missing: [], autoDegraded: false })
  })
})

describe('sandbox plan (darwin)', () => {
  it('level none → the unsandboxed plan: command as file, base env untouched, no tmp dir', async () => {
    const { svc } = service({ detected: { level: 'none', missing: ['sandbox-exec'] } })
    const p = await svc.plan('echo hi', session(), baseEnv)
    expect(p).toMatchObject({ file: 'echo hi', args: [], sandboxed: false, level: 'none' })
    expect(p.env).toEqual(baseEnv)
    p.release()
    expect(existsSync(sessionTmpDir(dataDir, 's1'))).toBe(false)
  })

  it('full → sandbox-exec with the profile; tmp exists 0700; profile has cwd, tmp and the gitDir of a repo subdir cwd', async () => {
    const { svc } = service()
    const s = session()
    const p = await svc.plan('echo hi', s, baseEnv)
    expect(p.file).toBe('/usr/bin/sandbox-exec')
    expect(p.sandboxed).toBe(true)
    expect(p.level).toBe('full')
    expect(p.args[0]).toBe('-p')
    expect(p.args.slice(2)).toEqual(['/bin/sh', '-c', 'echo hi'])
    const tmp = sessionTmpDir(dataDir, 's1')
    expect(statSync(tmp).isDirectory()).toBe(true)
    expect(statSync(tmp).mode & 0o777).toBe(0o700)
    const prof = profileOf(p.args)
    for (const x of [s.cwd, tmp, join(repo, '.git')]) expect(prof).toContain(q(x))
    expect(prof).toMatch(new RegExp(`\\(allow file-write\\* \\(subpath ${q(s.cwd).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
    // 凭据与数据目录拒读,spill 与 tmp 放回
    expect(prof).toContain(`(subpath ${q(join(home, '.ssh'))})`)
    expect(prof).toContain(`(subpath ${q(dataDir)})`)
    expect(prof).toMatch(/\(allow file-read\* .*\(subpath "[^"]*\/sessions\/s1\/spill"\)/)
    p.release()
  })

  it('env: TMPDIR, caches, HTTPS_PROXY = the session proxy port (also in the profile), NODE_USE_ENV_PROXY, empty NO_PROXY, no user userinfo', async () => {
    const { svc } = service()
    const p = await svc.plan('true', session(), baseEnv)
    const tmp = sessionTmpDir(dataDir, 's1')
    expect(p.env.TMPDIR).toBe(tmp)
    for (const k of ['npm_config_cache', 'npm_config_store_dir', 'YARN_CACHE_FOLDER', 'BUN_INSTALL_CACHE_DIR', 'PIP_CACHE_DIR', 'UV_CACHE_DIR', 'XDG_CACHE_HOME', 'GOCACHE', 'GOMODCACHE', 'CARGO_HOME']) {
      expect(p.env[k]!.startsWith(`${tmp}/`), k).toBe(true)
    }
    const port = portOf(p.env)
    expect(port).toBeGreaterThan(0)
    expect(p.env.HTTPS_PROXY).toBe(`http://127.0.0.1:${port}`)
    expect(p.env.NODE_USE_ENV_PROXY).toBe('1')
    expect(p.env.NO_PROXY).toBe('')
    expect(p.env.MFFAI_SANDBOX).toBe('full')
    expect(JSON.stringify(p.env)).not.toContain('s3cret')
    expect(JSON.stringify(p.env)).not.toContain('alice')
    expect(profileOf(p.args)).toContain(`(remote ip ${q(`localhost:${port}`)})`)
    expect(await canConnect(port)).toBe(true)
    p.release()
  })

  it('allowLoopback on darwin: NO_PROXY lists loopback, the profile opens localhost:*, MFFAI_SANDBOX=partial', async () => {
    const { svc } = service({ config: () => cfg({}, { allowLoopback: true }) })
    const p = await svc.plan('true', session(), baseEnv)
    expect(p.env.NO_PROXY).toBe('localhost,127.0.0.1,::1')
    expect(p.env.MFFAI_SANDBOX).toBe('partial')
    expect(p.level).toBe('partial')
    expect(profileOf(p.args)).toContain('(allow network-outbound (remote ip "localhost:*"))')
    p.release()
  })

  it('reuses one proxy per session; another session gets its own', async () => {
    const { svc } = service()
    const a = await svc.plan('true', session('s1'), baseEnv)
    const b = await svc.plan('true', session('s1'), baseEnv)
    const c = await svc.plan('true', session('s2'), baseEnv)
    expect(portOf(a.env)).toBe(portOf(b.env))
    expect(portOf(c.env)).not.toBe(portOf(a.env))
    for (const p of [a, b, c]) p.release()
  })

  it('an idle proxy closes; a running (unreleased) command keeps it open past the idle time', async () => {
    const { svc } = service({ idleMs: 120 })
    const p = await svc.plan('true', session(), baseEnv)
    const port = portOf(p.env)
    await wait(400)
    expect(await canConnect(port)).toBe(true) // 命令还在跑
    p.release()
    await wait(400)
    expect(await canConnect(port)).toBe(false)
    // 关掉之后再 plan:起一个新的
    const p2 = await svc.plan('true', session(), baseEnv)
    expect(await canConnect(portOf(p2.env))).toBe(true)
    p2.release()
  })

  it('release is idempotent (a double release does not let another running command lose its proxy)', async () => {
    const { svc } = service({ idleMs: 120 })
    const a = await svc.plan('true', session(), baseEnv)
    const b = await svc.plan('true', session(), baseEnv)
    a.release()
    a.release()
    await wait(400)
    expect(await canConnect(portOf(b.env))).toBe(true)
    b.release()
  })

  it('close() closes every proxy', async () => {
    const { svc } = service()
    const a = await svc.plan('true', session('s1'), baseEnv)
    const b = await svc.plan('true', session('s2'), baseEnv)
    await svc.close()
    expect(await canConnect(portOf(a.env))).toBe(false)
    expect(await canConnect(portOf(b.env))).toBe(false)
  })

  it('proxy start failure → no proxy port (network fully off) and status partial + proxy; a later success clears it', async () => {
    let fail = true
    const { svc } = service({ startProxy: async o => { if (fail) throw new Error('EADDRINUSE'); return startProxy(o) } })
    const p = await svc.plan('true', session(), baseEnv)
    expect(p.sandboxed).toBe(true)
    expect(p.env.HTTPS_PROXY).toBeUndefined()
    expect(p.env.NODE_USE_ENV_PROXY).toBeUndefined()
    expect(profileOf(p.args)).not.toContain('network-outbound')
    expect(p.level).toBe('partial')
    expect(svc.status('s1')).toEqual({ level: 'partial', missing: ['proxy'], autoDegraded: false })
    expect(svc.status()).toEqual({ level: 'full', missing: [], autoDegraded: false }) // 不带会话:不受某个会话的代理影响
    p.release()
    expect(svc.status('s1')).toEqual({ level: 'partial', missing: ['proxy'], autoDegraded: false }) // 命令结束后仍如实报
    fail = false
    const p2 = await svc.plan('true', session(), baseEnv)
    expect(portOf(p2.env)).toBeGreaterThan(0)
    expect(svc.status('s1')).toEqual({ level: 'full', missing: [], autoDegraded: false }) // 本会话下次启动成功就清掉
    p2.release()
  })

  it('denied CONNECTs append sandbox.netDenied once per host:port per turn', async () => {
    let turn = 't1'
    const { svc, appended } = service({ currentTurn: () => turn })
    const p = await svc.plan('true', session(), baseEnv)
    const port = portOf(p.env)
    expect(await connectStatus(port, 'evil.example:443')).toMatch(/^HTTP\/1\.1 403/)
    expect(await connectStatus(port, 'evil.example:443')).toMatch(/^HTTP\/1\.1 403/)
    expect(await connectStatus(port, 'evil.example:8443')).toMatch(/^HTTP\/1\.1 403/)
    turn = 't2'
    expect(await connectStatus(port, 'evil.example:443')).toMatch(/^HTTP\/1\.1 403/)
    const denied = appended.filter(e => e.type === 'sandbox.netDenied')
    expect(denied).toEqual([
      { type: 'sandbox.netDenied', sessionId: 's1', payload: { host: 'evil.example', port: 443, reason: 'not_allowed' } },
      { type: 'sandbox.netDenied', sessionId: 's1', payload: { host: 'evil.example', port: 8443, reason: 'not_allowed' } },
      { type: 'sandbox.netDenied', sessionId: 's1', payload: { host: 'evil.example', port: 443, reason: 'not_allowed' } },
    ])
    p.release()
  })

  it('M3: a secret encoded into the denied host is redacted in sandbox.netDenied', async () => {
    const { svc, appended } = service()
    const p = await svc.plan('true', session(), baseEnv)
    expect(await connectStatus(portOf(p.env), 'sk-abcdefghijklmnopqrstuvwxyz.evil.example:443')).toMatch(/^HTTP\/1\.1 403/)
    const denied = appended.filter(e => e.type === 'sandbox.netDenied').map(e => e.payload)
    expect(denied).toEqual([{ host: '***.evil.example', port: 443, reason: 'not_allowed' }])
    expect(JSON.stringify(appended)).not.toContain('abcdefghijklmnop')
    p.release()
  })

  it('deny lists come from the env snapshot: a `..` credential var is dropped in favour of its resolved form and plan still works', async () => {
    mkdirSync(join(home, 'x'))
    const { svc } = service({ env: { HOME: home, GNUPGHOME: `${home}/x/../.gnupg`, DOCKER_CONFIG: join(root, 'docker') } })
    const p = await svc.plan('true', session(), baseEnv)
    const prof = profileOf(p.args)
    expect(prof).toContain(q(join(home, '.gnupg')))
    expect(prof).toContain(q(join(root, 'docker')))
    expect(prof).not.toContain('/../')
    p.release()
  })

  it('the deny lists never read process.env', async () => {
    const before = process.env.DOCKER_CONFIG
    process.env.DOCKER_CONFIG = join(root, 'from-process-env')
    try {
      const { svc } = service()
      const p = await svc.plan('true', session(), baseEnv)
      expect(profileOf(p.args)).not.toContain('from-process-env')
      p.release()
    } finally {
      if (before === undefined) delete process.env.DOCKER_CONFIG
      else process.env.DOCKER_CONFIG = before
    }
  })

  it('moveBlock covers credential roots and their ancestors inside the writable cwd (cwd = HOME)', async () => {
    mkdirSync(join(home, 'nest', 'deep'), { recursive: true })
    const { svc } = service({ env: { HOME: home, GNUPGHOME: join(home, 'nest', 'deep', 'gpg') } })
    const p = await svc.plan('true', session('s1', home), baseEnv)
    const prof = profileOf(p.args)
    const block = prof.split('\n').find(l => l.startsWith('(deny file-write-unlink file-write-create'))!
    for (const x of [join(home, '.ssh'), join(home, 'nest', 'deep', 'gpg'), join(home, 'nest', 'deep'), join(home, 'nest'), join(home, '.zshrc')]) {
      expect(block, x).toContain(`(literal ${q(x)})`)
    }
    expect(block).toContain(`(literal ${q(home)})`) // 可写根本身也不能挪(04 Task 7 评审 C1)
    expect(block).not.toContain(`(literal ${q(root)})`) // 根以外的父目录本来就写不了
    p.release()
  })

  it('a profile generator throw fails the plan (never an unsandboxed fallback)', async () => {
    const { svc } = service()
    const bad = join(root, 'bad\u0001dir')
    await expect(svc.plan('true', session('s1', bad), baseEnv)).rejects.toThrow(/control characters/)
  })

  it('looks the gitDir up once per session', async () => {
    let calls = 0
    const g = testGit()
    const { svc } = service({ git: (a, o) => { calls++; return g(a, o) } })
    for (let i = 0; i < 3; i++) (await svc.plan('true', session(), baseEnv)).release()
    const once = calls
    expect(once).toBeGreaterThan(0)
    ;(await svc.plan('true', session('s2'), baseEnv)).release()
    expect(calls).toBe(once * 2)
  })

  it('a worktree cwd: the common gitDir is writable and the cwd .git file is protected', async () => {
    execFileSync('git', ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'i'], { env: { ...gitTestEnv(), GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@x', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@x' } })
    const wt = join(home, 'wt')
    execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', wt], { env: gitTestEnv() })
    const { svc } = service()
    const p = await svc.plan('true', session('s1', wt), baseEnv)
    const prof = profileOf(p.args)
    expect(prof).toMatch(new RegExp(`\\(allow file-write\\* [^\\n]*\\(subpath ${q(join(repo, '.git')).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`))
    expect(prof).toContain(`(literal ${q(join(wt, '.git'))})`)
    p.release()
  })
})

describe('gitDir lookup fallbacks (review I1, M6)', () => {
  /** git < 2.5:未知参数原样回显、退出 0 */
  const echoGit = (calls: { n: number }) => (async (args: string[]) => {
    calls.n++
    return { code: 0, stdout: Buffer.from(args.slice(1).join('\n') + '\n'), stderr: '' }
  }) as never
  const brokenGit = (calls: { n: number }) => (async () => { calls.n++; throw new Error('spawn git ENOENT') }) as never

  it('no --path-format: a relative --git-common-dir answer is resolved against cwd', async () => {
    const seen: string[][] = []
    const g = testGit()
    const { svc } = service({ git: (a, o) => { seen.push(a); return g(a, o) } })
    const p = await svc.plan('true', session(), baseEnv)
    expect(seen.flat()).not.toContain('--path-format=absolute')
    expect(profileOf(p.args)).toContain(`(subpath ${q(join(repo, '.git'))})`)
    p.release()
  })

  it('a git that echoes the flag back (too old) → walk up from cwd and find .git; the miss is not cached', async () => {
    const calls = { n: 0 }
    const { svc } = service({ git: echoGit(calls) })
    const p = await svc.plan('true', session(), baseEnv)
    expect(profileOf(p.args)).toMatch(new RegExp(`\\(allow file-write\\* [^\\n]*\\(subpath ${q(join(repo, '.git')).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`))
    p.release()
    const before = calls.n
    ;(await svc.plan('true', session(), baseEnv)).release()
    expect(calls.n).toBeGreaterThan(before)
  })

  it('git missing → walk fallback; on linux the hooks dir is still ro-bound', async () => {
    rmSync(join(repo, '.git', 'hooks'), { recursive: true, force: true })
    const calls = { n: 0 }
    const { svc } = service({ platform: 'linux', detected: { level: 'partial', missing: ['netns'], bwrap: '/usr/bin/bwrap' }, git: brokenGit(calls) })
    const p = await svc.plan('true', session(), baseEnv)
    const hooks = join(repo, '.git', 'hooks')
    const i = p.args.findIndex((x, k) => x === '--ro-bind' && p.args[k + 1] === hooks)
    expect(i).toBeGreaterThan(0)
    p.release()
    ;(await svc.plan('true', session(), baseEnv)).release()
    expect(calls.n).toBe(2) // 失败不缓存
  })

  it('walk fallback understands a worktree .git file (gitdir + commondir)', async () => {
    execFileSync('git', ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'i'], { env: { ...gitTestEnv(), GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@x', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@x' } })
    const wt = join(home, 'wt')
    execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', wt], { env: gitTestEnv() })
    const { svc } = service({ git: brokenGit({ n: 0 }) })
    const p = await svc.plan('true', session('s1', wt), baseEnv)
    expect(profileOf(p.args)).toContain(`(literal ${q(join(wt, '.git'))})`)
    expect(profileOf(p.args)).toContain(`(subpath ${q(join(repo, '.git', 'hooks'))})`)
    p.release()
  })

  it('a .git that cannot be resolved fails the plan closed', async () => {
    const odd = join(home, 'odd')
    mkdirSync(join(odd, 'sub'), { recursive: true })
    writeFileSync(join(odd, '.git'), 'not a gitdir line\n')
    const { svc } = service({ git: brokenGit({ n: 0 }) })
    await expect(svc.plan('true', session('s1', join(odd, 'sub')), baseEnv)).rejects.toThrow(/can't resolve the git dir/)
  })

  it('not a repo (git says so, no .git anywhere) → cached as no gitDir', async () => {
    const plain = join(root, 'plain')
    mkdirSync(plain)
    let n = 0
    const g = testGit()
    const { svc } = service({ git: (a, o) => { n++; return g(a, o) } })
    for (let i = 0; i < 3; i++) (await svc.plan('true', session('s1', plain), baseEnv)).release()
    expect(n).toBe(1)
  })

  it('the darwin moveBlock includes the gitDir modules and worktrees dirs', async () => {
    const { svc } = service()
    const p = await svc.plan('true', session(), baseEnv)
    const block = profileOf(p.args).split('\n').find(l => l.startsWith('(deny file-write-unlink file-write-create'))!
    for (const x of ['modules', 'worktrees']) expect(block).toContain(`(literal ${q(join(repo, '.git', x))})`)
    p.release()
  })
})

describe('submodule git dirs (re-review C1)', () => {
  /** 假的子模块 git 目录:HEAD + config + objects + hooks */
  function fakeModule(rel: string) {
    const m = join(repo, '.git', 'modules', ...rel.split('/'))
    mkdirSync(join(m, 'objects', 'pack'), { recursive: true })
    mkdirSync(join(m, 'hooks'), { recursive: true })
    writeFileSync(join(m, 'HEAD'), 'ref: refs/heads/main\n')
    writeFileSync(join(m, 'config'), '[core]\n')
    return m
  }
  const blockLine = (prof: string) => prof.split('\n').find(l => l.startsWith('(deny file-write-unlink file-write-create'))!

  it('darwin: each module gitDir (slash names, nested) and the dirs between it and modules are move-blocked; hooks/config write-denied', async () => {
    const lib = fakeModule('vendor/lib')
    const top = fakeModule('top')
    const inner = fakeModule('top/modules/inner')
    const { svc } = service()
    const p = await svc.plan('true', session(), baseEnv)
    const prof = profileOf(p.args)
    const block = blockLine(prof)
    for (const x of [lib, join(repo, '.git', 'modules', 'vendor'), top, inner, join(top, 'modules'), join(lib, 'hooks'), join(lib, 'config')]) expect(block, x).toContain(`(literal ${q(x)})`)
    // objects 里不往下走,也不把它当成要挡的目录
    expect(block).not.toContain(q(join(lib, 'objects')))
    const writeDeny = prof.split('\n').find(l => l.startsWith('(deny file-write* '))!
    for (const m of [lib, top, inner]) {
      expect(writeDeny).toContain(`(subpath ${q(join(m, 'hooks'))})`)
      expect(writeDeny).toContain(`(subpath ${q(join(m, 'config'))})`)
    }
    p.release()
  })

  it('linux: module hooks and config are ro-bound', async () => {
    const lib = fakeModule('vendor/lib')
    const { svc } = service({ platform: 'linux', detected: { level: 'partial', missing: ['netns'], bwrap: '/usr/bin/bwrap' } })
    const p = await svc.plan('true', session(), baseEnv)
    for (const f of ['hooks', 'config']) {
      const x = join(lib, f)
      expect(p.args.some((a, k) => a === '--ro-bind' && p.args[k + 1] === x && p.args[k + 2] === x), x).toBe(true)
    }
    p.release()
  })

  it('only config identifies a module; recognising one never stops the descent (re-review R2)', async () => {
    const lib = fakeModule('vendor/lib')
    const vendor = join(repo, '.git', 'modules', 'vendor')
    writeFileSync(join(vendor, 'HEAD'), 'ref: refs/heads/x\n') // 伪造的 HEAD + objects:不算
    mkdirSync(join(vendor, 'objects'))
    const outer = fakeModule('outer')
    const deep = fakeModule('outer/sub/deep') // 在一个已认出的 git 目录里,但不在它的 modules 下
    const { svc } = service()
    const p = await svc.plan('true', session(), baseEnv)
    const block = blockLine(profileOf(p.args))
    for (const x of [lib, outer, deep, join(outer, 'sub')]) expect(block, x).toContain(`(literal ${q(x)})`)
    const writeDeny = profileOf(p.args).split('\n').find(l => l.startsWith('(deny file-write* '))!
    expect(writeDeny).not.toContain(`(subpath ${q(join(vendor, 'hooks'))})`) // vendor 不是 git 目录
    expect(writeDeny).toContain(`(subpath ${q(join(deep, 'hooks'))})`)
    p.release()
  })

  it('objects, refs and logs are not walked (no cap hit for a big module)', async () => {
    const m = fakeModule('big')
    for (const d of ['objects', 'refs', 'logs']) for (let i = 0; i < 120; i++) mkdirSync(join(m, d, `x${i}`), { recursive: true })
    const { svc } = service()
    const p = await svc.plan('true', session(), baseEnv)
    expect(blockLine(profileOf(p.args))).toContain(`(literal ${q(m)})`)
    p.release()
  })

  it('more than 2000 candidate directories under modules → the plan fails closed', async () => {
    for (let i = 0; i < 2001; i++) mkdirSync(join(repo, '.git', 'modules', `d${i}`), { recursive: true })
    const { svc } = service()
    await expect(svc.plan('true', session(), baseEnv)).rejects.toThrow(/more than 2000 directories/)
  })

  it('a module named vendor/logs (logs / refs / objects below the top level) is recognised and protected (final review I1)', async () => {
    const logs = fakeModule('vendor/logs')
    const refs = fakeModule('a/refs')
    const objs = fakeModule('b/objects/c')
    const { svc } = service()
    const p = await svc.plan('true', session(), baseEnv)
    const prof = profileOf(p.args)
    const block = blockLine(prof)
    for (const x of [logs, join(repo, '.git', 'modules', 'vendor'), refs, objs, join(repo, '.git', 'modules', 'b', 'objects')]) expect(block, x).toContain(`(literal ${q(x)})`)
    const writeDeny = prof.split('\n').find(l => l.startsWith('(deny file-write* '))!
    for (const m of [logs, refs, objs]) for (const f of ['hooks', 'config']) expect(writeDeny).toContain(`(subpath ${q(join(m, f))})`)
    p.release()
  })

  it('linux: the hooks and config of a module named vendor/logs are ro-bound (final review I1)', async () => {
    const logs = fakeModule('vendor/logs')
    const { svc } = service({ platform: 'linux', detected: { level: 'partial', missing: ['netns'], bwrap: '/usr/bin/bwrap' } })
    const p = await svc.plan('true', session(), baseEnv)
    for (const f of ['hooks', 'config']) {
      const x = join(logs, f)
      expect(p.args.some((a, k) => a === '--ro-bind' && p.args[k + 1] === x && p.args[k + 2] === x), x).toBe(true)
    }
    p.release()
  })

  it('logs / refs / objects are skipped only directly inside a recognised git dir', async () => {
    const m = fakeModule('m')
    mkdirSync(join(m, 'logs', 'refs'), { recursive: true })
    writeFileSync(join(m, 'logs', 'config'), '[core]\n') // m 自己的 logs:不走,里面的 config 不算
    const { svc } = service()
    const p = await svc.plan('true', session(), baseEnv)
    const block = blockLine(profileOf(p.args))
    expect(block).toContain(`(literal ${q(m)})`)
    expect(block).not.toContain(q(join(m, 'logs')))
    p.release()
  })

  it('dirs under a recognised git dir\'s info / hooks / lfs / branches are not counted (final review M1)', async () => {
    const m = fakeModule('m')
    for (const d of ['info', 'hooks', 'lfs', 'branches']) for (let i = 0; i < 600; i++) mkdirSync(join(m, d, `x${i}`), { recursive: true })
    // 60 个子模块,各带 hooks / info / lfs / branches:远低于上限
    for (let i = 0; i < 60; i++) {
      const s = fakeModule(`s${i}`)
      for (const d of ['info', 'lfs/objects', 'branches']) mkdirSync(join(s, d), { recursive: true })
    }
    const { svc } = service()
    const p = await svc.plan('true', session(), baseEnv)
    const block = blockLine(profileOf(p.args))
    expect(block).toContain(`(literal ${q(m)})`)
    expect(block).toContain(`(literal ${q(join(repo, '.git', 'modules', 's59'))})`)
    p.release()
  })

  it('a real submodule gitDir with many object dirs stays under the cap', async () => {
    const m = fakeModule('big')
    for (let i = 0; i < 256; i++) mkdirSync(join(m, 'objects', i.toString(16).padStart(2, '0')))
    const { svc } = service()
    const p = await svc.plan('true', session(), baseEnv)
    expect(blockLine(profileOf(p.args))).toContain(`(literal ${q(m)})`)
    p.release()
  })
})

describe('proxy bookkeeping (review M3, M5, M8)', () => {
  it('concurrent plans of one session share one proxy start', async () => {
    let starts = 0
    const { svc } = service({ startProxy: async o => { starts++; return startProxy(o) } })
    const [a, b] = await Promise.all([svc.plan('true', session(), baseEnv), svc.plan('true', session(), baseEnv)])
    expect(starts).toBe(1)
    expect(portOf(a.env)).toBe(portOf(b.env))
    a.release()
    b.release()
  })

  it('the proxy-failure flag is per session: another session stays full', async () => {
    let cur = 's1'
    const { svc } = service({ startProxy: async o => { if (cur === 's1') throw new Error('x'); return startProxy(o) } })
    const p1 = await svc.plan('true', session('s1'), baseEnv)
    cur = 's2'
    const p2 = await svc.plan('true', session('s2'), baseEnv)
    expect(p1.level).toBe('partial')
    expect(p1.env.HTTPS_PROXY).toBeUndefined()
    expect(p2.level).toBe('full')
    expect(portOf(p2.env)).toBeGreaterThan(0)
    expect(svc.status('s1')).toEqual({ level: 'partial', missing: ['proxy'], autoDegraded: false })
    expect(svc.status('s2')).toEqual({ level: 'full', missing: [], autoDegraded: false }) // re-review N1:别的会话不受影响
    expect(svc.status()).toEqual({ level: 'full', missing: [], autoDegraded: false })
    p1.release()
    p2.release()
  })

  it('a config change during the plan awaits does not relabel the plan (level is taken once)', async () => {
    const g = testGit()
    let flip = false
    const svc2 = createSandboxService({
      platform: 'darwin', dataDir, home, env: { HOME: home }, detected: { level: 'full', missing: [] },
      permissions: () => (flip ? cfg({}, { enabled: false }) : cfg()), rules: () => [], append: () => {},
      git: async (a, o) => { flip = true; return g(a, o) },
    })
    closers.push(() => svc2.close())
    const p = await svc2.plan('true', session(), baseEnv)
    expect(p.sandboxed).toBe(true)
    expect(p.level).toBe('full')
    expect(p.env.MFFAI_SANDBOX).toBe('full')
    p.release()
  })

  it('a session whose proxy idled out is forgotten (git looked up again next time)', async () => {
    let n = 0
    const g = testGit()
    const { svc } = service({ idleMs: 80, git: (a, o) => { n++; return g(a, o) } })
    ;(await svc.plan('true', session(), baseEnv)).release()
    const once = n
    await wait(300)
    ;(await svc.plan('true', session(), baseEnv)).release()
    expect(n).toBe(once * 2)
  })
})

describe('planExec', () => {
  const FILE = '/opt/q/qodercli'
  const ARGS = ['-p', "it's $HOME", '--flag']
  const QUOTED = "'/opt/q/qodercli' '-p' 'it'\\''s $HOME' '--flag'"
  const qoder = () => join(home, '.qoder')
  const auth = () => join(qoder(), '.auth')
  const logs = () => join(qoder(), 'logs')
  const opts = (over: Partial<ExecPlanOpts> = {}): ExecPlanOpts => ({
    allowRead: [auth()], allowWrite: [auth(), logs()], allowHosts: ['*.qoder.sh'], proxyScope: 'run_1', readOnly: false, denyRead: [], denyWrite: [], ...over,
  })
  const LINUX: Partial<SandboxOpts> = { platform: 'linux', detected: { level: 'partial', missing: ['netns'], bwrap: '/usr/bin/bwrap' } }
  /** SBPL 的 subpath 规则:每条 {action, ops, paths},按配置里的顺序 */
  const profileRules = (profile: string) =>
    profile.split('\n').flatMap(line => {
      const m = /^\((allow|deny) (file-[a-z*\- ]+) (.*)\)$/.exec(line)
      if (!m) return []
      return [{ action: m[1], ops: m[2], subpaths: [...m[3].matchAll(/\(subpath ("(?:[^"\\]|\\.)*")\)/g)].map(x => JSON.parse(x[1]) as string), literals: [...m[3].matchAll(/\(literal ("(?:[^"\\]|\\.)*")\)/g)].map(x => JSON.parse(x[1]) as string) }]
    })
  const lastWord = (profile: string, path: string, ops: string) =>
    profileRules(profile).filter(r => r.ops.startsWith(ops) && r.subpaths.includes(path)).at(-1)?.action

  beforeEach(() => {
    mkdirSync(auth(), { recursive: true })
    mkdirSync(logs(), { recursive: true })
  })

  it('level none: file and args as given, not a shell string; env untouched; no proxy', async () => {
    const started: unknown[] = []
    const { svc } = service({ config: () => cfg({}, { enabled: false }), startProxy: async o => { started.push(o); throw new Error('no proxy at level none') } })
    const env = { PATH: '/usr/bin', HTTPS_PROXY: 'http://x' }
    const p = await svc.planExec(FILE, ARGS, session(), env, opts())
    expect(p).toMatchObject({ file: FILE, args: ARGS, sandboxed: false, level: 'none' })
    expect(p.env).toBe(env)
    expect(started).toEqual([])
    p.release()
  })

  it('level none: runCli runs it without a shell, so $ and spaces stay literal', async () => {
    const { svc } = service({ config: () => cfg({}, { enabled: false }) })
    const p = await svc.planExec('/bin/echo', ['$HOME', 'a  b', '; touch /nope'], session(), { PATH: '/usr/bin:/bin' }, opts())
    const lines: string[] = []
    const r = await runCli(p, { cwd: repo, timeoutMs: 15_000, idleMs: 15_000, signal: new AbortController().signal, onLine: l => lines.push(l) })
    expect(r.code).toBe(0)
    expect(lines).toEqual(['$HOME a  b ; touch /nope'])
  })

  it('darwin: the whole command is quoted, under sh -c in sandbox-exec, with the proxy env', async () => {
    const { svc } = service()
    const p = await svc.planExec(FILE, ARGS, session(), baseEnv, opts())
    expect(p.file).toBe('/usr/bin/sandbox-exec')
    expect(p.args.slice(2)).toEqual(['/bin/sh', '-c', QUOTED])
    expect(p.sandboxed).toBe(true)
    expect(p.env.HTTPS_PROXY).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(p.env.TMPDIR).toBe(sessionTmpDir(dataDir, 's1'))
    p.release()
  })

  it('a relative file is refused: it would be looked up through PATH inside the sandbox', async () => {
    const { svc } = service()
    await expect(svc.planExec('qodercli', [], session(), baseEnv, opts())).rejects.toThrow(/absolute/)
  })

  it.each([['linux'], ['darwin']] as const)('bad input rejects before a proxy starts, never unsandboxed (%s)', async platform => {
    const started: unknown[] = []
    const { svc } = service({ ...(platform === 'linux' ? LINUX : {}), startProxy: async o => { started.push(o); return startProxy(o) } })
    for (const bad of [{ allowWrite: ['rel/path'] }, { allowRead: ['rel/path'] }, { denyRead: [`${home}/a\nb`] }, { denyWrite: [`${home}/a/../b`] }]) {
      await expect(svc.planExec(FILE, ARGS, session(), baseEnv, opts(bad)), JSON.stringify(bad)).rejects.toThrow(/path/)
    }
    await expect(svc.planExec(FILE, ['a\0b'], session(), baseEnv, opts())).rejects.toThrow(/NUL/)
    expect(started).toEqual([])
  })

  it.each([
    ['seatbelt', {} as Partial<SandboxOpts>],
    ['bwrap', { platform: 'linux', detected: { level: 'full', missing: [], bwrap: '/usr/bin/bwrap' } } as Partial<SandboxOpts>],
  ])('a %s profile that throws after the proxy started: rejects, the run proxy closes, nothing runs unsandboxed', async (_name, over) => {
    const closed: string[] = []
    const { svc } = service({
      ...over,
      startProxy: async o => {
        const h = await startProxy(o)
        const close = h.close.bind(h)
        h.close = async () => { closed.push('closed'); await close() }
        return h
      },
    })
    rmSync(auth(), { recursive: true })
    symlinkSync(join(home, '.ssh'), auth())
    await expect(svc.planExec(FILE, ARGS, session(), baseEnv, opts())).rejects.toThrow(/credential/)
    await vi.waitFor(() => expect(closed).toEqual(['closed']))
  })

  it('a bad scope is refused', async () => {
    const { svc } = service()
    for (const proxyScope of ['', 'a\0b', 'a/b']) await expect(svc.planExec(FILE, ARGS, session(), baseEnv, opts({ proxyScope }))).rejects.toThrow(/scope/)
  })

  describe('darwin profile', () => {
    it('allowRead leaves denyRead and is re-allowed; denyWrite keeps it, then re-allows it; others stay denied', async () => {
      const { svc } = service()
      const p = await svc.planExec(FILE, ARGS, session(), baseEnv, opts())
      const profile = profileOf(p.args)
      const read = profileRules(profile).filter(r => r.ops === 'file-read*')
      expect(read.filter(r => r.action === 'deny').flatMap(r => r.subpaths)).not.toContain(auth())
      expect(lastWord(profile, auth(), 'file-read')).toBe('allow')
      expect(lastWord(profile, join(home, '.ssh'), 'file-read')).toBe('deny')
      const denyAt = profileRules(profile).findIndex(r => r.action === 'deny' && r.ops === 'file-write*' && r.subpaths.includes(auth()))
      const allowAt = profileRules(profile).findIndex((r, i) => i > denyAt && r.action === 'allow' && r.ops === 'file-write*' && r.subpaths.includes(auth()))
      expect(denyAt).toBeGreaterThan(-1)
      expect(allowAt).toBeGreaterThan(denyAt)
      expect(lastWord(profile, logs(), 'file-write')).toBe('allow')
      expect(lastWord(profile, join(qoder(), 'bin'), 'file-write')).toBe('deny')
      expect(lastWord(profile, join(qoder(), 'settings.json'), 'file-write')).toBe('deny')
      expect(lastWord(profile, join(qoder(), 'external-commands'), 'file-write')).toBe('deny')
      p.release()
    })

    it('readOnly drops cwd and the git dirs from the writable roots, keeps tmp and allowWrite', async () => {
      const { svc } = service()
      const cwd = join(repo, 'sub')
      const p = await svc.planExec(FILE, ARGS, session(), baseEnv, opts({ readOnly: true }))
      const allow = profileRules(profileOf(p.args)).filter(r => r.action === 'allow' && r.ops === 'file-write*').flatMap(r => r.subpaths)
      expect(allow).not.toContain(cwd)
      expect(allow).not.toContain(join(repo, '.git'))
      expect(allow).toContain(sessionTmpDir(dataDir, 's1'))
      expect(allow).toContain(logs())
      p.release()
    })

    it('readOnly: an allowWrite entry holding cwd is dropped', async () => {
      const { svc } = service()
      const cwd = join(logs(), 'deep')
      mkdirSync(cwd)
      const p = await svc.planExec(FILE, ARGS, session('s1', cwd), baseEnv, opts({ readOnly: true }))
      const allow = profileRules(profileOf(p.args)).filter(r => r.action === 'allow' && r.ops === 'file-write*').flatMap(r => r.subpaths)
      expect(allow).not.toContain(logs())
      expect(allow).toContain(auth())
      p.release()
    })

    it('user rules come after the re-allows, block writes too, and join the move block with their ancestors', async () => {
      const { svc } = service()
      const secret = join(repo, 'sub', 'a', 'secret')
      const gen = join(repo, 'sub', 'b', 'gen')
      const p = await svc.planExec(FILE, ARGS, session(), baseEnv, opts({ denyRead: [secret, auth()], denyWrite: [gen, logs()] }))
      const profile = profileOf(p.args)
      expect(lastWord(profile, auth(), 'file-read')).toBe('deny')
      expect(lastWord(profile, auth(), 'file-write')).toBe('deny')
      expect(lastWord(profile, logs(), 'file-write')).toBe('deny')
      expect(lastWord(profile, secret, 'file-read')).toBe('deny')
      expect(lastWord(profile, secret, 'file-write')).toBe('deny')
      expect(lastWord(profile, gen, 'file-write')).toBe('deny')
      const moved = profileRules(profile).filter(r => r.ops.includes('file-write-unlink')).flatMap(r => r.literals)
      for (const x of [secret, dirname(secret), gen, dirname(gen)]) expect(moved).toContain(x)
      p.release()
    })

    it('a credential nested inside the exemption stays hidden', async () => {
      const nested = join(auth(), 'inner')
      const { svc } = service({ env: { HOME: home, CODEX_HOME: nested } })
      const p = await svc.planExec(FILE, ARGS, session(), baseEnv, opts())
      expect(lastWord(profileOf(p.args), nested, 'file-read')).toBe('deny')
      expect(lastWord(profileOf(p.args), nested, 'file-write')).toBe('deny')
      p.release()
    })

    it('an exemption whose realpath lands in another credential root is refused', async () => {
      const { svc } = service()
      rmSync(auth(), { recursive: true })
      symlinkSync(join(home, '.ssh'), auth())
      await expect(svc.planExec(FILE, ARGS, session(), baseEnv, opts())).rejects.toThrow(/credential/)
    })

    it('an exemption inside a wider credential root is fine: it was named on purpose', async () => {
      const { svc } = service({ env: { HOME: home, QODER_CONFIG_DIR: qoder() } })
      const p = await svc.planExec(FILE, ARGS, session(), baseEnv, opts())
      const profile = profileOf(p.args)
      expect(lastWord(profile, qoder(), 'file-read')).toBe('deny')
      expect(lastWord(profile, auth(), 'file-read')).toBe('allow')
      p.release()
    })

    it('a symlinked allowWrite entry is dropped: replacing ~/.qoder/logs with a link must not widen the run', async () => {
      const { svc } = service()
      rmSync(logs(), { recursive: true })
      symlinkSync(root, logs())
      const p = await svc.planExec(FILE, ARGS, session(), baseEnv, opts())
      const allow = profileRules(profileOf(p.args)).filter(r => r.action === 'allow' && r.ops === 'file-write*').flatMap(r => r.subpaths)
      expect(allow).not.toContain(root)
      expect(allow).not.toContain(logs())
      expect(allow).toContain(auth())
      p.release()
    })

    it('the writable roots and any ancestor inside another root join the move block, in shell plans too; ordinary paths do not (review C1)', async () => {
      const { svc } = service()
      const movedIn = (args: string[]) => profileRules(profileOf(args)).filter(r => r.ops.includes('file-write-unlink')).flatMap(r => r.literals)
      const cwd = join(repo, 'sub')
      const tmp = sessionTmpDir(dataDir, 's1')
      const shell = await svc.plan('true', session(), baseEnv)
      for (const x of [cwd, tmp]) expect(movedIn(shell.args)).toContain(x)
      expect(movedIn(shell.args)).not.toContain(join(cwd, 'file'))
      shell.release()
      const run = await svc.planExec(FILE, ARGS, session(), baseEnv, opts())
      for (const x of [cwd, tmp, auth(), logs()]) expect(movedIn(run.args)).toContain(x)
      run.release()
      // cwd = home:.qoder 不是可写根,但它里面有 logs
      const atHome = await svc.planExec(FILE, ARGS, session('s1', home), baseEnv, opts())
      expect(movedIn(atHome.args)).toContain(qoder())
      atHome.release()
    })

    it('a listed entry that is missing, or dropped as a link, or dropped by readOnly, is still move-blocked (review I1)', async () => {
      const { svc } = service()
      const missing = join(qoder(), 'cache')
      const moved = (args: string[]) => profileRules(profileOf(args)).filter(r => r.ops.includes('file-write-unlink')).flatMap(r => r.literals)
      rmSync(logs(), { recursive: true })
      symlinkSync(root, logs())
      const p = await svc.planExec(FILE, ARGS, session(), baseEnv, opts({ allowWrite: [auth(), logs(), missing] }))
      expect(moved(p.args)).toEqual(expect.arrayContaining([logs(), missing]))
      p.release()
    })

    it('a swap that lands while the proxy starts is seen: the link is refused, its target never writable (review I1)', async () => {
      const target = join(root, 'target')
      mkdirSync(target)
      const { svc } = service({
        startProxy: async o => {
          rmSync(logs(), { recursive: true })
          symlinkSync(target, logs())
          return startProxy(o)
        },
      })
      const p = await svc.planExec(FILE, ARGS, session(), baseEnv, opts())
      const allow = profileRules(profileOf(p.args)).filter(r => r.action === 'allow' && r.ops === 'file-write*').flatMap(r => r.subpaths)
      expect(allow).not.toContain(target)
      expect(allow).not.toContain(logs())
      expect(allow).toContain(auth())
      p.release()
    })

    it('the shell plan is unchanged: empty options leave no exemption, no extra root, no final deny', async () => {
      const { svc } = service()
      const p = await svc.plan('echo hi', session(), baseEnv)
      const profile = profileOf(p.args)
      expect(lastWord(profile, auth(), 'file-read')).toBe('deny')
      expect(lastWord(profile, auth(), 'file-write')).toBe('deny')
      expect(p.args.slice(2)).toEqual(['/bin/sh', '-c', 'echo hi'])
      p.release()
    })
  })

  describe('linux argv', () => {
    const lastIdx = (a: string[], ...seq: string[]) => {
      let out = -1
      for (let i = 0; i + seq.length <= a.length; i++) if (seq.every((s, j) => a[i + j] === s)) out = i
      return out
    }

    it('no --tmpfs on the exemption; it and the other existing subdirectories are bound after the hides; ~/.qoder never', async () => {
      mkdirSync(join(qoder(), 'bin'))
      const { svc } = service(LINUX)
      const p = await svc.planExec(FILE, ARGS, session(), baseEnv, opts({ allowWrite: [auth(), logs(), join(qoder(), 'tmp')] }))
      expect(p.file).toBe('/usr/bin/bwrap')
      expect(lastIdx(p.args, '--tmpfs', auth())).toBe(-1)
      const hides = lastIdx(p.args, '--tmpfs', dataDir)
      expect(hides).toBeGreaterThan(0)
      expect(lastIdx(p.args, '--bind', auth(), auth())).toBeGreaterThan(hides)
      expect(lastIdx(p.args, '--bind', logs(), logs())).toBeGreaterThan(hides)
      expect(p.args).not.toContain(join(qoder(), 'tmp'))
      expect(lastIdx(p.args, '--bind', qoder(), qoder())).toBe(-1)
      expect(p.args.at(-1)).toBe(QUOTED)
      p.release()
    })

    it('deny write(~/.ssh/config): the host file is not brought back over the tmpfs (review C2)', async () => {
      writeFileSync(join(home, '.ssh', 'config'), 'x')
      const other = join(dataDir, 'sessions', 'other')
      mkdirSync(other, { recursive: true })
      const { svc } = service(LINUX)
      const p = await svc.planExec(FILE, ARGS, session(), baseEnv, opts({ denyWrite: [join(home, '.ssh', 'config'), other] }))
      expect(p.args).not.toContain(join(home, '.ssh', 'config'))
      expect(p.args).not.toContain(other)
      expect(lastIdx(p.args, '--tmpfs', join(home, '.ssh'))).toBeGreaterThan(0)
      p.release()
    })

    it('allowWrite inside a hidden credential root is not re-exposed, unless it is the exemption (same as Seatbelt)', async () => {
      const { svc } = service({ ...LINUX, env: { HOME: home, QODER_CONFIG_DIR: qoder() } })
      const p = await svc.planExec(FILE, ARGS, session(), baseEnv, opts())
      expect(lastIdx(p.args, '--tmpfs', qoder())).toBeGreaterThan(0)
      expect(lastIdx(p.args, '--bind', auth(), auth())).toBeGreaterThan(lastIdx(p.args, '--tmpfs', qoder()))
      expect(lastIdx(p.args, '--bind', logs(), logs())).toBe(-1)
      p.release()
    })

    it('the shell plan still hides the exemption', async () => {
      const { svc } = service(LINUX)
      const p = await svc.plan('true', session(), baseEnv)
      expect(lastIdx(p.args, '--tmpfs', auth())).toBeGreaterThan(0)
      expect(lastIdx(p.args, '--bind', auth(), auth())).toBe(-1)
      p.release()
    })

    it('readOnly: no --bind cwd; chdir stays', async () => {
      const { svc } = service(LINUX)
      const cwd = join(repo, 'sub')
      const p = await svc.planExec(FILE, ARGS, session(), baseEnv, opts({ readOnly: true }))
      expect(lastIdx(p.args, '--bind', cwd, cwd)).toBe(-1)
      expect(p.args[p.args.indexOf('--chdir') + 1]).toBe(cwd)
      p.release()
    })

    it('rule paths reach bwrap: read hidden, write read-only after the binds', async () => {
      const { svc } = service(LINUX)
      const secret = join(repo, 'sub', 'secret')
      const gen = join(repo, 'sub', 'gen')
      mkdirSync(secret)
      mkdirSync(gen)
      const p = await svc.planExec(FILE, ARGS, session(), baseEnv, opts({ denyRead: [secret], denyWrite: [gen] }))
      const binds = lastIdx(p.args, '--bind', logs(), logs())
      expect(lastIdx(p.args, '--tmpfs', secret)).toBeGreaterThan(binds)
      expect(lastIdx(p.args, '--ro-bind', gen, gen)).toBeGreaterThan(binds)
      p.release()
    })

    it("~/.qoder's bin, settings.json and external-commands are ro-bound at cwd = ~/.qoder, after the cwd bind", async () => {
      mkdirSync(join(qoder(), 'bin'))
      mkdirSync(join(qoder(), 'external-commands'))
      writeFileSync(join(qoder(), 'settings.json'), '{}')
      const { svc } = service(LINUX)
      const p = await svc.planExec(FILE, ARGS, session('s1', qoder()), baseEnv, opts())
      const cwdBind = lastIdx(p.args, '--bind', qoder(), qoder())
      expect(cwdBind).toBeGreaterThan(0)
      for (const x of ['bin', 'settings.json', 'external-commands']) {
        expect(lastIdx(p.args, '--ro-bind', join(qoder(), x), join(qoder(), x)), x).toBeGreaterThan(cwdBind)
      }
      p.release()
    })
  })

  describe('per-run proxies', () => {
    const connectable = async (env: NodeJS.ProcessEnv) => canConnect(portOf(env))

    it('a run gets its own proxy; its hosts are not the session shell\'s; denials land on the session', async () => {
      const { svc, appended } = service({ config: () => cfg({ network: { allow: ['shared.example'] } }) })
      const shellPlan = await svc.plan('true', session(), baseEnv)
      const run = await svc.planExec(FILE, ARGS, session(), baseEnv, opts())
      expect(portOf(run.env)).not.toBe(portOf(shellPlan.env))
      expect(await connectStatus(portOf(shellPlan.env), 'center.qoder.sh:443')).toMatch(/ 403 /)
      expect(await connectStatus(portOf(run.env), 'evil.example:443')).toMatch(/ 403 /)
      const denied = appended.filter(e => e.type === 'sandbox.netDenied')
      expect(denied.map(e => e.sessionId)).toEqual(['s1', 's1'])
      expect(denied.map(e => (e.payload as { host: string }).host)).toEqual(['center.qoder.sh', 'evil.example'])
      shellPlan.release()
      run.release()
    })

    it('the run proxy also obeys the global allow list, read live, plus its own hosts', async () => {
      const seen: (() => string[])[] = []
      let allow = ['a.example']
      const { svc } = service({
        config: () => cfg({ network: { allow } }),
        startProxy: async o => { seen.push(o.allow); return startProxy({ ...o, lookup: async () => [] }) },
      })
      const run = await svc.planExec(FILE, ARGS, session(), baseEnv, opts({ allowHosts: ['*.qoder.sh'] }))
      expect(seen[0]()).toEqual(['a.example', '*.qoder.sh'])
      allow = ['b.example']
      expect(seen[0]()).toEqual(['b.example', '*.qoder.sh'])
      run.release()
    })

    it("release() closes the run's proxy at once and leaves the session's alone", async () => {
      const { svc } = service()
      const shellPlan = await svc.plan('true', session(), baseEnv)
      shellPlan.release()
      const run = await svc.planExec(FILE, ARGS, session(), baseEnv, opts())
      expect(await connectable(run.env)).toBe(true)
      run.release()
      await vi.waitFor(async () => expect(await connectable(run.env)).toBe(false))
      expect(await connectable(shellPlan.env)).toBe(true)
      run.release() // 多调无害
      const again = await svc.plan('true', session(), baseEnv)
      expect(portOf(again.env)).toBe(portOf(shellPlan.env))
      again.release()
    })

    it('two runs of one session are separate; one releasing leaves the other', async () => {
      const { svc } = service()
      const a = await svc.planExec(FILE, ARGS, session(), baseEnv, opts({ proxyScope: 'run_a' }))
      const b = await svc.planExec(FILE, ARGS, session(), baseEnv, opts({ proxyScope: 'run_b' }))
      expect(portOf(a.env)).not.toBe(portOf(b.env))
      a.release()
      await vi.waitFor(async () => expect(await connectable(a.env)).toBe(false))
      expect(await connectable(b.env)).toBe(true)
      b.release()
    })

    it('the release of a run does not forget the session\'s git lookup; the plain entry still does', async () => {
      let n = 0
      const g = testGit()
      const { svc } = service({ git: (a, o) => { n++; return g(a, o) } })
      const shellPlan = await svc.plan('true', session(), baseEnv)
      const once = n
      const run = await svc.planExec(FILE, ARGS, session(), baseEnv, opts())
      run.release()
      await vi.waitFor(async () => expect(await connectable(run.env)).toBe(false))
      await wait(20)
      ;(await svc.plan('true', session(), baseEnv)).release()
      expect(n).toBe(once)
      shellPlan.release()
    })

    it('a scope still in use is refused, also when two plans race; after release it can be used again (review M4)', async () => {
      const { svc } = service()
      const a = await svc.planExec(FILE, ARGS, session(), baseEnv, opts({ proxyScope: 'same' }))
      await expect(svc.planExec(FILE, ARGS, session(), baseEnv, opts({ proxyScope: 'same' }))).rejects.toThrow(/scope/)
      a.release()
      const b = await svc.planExec(FILE, ARGS, session(), baseEnv, opts({ proxyScope: 'same' }))
      b.release()
      const raced = await Promise.allSettled([svc.planExec(FILE, ARGS, session(), baseEnv, opts({ proxyScope: 'r' })), svc.planExec(FILE, ARGS, session(), baseEnv, opts({ proxyScope: 'r' }))])
      expect(raced.map(r => r.status).sort()).toEqual(['fulfilled', 'rejected'])
      for (const r of raced) if (r.status === 'fulfilled') r.value.release()
    })

    it('close() closes run proxies still held', async () => {
      const { svc } = service()
      const run = await svc.planExec(FILE, ARGS, session(), baseEnv, opts())
      expect(await connectable(run.env)).toBe(true)
      await svc.close()
      expect(await connectable(run.env)).toBe(false)
    })

    it('a run proxy that fails: network off and partial for that plan; session status unaffected; nothing left behind', async () => {
      let fail = true
      const { svc } = service({ startProxy: async o => { if (fail) throw new Error('nope'); return startProxy(o) } })
      const run = await svc.planExec(FILE, ARGS, session(), baseEnv, opts())
      expect(run.sandboxed).toBe(true)
      expect(run.level).toBe('partial')
      expect(run.env.HTTPS_PROXY).toBeUndefined()
      expect(profileOf(run.args)).not.toMatch(/network-outbound/)
      expect(run.networkLost).toBe(true)
      expect(svc.status('s1').level).toBe('full')
      run.release()
      fail = false
      const next = await svc.planExec(FILE, ARGS, session(), baseEnv, opts())
      expect(next.level).toBe('full')
      expect(next.networkLost).toBeUndefined()
      next.release()
    })

    it('networkLost is accurate per platform: Linux at full with a failed proxy yes; Linux at partial (no netns, network open) no; a loopback partial no', async () => {
      const failing = { startProxy: async () => { throw new Error('nope') } }
      const linuxFull = await service({ platform: 'linux', detected: { level: 'full', missing: [], bwrap: '/usr/bin/bwrap' }, ...failing }).svc.planExec(FILE, ARGS, session(), baseEnv, opts())
      expect(linuxFull.level).toBe('partial')
      expect(linuxFull.args).toContain('--unshare-net')
      expect(linuxFull.networkLost).toBe(true)
      linuxFull.release()
      const linuxPartial = await service({ platform: 'linux', detected: { level: 'partial', missing: ['netns'], bwrap: '/usr/bin/bwrap' }, ...failing }).svc.planExec(FILE, ARGS, session(), baseEnv, opts())
      expect(linuxPartial.level).toBe('partial')
      expect(linuxPartial.args).not.toContain('--unshare-net')
      expect(linuxPartial.networkLost).toBeUndefined()
      linuxPartial.release()
      const loopback = await service({ config: () => cfg({}, { allowLoopback: true }) }).svc.planExec(FILE, ARGS, session(), baseEnv, opts())
      expect(loopback.level).toBe('partial')
      expect(loopback.networkLost).toBeUndefined()
      loopback.release()
    })
  })
})

describe('execPolicy', () => {
  const rule = (effect: 'deny' | 'ask' | 'allow', text: string): Rule => {
    const r = parseRule({ effect, rule: text })
    if (!('subject' in r)) throw new Error(`bad rule ${text}`)
    return r
  }
  const cwd = () => join(repo, 'sub')
  const policy = (rules: Rule[], over: Parameters<typeof service>[0] = {}, resource?: string) =>
    service({ rules: () => rules, ...over }).svc.execPolicy('s1', cwd(), resource)

  it('lists come from the env snapshot; no rules → nothing to translate', () => {
    const p = policy([], { env: { HOME: home, CODEX_HOME: join(root, 'codex-home') } })
    expect(p.denyRead).toEqual(expect.arrayContaining([join(home, '.ssh'), join(home, '.qoder', '.auth'), join(root, 'codex-home'), dataDir]))
    expect(p.persistence).toEqual(expect.arrayContaining([join(home, '.zshrc'), join(home, '.qoder', 'bin'), join(home, '.qoder', 'settings.json'), join(home, '.qoder', 'external-commands')]))
    expect(p).toMatchObject({ dataDir, level: 'full', ruleDenyRead: [], ruleDenyWrite: [], untranslatedRules: 0, totalRules: 0 })
  })

  it('level is the session level, read live', () => {
    expect(policy([], { config: () => cfg({}, { enabled: false }) }).level).toBe('none')
    expect(policy([], { config: () => cfg({}, { allowLoopback: true }) }).level).toBe('partial')
  })

  it('rules are read at each call', () => {
    let rules: Rule[] = []
    const { svc } = service({ rules: () => rules })
    expect(svc.execPolicy('s1', cwd()).ruleDenyWrite).toEqual([])
    rules = [rule('deny', 'write(gen/**)')]
    expect(svc.execPolicy('s1', cwd()).ruleDenyWrite).toEqual([join(cwd(), 'gen')])
  })

  // policy.test.ts 的 policyOf 是替身;这几行走真的 execPolicy
  it('deny write(src/gen/**) and deny read(hidden/**) translate', () => {
    expect(policy([rule('deny', 'write(src/gen/**)'), rule('deny', 'read(hidden/**)')])).toMatchObject({
      ruleDenyWrite: [join(cwd(), 'src/gen')], ruleDenyRead: [join(cwd(), 'hidden')], untranslatedRules: 0, totalRules: 2,
    })
  })

  it('ask write(src/gen/**) translates like deny', () => {
    expect(policy([rule('ask', 'write(src/gen/**)')])).toMatchObject({ ruleDenyWrite: [join(cwd(), 'src/gen')], untranslatedRules: 0, totalRules: 1 })
  })

  it.each(['write(**/*.env)', 'read(**/*.env)', 'shell(git push*)'])('deny %s is not translated', text => {
    expect(policy([rule('deny', text)])).toMatchObject({ ruleDenyRead: [], ruleDenyWrite: [], untranslatedRules: 1, totalRules: 1 })
  })

  it('allow rules count for nothing', () => {
    expect(policy([rule('allow', 'shell(codex)'), rule('allow', 'write(**)')])).toMatchObject({ untranslatedRules: 0, totalRules: 0 })
  })

  it("deny write(**) becomes cwd; ask write(**) doesn't", () => {
    expect(policy([rule('deny', 'write(**)')])).toMatchObject({ ruleDenyWrite: [cwd()], untranslatedRules: 0 })
    expect(policy([rule('ask', 'write(**)')])).toMatchObject({ ruleDenyWrite: [], untranslatedRules: 1 })
  })

  it('a shell rule that hits the executor itself was decided by the gate: only with its resource is it exempt', () => {
    const rules = [rule('deny', 'shell(codex*)'), rule('ask', 'shell(qoder)'), rule('deny', 'shell(git push*)')]
    expect(policy(rules)).toMatchObject({ untranslatedRules: 3, totalRules: 3 })
    expect(policy(rules, {}, 'codex')).toMatchObject({ untranslatedRules: 2, totalRules: 3 })
    expect(policy(rules, {}, 'qoder')).toMatchObject({ untranslatedRules: 2, totalRules: 3 })
    expect(policy(rules, {}, 'unknown')).toMatchObject({ untranslatedRules: 3, totalRules: 3 })
  })

  it('a symlinked rule path comes in both spellings', () => {
    const real = join(root, 'real')
    mkdirSync(real)
    symlinkSync(real, join(repo, 'sub', 'link'))
    expect(policy([rule('deny', 'write(link/**)')]).ruleDenyWrite).toEqual(expect.arrayContaining([join(cwd(), 'link'), real]))
  })

  describe('a rule root that does not exist', () => {
    const LINUX: Partial<SandboxOpts> = { platform: 'linux', detected: { level: 'full', missing: [], bwrap: '/usr/bin/bwrap' } }

    it('linux: bwrap cannot mount it, so the rule counts as untranslated; the root stays listed for Codex', () => {
      expect(policy([rule('deny', 'write(later/**)')], LINUX)).toMatchObject({ ruleDenyWrite: [join(cwd(), 'later')], untranslatedRules: 1, totalRules: 1 })
      expect(policy([rule('deny', 'read(later/**)')], LINUX)).toMatchObject({ ruleDenyRead: [join(cwd(), 'later')], untranslatedRules: 1, totalRules: 1 })
    })

    it('linux: an existing root is translated as usual', () => {
      mkdirSync(join(cwd(), 'now'))
      expect(policy([rule('deny', 'write(now/**)')], LINUX)).toMatchObject({ untranslatedRules: 0 })
    })

    it('darwin: Seatbelt holds a path that is not there yet, so it stays translated', () => {
      expect(policy([rule('deny', 'write(later/**)')])).toMatchObject({ ruleDenyWrite: [join(cwd(), 'later')], untranslatedRules: 0 })
    })
  })
})

describe('sandbox plan (injected linux)', () => {
  it('full → bwrap with --unshare-net, the relay on the proxy unix socket, HTTPS_PROXY at the relay port; missing hooks dir is created', async () => {
    rmSync(join(repo, '.git', 'hooks'), { recursive: true, force: true })
    const { svc } = service({ platform: 'linux', detected: { level: 'full', missing: [], bwrap: '/usr/bin/bwrap' }, execPath: process.execPath })
    const p = await svc.plan('echo hi', session(), baseEnv)
    expect(p.file).toBe('/usr/bin/bwrap')
    expect(p.sandboxed).toBe(true)
    expect(p.args).toContain('--unshare-net')
    expect(existsSync(join(repo, '.git', 'hooks'))).toBe(true)
    const relayAt = p.args.indexOf(process.execPath)
    expect(relayAt).toBeGreaterThan(0)
    const sock = p.args[relayAt + 4]
    expect(sock).toMatch(/mffai-net-[^/]+\/net\.sock$/)
    expect(p.args.slice(-3)).toEqual(['/bin/sh', '-c', 'echo hi'])
    expect(p.env.HTTPS_PROXY).toBe('http://127.0.0.1:3128')
    expect(p.env.NO_PROXY).toBe('')
    p.release()
  })

  it('a proxy socket parent inside the writable cwd is not used: falls back to /tmp (review M2)', async () => {
    const { svc } = service({ platform: 'linux', detected: { level: 'full', missing: [], bwrap: '/usr/bin/bwrap' }, proxyParent: join(repo, 'sub') })
    const p = await svc.plan('true', session(), baseEnv)
    const sock = p.args[p.args.indexOf(process.execPath) + 4]
    expect(sock.startsWith(join(repo, 'sub'))).toBe(false)
    expect(['/tmp', '/private/tmp']).toContain(dirname(dirname(sock)))
    p.release()
  })

  it('allowLoopback on linux changes nothing: NO_PROXY stays empty', async () => {
    const { svc } = service({ platform: 'linux', detected: { level: 'full', missing: [], bwrap: '/usr/bin/bwrap' }, config: () => cfg({}, { allowLoopback: true }) })
    const p = await svc.plan('true', session(), baseEnv)
    expect(p.env.NO_PROXY).toBe('')
    expect(p.level).toBe('full')
    p.release()
  })

  it('partial (no netns) → bwrap without --unshare-net, no relay, no proxy variables', async () => {
    const { svc } = service({ platform: 'linux', detected: { level: 'partial', missing: ['netns'], bwrap: '/usr/bin/bwrap' } })
    const p = await svc.plan('true', session(), baseEnv)
    expect(p.args).not.toContain('--unshare-net')
    expect(p.args).not.toContain(process.execPath)
    expect(p.env.HTTPS_PROXY).toBeUndefined()
    expect(p.env.MFFAI_SANDBOX).toBe('partial')
    p.release()
  })

  it('full but the proxy fails → still --unshare-net, no relay, no proxy env; status partial + proxy', async () => {
    const { svc } = service({ platform: 'linux', detected: { level: 'full', missing: [], bwrap: '/usr/bin/bwrap' }, startProxy: async () => { throw new Error('nope') } })
    const p = await svc.plan('true', session(), baseEnv)
    expect(p.args).toContain('--unshare-net')
    expect(p.args).not.toContain(process.execPath)
    expect(p.env.HTTPS_PROXY).toBeUndefined()
    expect(svc.status('s1')).toEqual({ level: 'partial', missing: ['proxy'], autoDegraded: false })
    p.release()
  })
})

describe('wipeSessionTmp', () => {
  it('empties every sessions/*/tmp and leaves spill and other files alone', () => {
    for (const sid of ['a', 'b']) {
      mkdirSync(join(dataDir, 'sessions', sid, 'tmp', 'deep'), { recursive: true })
      writeFileSync(join(dataDir, 'sessions', sid, 'tmp', 'deep', 'f'), 'x')
      mkdirSync(join(dataDir, 'sessions', sid, 'spill'), { recursive: true })
      writeFileSync(join(dataDir, 'sessions', sid, 'spill', 'keep'), 'x')
    }
    // tmp 是指向外面的链接:只删链接,不碰目标
    const outside = join(root, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'precious'), 'x')
    mkdirSync(join(dataDir, 'sessions', 'c'))
    symlinkSync(outside, join(dataDir, 'sessions', 'c', 'tmp'))
    wipeSessionTmp(dataDir)
    for (const sid of ['a', 'b', 'c']) expect(existsSync(join(dataDir, 'sessions', sid, 'tmp'))).toBe(false)
    for (const sid of ['a', 'b']) expect(readdirSync(join(dataDir, 'sessions', sid, 'spill'))).toEqual(['keep'])
    expect(readdirSync(outside)).toEqual(['precious'])
  })

  it('no sessions dir → no-op', () => {
    expect(() => wipeSessionTmp(join(root, 'nothing'))).not.toThrow()
  })
})

describe('kernel wiring', () => {
  let kernels: Kernel[] = []
  afterEach(async () => {
    for (const k of kernels) await k.close().catch(() => {})
    kernels = []
  })
  let seen: SandboxService | undefined
  const probe: Plugin = { manifest: { id: 'probe', version: '0', kernel: '^0.1.0' }, activate: ctx => { seen = ctx.services.get<SandboxService>('sandbox') } }
  async function boot(detect: () => DetectResult | Promise<DetectResult>, permissions?: unknown) {
    if (permissions) writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ permissions }))
    seen = undefined
    const k = await createKernel({
      dataDir, home, env: { HOME: home }, plugins: [probe], secrets: { osBackend: false },
      sandbox: { detect, upstream: null, git: testGit() },
    })
    kernels.push(k)
    return k
  }

  it('provides sandbox before plugins; status, snapshot and permissions.get carry it', async () => {
    const k = await boot(() => ({ level: 'full', missing: [] }))
    expect(seen).toBeDefined()
    expect(k.status().sandbox).toEqual({ level: 'full', missing: [], autoDegraded: false })
    expect(k.snapshot().status.sandbox).toEqual({ level: 'full', missing: [], autoDegraded: false })
    expect(((await k.handle('status', {})) as { sandbox: unknown }).sandbox).toEqual({ level: 'full', missing: [], autoDegraded: false })
    expect(((await k.handle('permissions.get', {})) as { sandbox: unknown }).sandbox).toEqual({ level: 'full', missing: [], autoDegraded: false })
  })

  it('permissions.get with a sessionId asks for that session\'s status; without one, the global status', async () => {
    const k = await boot(() => ({ level: 'full', missing: [] }))
    const { sessionId } = (await k.handle('session.create', { commandId: 'c1', title: 't' })) as { sessionId: string }
    const spy = vi.spyOn(seen!, 'status').mockImplementation(sid =>
      sid === sessionId ? { level: 'partial', missing: ['proxy'], autoDegraded: false } : { level: 'full', missing: [], autoDegraded: false })
    expect(((await k.handle('permissions.get', { sessionId })) as { sandbox: unknown }).sandbox).toEqual({ level: 'partial', missing: ['proxy'], autoDegraded: false })
    expect(spy).toHaveBeenLastCalledWith(sessionId)
    expect(((await k.handle('permissions.get', {})) as { sandbox: unknown }).sandbox).toEqual({ level: 'full', missing: [], autoDegraded: false })
    expect(spy.mock.lastCall?.[0]).toBeUndefined()
  })

  it('async detect works and none degrades auto', async () => {
    const k = await boot(async () => ({ level: 'none', missing: ['sandbox-exec'] }))
    expect(k.status().sandbox).toEqual({ level: 'none', missing: ['sandbox-exec'], autoDegraded: true })
  })

  it('config sandbox.enabled:false → none + disabled even when detection says full', async () => {
    const k = await boot(() => ({ level: 'full', missing: [] }), { sandbox: { enabled: false } })
    expect(k.status().sandbox).toEqual({ level: 'none', missing: ['disabled'], autoDegraded: true })
  })

  it('execPolicy sees the rules the permission store holds, live', async () => {
    const k = await boot(() => ({ level: 'full', missing: [] }), { rules: [{ effect: 'deny', rule: 'write(gen/**)' }] })
    const cwd = join(repo, 'sub')
    expect(seen!.execPolicy('s1', cwd).ruleDenyWrite).toEqual([join(cwd, 'gen')])
    await k.handle('permissions.set', { commandId: 'p1', config: { rules: [{ effect: 'deny', rule: 'read(hidden/**)' }], network: { allow: [] }, sandbox: { enabled: true, allowLoopback: false }, allowUnsandboxedAuto: false } })
    expect(seen!.execPolicy('s1', cwd)).toMatchObject({ ruleDenyWrite: [], ruleDenyRead: [join(cwd, 'hidden')], totalRules: 1 })
  })

  it('kernel.close() closes every session proxy', async () => {
    const k = await boot(() => ({ level: 'full', missing: [] }))
    const plan = await seen!.plan('true', session('s1'), baseEnv)
    const plan2 = await seen!.plan('true', session('s2'), baseEnv)
    // darwin:看 TCP 端口;linux:看代理自己建的 socket 目录(close 时删掉)
    const ports = process.platform === 'darwin' ? [portOf(plan.env), portOf(plan2.env)] : []
    const socks = process.platform === 'linux' ? [plan, plan2].map(p => p.args.find(a => a.endsWith('/net.sock'))!) : []
    for (const port of ports) expect(await canConnect(port)).toBe(true)
    for (const sk of socks) expect(existsSync(sk)).toBe(true)
    expect(ports.length + socks.length).toBe(2)
    await k.close()
    kernels = []
    for (const port of ports) expect(await canConnect(port)).toBe(false)
    for (const sk of socks) expect(existsSync(dirname(sk))).toBe(false)
  })
})

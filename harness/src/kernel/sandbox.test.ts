import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createGit, NO_REPO, pinFromPaths } from '../lib/git/snapshot'
import { parseRule, type Rule } from '../lib/permissions/rules'
import { runCli } from '../lib/proc/runCli'
import type { DetectResult } from '../lib/sandbox/detect'
import { startProxy, type ProxyHandle, type ProxyOptions } from '../lib/sandbox/net/proxy'
import type { ExecPlanOpts, SandboxService } from '../lib/tools/types'
import type { PermissionsConfig } from '../protocol/index'
import { createKernel, type Kernel } from './kernel'
import type { Plugin } from './pluginHost'
import { createSandboxService, sessionTmpDir, wipeSessionTmp, type SandboxOpts } from './sandbox'
import { pluginStoreRootOf } from '../lib/fs/paths'

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
    repoPin: () => pinFromPaths(repo, join(repo, '.git'), join(repo, '.git')),
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

  it('a worktree cwd: the common gitDir is writable and the cwd .git file is protected', async () => {
    execFileSync('git', ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'i'], { env: { ...gitTestEnv(), GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@x', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@x' } })
    const wt = join(home, 'wt')
    execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', wt], { env: gitTestEnv() })
    const { svc } = service({ repoPin: () => pinFromPaths(wt, join(repo, '.git', 'worktrees', 'wt'), join(repo, '.git')) })
    const p = await svc.plan('true', session('s1', wt), baseEnv)
    const prof = profileOf(p.args)
    expect(prof).toMatch(new RegExp(`\\(allow file-write\\* [^\\n]*\\(subpath ${q(join(repo, '.git')).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`))
    expect(prof).toContain(`(literal ${q(join(wt, '.git'))})`)
    p.release()
  })
})

describe('the pinned repo decides the gitDirs (final review C-1)', () => {
  it('a session pinned "none" gets no git dir, even with a planted .git file pointing at another repo', async () => {
    const plain = join(root, 'plain')
    mkdirSync(plain)
    writeFileSync(join(plain, '.git'), `gitdir: ${join(repo, '.git')}\n`)
    const { svc } = service({ repoPin: () => NO_REPO })
    const p = await svc.plan('true', session('s1', plain), baseEnv)
    expect(profileOf(p.args)).not.toContain(`(subpath ${q(join(repo, '.git'))})`)
    p.release()
  })

  it('an unknown session has no repo either', async () => {
    const { svc } = service({ repoPin: () => undefined })
    const p = await svc.plan('true', session(), baseEnv)
    expect(profileOf(p.args)).not.toContain(`(subpath ${q(join(repo, '.git'))})`)
    p.release()
  })

  it('a planted .git file in the cwd of a pinned session does not move the git dir', async () => {
    const elsewhere = join(root, 'elsewhere')
    execFileSync('git', ['init', '-q', elsewhere], { env: gitTestEnv() })
    const sub = join(repo, 'sub')
    mkdirSync(sub, { recursive: true })
    writeFileSync(join(sub, '.git'), `gitdir: ${join(elsewhere, '.git')}\n`)
    const { svc } = service()
    const p = await svc.plan('true', session('s1', sub), baseEnv)
    const prof = profileOf(p.args)
    expect(prof).toContain(`(subpath ${q(join(repo, '.git'))})`)
    expect(prof).not.toContain(q(join(elsewhere, '.git')))
    p.release()
  })

  it('a run in this session\'s worktree protects that worktree\'s .git file', async () => {
    const run = join(`${dataDir}-worktrees`, 's1', 'r1')
    mkdirSync(run, { recursive: true })
    writeFileSync(join(run, '.git'), 'gitdir: x\n')
    const { svc } = service()
    const p = await svc.plan('true', session('s1', join(run)), baseEnv)
    expect(profileOf(p.args)).toContain(`(literal ${q(join(run, '.git'))})`)
    p.release()
    rmSync(`${dataDir}-worktrees`, { recursive: true, force: true })
  })

  it('linux: the config dirs are created and mounted read-only, since bwrap only binds what exists', async () => {
    const cwd = join(repo, 'sub')
    mkdirSync(cwd, { recursive: true })
    const { svc } = service({ platform: 'linux', detected: { level: 'partial', missing: ['netns'], bwrap: '/usr/bin/bwrap' } })
    const p = await svc.plan('true', session('s1', cwd), baseEnv)
    for (const d of ['.codex', '.qoder']) {
      const path = join(cwd, d)
      expect(existsSync(path)).toBe(true)
      const i = p.args.lastIndexOf(path)
      expect(p.args.slice(i - 2, i + 1)).toEqual(['--ro-bind', path, path])
    }
    p.release()
  })

  it('<cwd>/.codex and .qoder stay protected, in any letter case, and never for an allowWrite under them', async () => {
    const { svc } = service()
    const cwd = join(repo, 'sub')
    const p = await svc.plan('true', session('s1', cwd), baseEnv)
    const prof = profileOf(p.args)
    const esc = cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    expect(prof).toContain(JSON.stringify(`^${esc}/\\.[cC][oO][dD][eE][xX](/|$)`))
    expect(prof).toContain(JSON.stringify(`^${esc}/\\.[qQ][oO][dD][eE][rR](/|$)`))
    p.release()
    const inHome = await svc.planExec('/opt/q/qodercli', [], session('s1', home), baseEnv, { allowRead: [], allowWrite: [join(home, '.qoder', 'logs')], allowHosts: [], proxyScope: 'r1', readOnly: false, denyRead: [], denyWrite: [] })
    expect(profileOf(inHome.args)).not.toContain('[qQ][oO][dD][eE][rR]')
    expect(profileOf(inHome.args)).toContain('[cC][oO][dD][eE][xX]')
    inHome.release()
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
    let flip = false
    const svc2 = createSandboxService({
      platform: 'darwin', dataDir, home, env: { HOME: home }, detected: { level: 'full', missing: [] },
      permissions: () => (flip ? cfg({}, { enabled: false }) : cfg()), rules: () => [], append: () => {},
      repoPin: () => { flip = true; return NO_REPO },
    })
    closers.push(() => svc2.close())
    const p = await svc2.plan('true', session(), baseEnv)
    expect(p.sandboxed).toBe(true)
    expect(p.level).toBe('full')
    expect(p.env.MFFAI_SANDBOX).toBe('full')
    p.release()
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

describe('sessions that are not on this machine: the shared git state is read-only (07 spec §8.2)', () => {
  const PLAN: ExecPlanOpts = { allowRead: [], allowWrite: [], allowHosts: [], proxyScope: 'run_1', readOnly: false, denyRead: [], denyWrite: [] }
  const commonDir = () => join(repo, '.git')
  const LINUX: Partial<SandboxOpts> = { platform: 'linux', detected: { level: 'partial', missing: ['netns'], bwrap: '/usr/bin/bwrap' } }
  /** 一个链接 worktree 的钉子:top 是 worktree,git 目录在用户仓库里 */
  const linked = () => {
    const top = join(root, 'wt')
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e.invalid', 'commit', '-q', '--allow-empty', '-m', 'i'], { cwd: repo, env: gitTestEnv() })
    execFileSync('git', ['worktree', 'add', '-q', '--detach', top, 'HEAD'], { cwd: repo, env: gitTestEnv() })
    return { top, pin: pinFromPaths(top, join(repo, '.git', 'worktrees', 'wt'), commonDir()) }
  }
  /** Seatbelt 配置里 a 段放行、最后一段拒绝的路径 */
  const q = (s: string) => JSON.stringify(s)
  const finalDeny = (profile: string, path: string) => profile.split('\n').some(l => l.startsWith('(deny file-write') && l.includes(`(subpath ${q(path)})`))
  const writable = (profile: string, path: string) => profile.split('\n').some(l => l.startsWith('(allow file-write') && l.includes(`(subpath ${q(path)})`))

  it.each(['im', 'schedule'] as const)('%s, darwin: the shell plan denies writes to the common dir and it is not a writable root', async origin => {
    const { svc } = service({ originOf: () => origin })
    const plan = await svc.plan('true', session(), baseEnv)
    plan.release()
    const profile = profileOf(plan.args)
    expect(finalDeny(profile, commonDir())).toBe(true)
    expect(writable(profile, commonDir())).toBe(false)
    expect(writable(profile, join(repo, 'sub'))).toBe(true)
  })

  it.each(['app', 'acp'] as const)('%s, darwin: unchanged, the common dir stays a writable root', async origin => {
    const { svc } = service({ originOf: () => origin })
    const plan = await svc.plan('true', session(), baseEnv)
    plan.release()
    const profile = profileOf(plan.args)
    expect(writable(profile, commonDir())).toBe(true)
    expect(finalDeny(profile, commonDir())).toBe(false)
  })

  it('no originOf dep: nothing added', async () => {
    const plan = await service().svc.plan('true', session(), baseEnv)
    plan.release()
    expect(writable(profileOf(plan.args), commonDir())).toBe(true)
    expect(finalDeny(profileOf(plan.args), commonDir())).toBe(false)
  })

  it('a dep that does not know the session: read-only, failing closed', async () => {
    const plan = await service({ originOf: () => undefined }).svc.plan('true', session(), baseEnv)
    plan.release()
    expect(finalDeny(profileOf(plan.args), commonDir())).toBe(true)
    expect(writable(profileOf(plan.args), commonDir())).toBe(false)
  })

  it('the origin is read on each plan, not captured at construction', async () => {
    let origin: 'app' | 'im' = 'app'
    const { svc } = service({ originOf: () => origin })
    const a = await svc.plan('true', session(), baseEnv)
    a.release()
    expect(finalDeny(profileOf(a.args), commonDir())).toBe(false)
    origin = 'im'
    const b = await svc.plan('true', session(), baseEnv)
    b.release()
    expect(finalDeny(profileOf(b.args), commonDir())).toBe(true)
  })

  it('the constant shell options are not mutated: an app plan after an IM plan is clean', async () => {
    const origins: Record<string, 'app' | 'im'> = { im1: 'im', app1: 'app' }
    const { svc } = service({ originOf: sid => origins[sid] })
    const im = await svc.plan('true', session('im1'), baseEnv)
    im.release()
    const app = await svc.plan('true', session('app1'), baseEnv)
    app.release()
    expect(finalDeny(profileOf(im.args), commonDir())).toBe(true)
    expect(finalDeny(profileOf(app.args), commonDir())).toBe(false)
  })

  it('no repo: nothing to add, and the plan still works', async () => {
    const plan = await service({ originOf: () => 'im', repoPin: () => NO_REPO }).svc.plan('true', session(), baseEnv)
    plan.release()
    expect(finalDeny(profileOf(plan.args), commonDir())).toBe(false)
  })

  it('a linked worktree: both the common dir and its own git dir are denied, the worktree stays writable, its .git file protected', async () => {
    const { top, pin } = linked()
    const { svc } = service({ originOf: () => 'im', repoPin: () => pin })
    const plan = await svc.plan('true', session('s1', top), baseEnv)
    plan.release()
    const profile = profileOf(plan.args)
    expect(finalDeny(profile, commonDir())).toBe(true)
    expect(finalDeny(profile, pin.gitDir)).toBe(true)
    expect(writable(profile, top)).toBe(true)
    expect(writable(profile, commonDir())).toBe(false)
    expect(profile).toContain(q(join(top, '.git')))
  })

  it('a wrapped run (planExec): the common dir is in denyWrite, on top of what the run asked for', async () => {
    const { top, pin } = linked()
    const { svc } = service({ originOf: () => 'im', repoPin: () => pin })
    const asked = join(top, 'gen')
    const plan = await svc.planExec('/usr/bin/true', [], session('s1', top), baseEnv, { ...PLAN, denyWrite: [asked] })
    plan.release()
    const profile = profileOf(plan.args)
    expect(finalDeny(profile, commonDir())).toBe(true)
    expect(finalDeny(profile, pin.gitDir)).toBe(true)
    expect(finalDeny(profile, asked)).toBe(true)
    expect(writable(profile, commonDir())).toBe(false)
  })

  it('planExec with an app session: unchanged', async () => {
    const { svc } = service({ originOf: () => 'app' })
    const plan = await svc.planExec('/usr/bin/true', [], session(), baseEnv, PLAN)
    plan.release()
    expect(finalDeny(profileOf(plan.args), commonDir())).toBe(false)
    expect(writable(profileOf(plan.args), commonDir())).toBe(true)
  })

  it('linux: the common dir is mounted read-only after its writable mount', async () => {
    const { svc } = service({ ...LINUX, originOf: () => 'im' })
    const plan = await svc.plan('true', session(), baseEnv)
    plan.release()
    const lastMount = (flag: string) => plan.args.reduce((at, a, i) => (a === flag && plan.args[i + 1] === commonDir() ? i : at), -1)
    expect(lastMount('--ro-bind')).toBeGreaterThan(lastMount('--bind'))
  })

  it('linux, app session: no read-only mount of it', async () => {
    const { svc } = service({ ...LINUX, originOf: () => 'app' })
    const plan = await svc.plan('true', session(), baseEnv)
    plan.release()
    const roots = plan.args.flatMap((a, i) => (a === '--ro-bind' ? [plan.args[i + 1]] : []))
    expect(roots).not.toContain(commonDir())
  })

  describe('the checkout the worktree came from is hidden (07 spec §8.1)', () => {
    const argPairs = (args: string[], flag: string) => args.flatMap((a, i) => (a === flag ? [args[i + 1]!] : []))
    const denyLines = (profile: string, ops: string, path: string) => profile.split('\n').filter(l => l.startsWith(`(deny ${ops}`) && l.includes(`(subpath ${q(path)})`)).length

    it('linux, shell: a tmpfs over the project first, then the git dir back, read-only, on top of it', async () => {
      const { top, pin } = linked()
      const { svc } = service({ ...LINUX, originOf: () => 'im', repoPin: () => pin })
      const plan = await svc.plan('true', { ...session(), cwd: top }, baseEnv)
      plan.release()
      const tmpfs = plan.args.findIndex((a, i) => a === '--tmpfs' && plan.args[i + 1] === repo)
      expect(tmpfs).toBeGreaterThan(-1)
      const gitBind = plan.args.findIndex((a, i) => a === '--bind' && plan.args[i + 1] === commonDir())
      expect(gitBind).toBeGreaterThan(tmpfs)
      const lastRo = plan.args.reduce((at, a, i) => (a === '--ro-bind' && plan.args[i + 1] === commonDir() ? i : at), -1)
      expect(lastRo).toBeGreaterThan(gitBind)
      // and nothing else of the project is mounted back
      for (const flag of ['--bind', '--ro-bind']) for (const src of argPairs(plan.args, flag)) if (src.startsWith(`${repo}/`)) expect(src.startsWith(`${commonDir()}`), src).toBe(true)
    })

    it('linux, delegated: planExec has the same tmpfs', async () => {
      const { top, pin } = linked()
      const { svc } = service({ ...LINUX, originOf: () => 'im', repoPin: () => pin })
      const plan = await svc.planExec('/bin/true', [], { ...session(), cwd: top }, baseEnv, PLAN)
      plan.release()
      expect(argPairs(plan.args, '--tmpfs')).toContain(repo)
    })

    it('linux, a project that is not the main checkout: the recorded top is hidden as well', async () => {
      const { top, pin } = linked()
      const other = join(root, 'other')
      mkdirSync(other)
      const { svc } = service({ ...LINUX, originOf: () => 'im', repoPin: () => pin, projectTopOf: () => other })
      const plan = await svc.plan('true', { ...session(), cwd: top }, baseEnv)
      plan.release()
      expect(argPairs(plan.args, '--tmpfs')).toEqual(expect.arrayContaining([repo, other]))
    })

    it.each(['app', 'acp', 'schedule'] as const)('%s: the project is not hidden', async origin => {
      const { top, pin } = linked()
      const { svc } = service({ ...LINUX, originOf: () => origin, repoPin: () => pin, projectTopOf: () => repo })
      const plan = await svc.plan('true', { ...session(), cwd: top }, baseEnv)
      plan.release()
      expect(argPairs(plan.args, '--tmpfs')).not.toContain(repo)
    })

    it('an IM session whose cwd is in the top: not a worktree of it, nothing to hide', async () => {
      const { svc } = service({ originOf: () => 'im' })
      const plan = await svc.plan('true', session(), baseEnv)
      plan.release()
      expect(denyLines(plan.args[1]!, 'file-read', repo)).toBe(0)
    })

    it('darwin: read and write denied at the top, the git dir back, the top itself metadata only', async () => {
      const { top, pin } = linked()
      const { svc } = service({ originOf: () => 'im', repoPin: () => pin })
      const plan = await svc.plan('true', { ...session(), cwd: top }, baseEnv)
      plan.release()
      const profile = plan.args[1]!
      expect(denyLines(profile, 'file-read', repo)).toBe(1)
      expect(denyLines(profile, 'file-write', repo)).toBeGreaterThan(0)
      expect(profile.split('\n').some(l => l.startsWith('(allow file-read* ') && l.includes(`(subpath ${q(commonDir())})`))).toBe(true)
      expect(profile).toContain(`(allow file-read-metadata (literal ${q(repo)})`)
      expect(profile.indexOf(`(allow file-read-metadata`)).toBeGreaterThan(profile.indexOf(`(deny file-read* `))
    })

    it('the policy for a translated executor says the same, only for IM', () => {
      const { top, pin } = linked()
      const im = service({ originOf: () => 'im', repoPin: () => pin }).svc.execPolicy('s1', top, 'codex')
      expect(im.denyRead).toContain(repo)
      expect(im.keepRead).toEqual([commonDir(), pin.gitDir])
      const app = service({ originOf: () => 'app', repoPin: () => pin }).svc.execPolicy('s1', top, 'codex')
      expect(app.denyRead).not.toContain(repo)
      expect(app.keepRead).toBeUndefined()
    })
  })

  it('level none: no plan to put it in. The gate asks for every command instead', async () => {
    const { svc } = service({ originOf: () => 'im', detected: { level: 'none', missing: ['sandbox-exec'] } })
    expect((await svc.plan('true', session(), baseEnv)).sandboxed).toBe(false)
  })
})

describe('plans without hide or exactHosts (09 Task 1)', () => {
  /**
   * no-hide-plans.golden.json 是改动之前(bd8c6925)的代码生成的。允许多出来的只有:插件存储根(M13),它进持久化清单;
   * cargo、gem 的凭据文件(09 Task 9 C1),它们进凭据清单。
   * 路径换成 <ROOT>;代理是假的,端口固定。bwrap 的行要看宿主的 /run,Linux 上不比
   */
  const GOLDEN = join(__dirname, '../../test/fixtures/plugins/no-hide-plans.golden.json')
  const PORT = 4242
  const fixedProxy = (sock: string) => async (_o: ProxyOptions) =>
    ({ port: PORT, unixPath: sock, closing: false, closed: new Promise<void>(() => {}), touch() {}, close: async () => {} }) as unknown as ProxyHandle

  async function plans(platform: 'darwin' | 'linux'): Promise<Record<string, string[]>> {
    const auth = join(home, '.qoder', '.auth')
    const logs = join(home, '.qoder', 'logs')
    mkdirSync(auth, { recursive: true })
    mkdirSync(logs)
    const sock = join(root, 'net.sock')
    writeFileSync(sock, '')
    const base: Partial<SandboxOpts> = {
      platform,
      env: { HOME: home },
      execPath: '/opt/mff/mff',
      uid: 1000,
      startProxy: fixedProxy(sock),
      ...(platform === 'linux' && { detected: { level: 'full', missing: [], bwrap: '/usr/bin/bwrap' } }),
    }
    const opts: ExecPlanOpts = { allowRead: [auth], allowWrite: [auth, logs], allowHosts: ['*.qoder.sh'], proxyScope: 'run_1', readOnly: false, denyRead: [join(home, 'secret')], denyWrite: [join(repo, 'sub', 'gen')] }
    const out: Record<string, string[]> = {}
    const shot = (name: string, p: { args: string[]; release(): void }) => {
      p.release()
      out[`${platform} ${name}`] = p.args.map(a => a.split(root).join('<ROOT>'))
    }
    shot('shell', await service(base).svc.plan('true', session(), baseEnv))
    shot('exec', await service(base).svc.planExec('/opt/q/qodercli', ['-p'], session(), baseEnv, opts))
    shot('exec read-only', await service(base).svc.planExec('/opt/q/qodercli', ['-p'], session(), baseEnv, { ...opts, readOnly: true }))
    shot('loopback', await service({ ...base, config: () => cfg({}, { allowLoopback: true }) }).svc.plan('true', session(), baseEnv))
    const top = join(root, 'wt')
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e.invalid', 'commit', '-q', '--allow-empty', '-m', 'i'], { cwd: repo, env: gitTestEnv() })
    execFileSync('git', ['worktree', 'add', '-q', '--detach', top, 'HEAD'], { cwd: repo, env: gitTestEnv() })
    const pin = pinFromPaths(top, join(repo, '.git', 'worktrees', 'wt'), join(repo, '.git'))
    shot('im', await service({ ...base, originOf: () => 'im', repoPin: () => pin }).svc.plan('true', { ...session(), cwd: top }, baseEnv))
    return out
  }

  /** 存储根在配置里的每一处(前面的空格一起去掉);bwrap 只挂存在的路径,这里它不存在 */
  const withoutStore = (args: string[]) => args.map(a => a.replace(/ \((?:subpath|literal) "<ROOT>\/data-plugins"\)/g, '').replace(/ \((?:subpath|literal) "<ROOT>\/[^"]*\/\.(?:cargo\/credentials(?:\.toml)?|gem\/credentials)"\)/g, ''))

  it.each(['darwin', 'linux'] as const)('%s: byte-identical to before, apart from the store root and the new credential files', async platform => {
    if (platform === 'linux' && process.platform === 'linux') return
    const now = await plans(platform)
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, string[]>
    for (const [name, args] of Object.entries(now)) expect(withoutStore(args), name).toEqual(golden[name])
    expect(Object.keys(now).length).toBe(5)
  })
})

describe('planExec with hide, tmpDir, exactHosts (09 Task 1, M1, M4, M5, M13)', () => {
  const lines = (profile: string, head: string) => profile.split('\n').filter(l => l.startsWith(head))
  const subpath = (x: string) => `(subpath ${q(x)})`
  const literal = (x: string) => `(literal ${q(x)})`
  const base = (over: Partial<ExecPlanOpts> = {}): ExecPlanOpts => ({ allowRead: [], allowWrite: [], allowHosts: [], proxyScope: 'mcp_1', readOnly: true, denyRead: [], denyWrite: [], ...over })
  const LINUX: Partial<SandboxOpts> = { platform: 'linux', detected: { level: 'full', missing: [], bwrap: '/usr/bin/bwrap' }, execPath: '/opt/mff/mff', uid: 1000, env: { HOME: home } }
  const linux = (): Partial<SandboxOpts> => ({ ...LINUX, env: { HOME: home } })
  const app = (args: string[], ...want: string[]) => {
    for (let i = 0; i <= args.length - want.length; i++) if (want.every((w, j) => args[i + j] === w)) return i
    return -1
  }

  async function darwin(over: Partial<ExecPlanOpts>, opts: Parameters<typeof service>[0] = {}, s = session('s1', repo)) {
    const plan = await service(opts).svc.planExec('/opt/m/server', ['--x'], s, baseEnv, base(over))
    plan.release()
    return { plan, profile: profileOf(plan.args) }
  }

  describe('hide on Seatbelt', () => {
    it('tops are denied for reading, keep comes back after them, ancestors get metadata only', async () => {
      const code = join(home, 'store', 'p', 'abc')
      const { profile } = await darwin({ hide: { tops: [home], keep: [repo, code] } })
      const denied = lines(profile, '(deny file-read* ')[0]
      const opened = lines(profile, '(allow file-read* ')[0]
      expect(denied).toContain(subpath(home))
      expect(opened).toContain(subpath(repo))
      expect(opened).toContain(subpath(code))
      expect(profile.indexOf(opened)).toBeGreaterThan(profile.indexOf(denied))
      const traverse = lines(profile, '(allow file-read-metadata ')[0]
      // 祖先到隐藏的根(含),不含 keep 自己
      for (const a of [home, join(home, 'store'), join(home, 'store', 'p')]) expect(traverse).toContain(literal(a))
      expect(traverse).not.toContain(literal(code))
      expect(traverse).not.toContain(literal(repo))
      expect(opened).not.toContain(subpath(home))
    })

    it('traverse covers keep, allowRead, the tmp dir and the spill dir, up to the top and through the data dir', async () => {
      const inData = join(dataDir, 'plugin-data', 'p', 'srv')
      const tmpDir = join(dataDir, 'sessions', 's1', 'mcp', 'h', 'tmp')
      const spill = join(home, 'spills', 'empty')
      const { profile } = await darwin({ allowRead: [inData], allowWrite: [inData], tmpDir, hide: { tops: [root], keep: [join(home, 'a', 'b')] } }, {}, { ...session('s1', repo), spillDir: spill })
      const traverse = lines(profile, '(allow file-read-metadata ')[0]
      for (const a of [root, home, join(home, 'a'), dataDir, join(dataDir, 'plugin-data'), join(dataDir, 'plugin-data', 'p'), join(dataDir, 'sessions', 's1', 'mcp', 'h'), join(home, 'spills')]) expect(traverse).toContain(literal(a))
    })

    it('a credential root or the data dir under a kept path stays closed, after the re-allow', async () => {
      const kept = home
      const { profile } = await darwin({ hide: { tops: [root], keep: [kept] } })
      const final = lines(profile, '(deny file-read* ')[1]
      expect(final).toContain(subpath(join(home, '.ssh')))
      expect(profile.indexOf(final)).toBeGreaterThan(profile.indexOf(lines(profile, '(allow file-read* ')[0]))
      const nestedData = await darwin({ hide: { tops: ['/opt/mff-unrelated-top'], keep: [root] } })
      expect(lines(nestedData.profile, '(deny file-read* ')[1]).toContain(subpath(dataDir))
    })

    it('a kept path inside a credential root or the data dir is dropped, spelled through a link too', async () => {
      symlinkSync(join(home, '.ssh'), join(home, 'nice'))
      const { profile } = await darwin({ hide: { tops: [home], keep: [join(home, '.ssh', 'k'), join(dataDir, 'x'), join(home, 'nice', 'k')] } })
      const opened = lines(profile, '(allow file-read* ')[0]
      expect(opened).not.toContain(join(home, '.ssh', 'k'))
      expect(opened).not.toContain(join(dataDir, 'x'))
      expect(opened).not.toContain(join(home, 'nice'))
    })

    describe('a kept path that holds a top is refused: re-allow comes after the deny, so the top would be open', () => {
      const kept = () => join(home, '.nvm', 'v1')
      const refused: [string, () => { tops: string[]; keep: string[] }, () => string][] = [
        ['the cwd is the parent of the store', () => ({ tops: [home, join(home, '.mff-plugins')], keep: [home] }), () => repo],
        ["cwd:'none' with the cwd inside the runtime root", () => ({ tops: [home, join(kept(), 'lib', 'proj')], keep: [kept()] }), () => join(kept(), 'lib', 'proj')],
        ['the same path on both sides', () => ({ tops: [home], keep: [home] }), () => repo],
        ['a program in /bin: the runtime root would be /', () => ({ tops: [home], keep: ['/'] }), () => repo],
      ]
      it.each(refused)('%s', async (_n, hide, cwd) => {
        const started: ProxyOptions[] = []
        const tmpDir = join(dataDir, 'sessions', 's1', 'mcp', 'h', 'tmp')
        for (const platform of [{}, linux()]) {
          const { svc } = service({ ...platform, startProxy: async o => { started.push(o); return startProxy(o) } })
          await expect(svc.planExec('/opt/m/server', [], { ...session('s1', repo), cwd: cwd() }, baseEnv, base({ tmpDir, hide: hide() }))).rejects.toThrow(/holds a hidden root/)
        }
        expect(started).toEqual([])
        expect(existsSync(tmpDir)).toBe(false)
      })

      it('spelled through a link too', async () => {
        const real = join(root, 'real')
        mkdirSync(join(real, 'store'), { recursive: true })
        symlinkSync(real, join(home, 'link'))
        await expect(darwin({ hide: { tops: [join(real, 'store')], keep: [join(home, 'link')] } })).rejects.toThrow(/holds a hidden root/)
        await expect(darwin({ hide: { tops: [join(home, 'link', 'store')], keep: [real] } })).rejects.toThrow(/holds a hidden root/)
      })

      it('a scope that is released again: the next plan of that scope still runs', async () => {
        const { svc } = service()
        await expect(svc.planExec('/opt/m/server', [], session('s1', repo), baseEnv, base({ hide: { tops: [home], keep: [home] } }))).rejects.toThrow(/holds a hidden root/)
        const plan = await svc.planExec('/opt/m/server', [], session('s1', repo), baseEnv, base({ hide: { tops: [home], keep: [repo] } }))
        plan.release()
        expect(plan.sandboxed).toBe(true)
      })

      it('a kept path under a top, or a sibling with the same prefix: fine', async () => {
        const { plan } = await darwin({ hide: { tops: [join(home, 'store'), home], keep: [repo, join(home, 'store', 'p'), join(home, 'store-not')] } }, {})
        expect(plan.sandboxed).toBe(true)
      })
    })

    it('without hide an allowRead stays what it was: no extra traverse', async () => {
      const { profile } = await darwin({ allowRead: [join(home, '.qoder', '.auth')] })
      expect(lines(profile, '(allow file-read-metadata ')).toEqual([])
    })

    it('merged with an IM session: both sets of tops, both sets of keep', async () => {
      const top = join(root, 'wt')
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e.invalid', 'commit', '-q', '--allow-empty', '-m', 'i'], { cwd: repo, env: gitTestEnv() })
      execFileSync('git', ['worktree', 'add', '-q', '--detach', top, 'HEAD'], { cwd: repo, env: gitTestEnv() })
      const pin = pinFromPaths(top, join(repo, '.git', 'worktrees', 'wt'), join(repo, '.git'))
      const kept = join(root, 'other', 'kept')
      const { profile } = await darwin({ hide: { tops: [join(root, 'other')], keep: [kept] } }, { originOf: () => 'im', repoPin: () => pin }, { ...session(), cwd: top })
      const denied = lines(profile, '(deny file-read* ')[0]
      expect(denied).toContain(subpath(repo))
      expect(denied).toContain(subpath(join(root, 'other')))
      const opened = lines(profile, '(allow file-read* ')[0]
      expect(opened).toContain(subpath(join(repo, '.git')))
      expect(opened).toContain(subpath(kept))
    })

    it('a writable cwd under hide brings no git dir outside it', async () => {
      const top = join(root, 'wt')
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e.invalid', 'commit', '-q', '--allow-empty', '-m', 'i'], { cwd: repo, env: gitTestEnv() })
      execFileSync('git', ['worktree', 'add', '-q', '--detach', top, 'HEAD'], { cwd: repo, env: gitTestEnv() })
      const pin = pinFromPaths(top, join(repo, '.git', 'worktrees', 'wt'), join(repo, '.git'))
      const { profile } = await darwin({ readOnly: false, hide: { tops: [home], keep: [top] } }, { originOf: () => 'app', repoPin: () => pin }, { ...session(), cwd: top })
      const writable = lines(profile, '(allow file-write* ')[0]
      expect(writable).toContain(subpath(top))
      expect(writable).not.toContain(subpath(join(repo, '.git')))
    })

    it('rejects a bad path in hide before anything starts', async () => {
      const started: ProxyOptions[] = []
      const { svc } = service({ startProxy: async o => { started.push(o); return startProxy(o) } })
      for (const hide of [{ tops: ['rel'], keep: [] }, { tops: [], keep: ['/a/../b'] }]) {
        await expect(svc.planExec('/opt/m/server', [], session(), baseEnv, base({ hide }))).rejects.toThrow()
      }
      await expect(svc.planExec('/opt/m/server', [], session(), baseEnv, base({ tmpDir: 'rel/tmp' }))).rejects.toThrow()
      expect(started).toEqual([])
    })
  })

  describe('tmpDir', () => {
    it('replaces TMPDIR and the writable temp dir; the session tmp is not made, not writable, not readable', async () => {
      const tmpDir = join(dataDir, 'sessions', 's1', 'mcp', 'h', 'tmp')
      const { plan, profile } = await darwin({ tmpDir })
      expect(plan.env.TMPDIR).toBe(tmpDir)
      expect(statSync(tmpDir).mode & 0o777).toBe(0o700)
      const sessionTmp = sessionTmpDir(dataDir, 's1')
      expect(existsSync(sessionTmp)).toBe(false)
      expect(lines(profile, '(allow file-write* ')[0]).toContain(subpath(tmpDir))
      expect(profile).not.toContain(subpath(sessionTmp))
    })

    it('a tmpDir that is a link: refused', async () => {
      const tmpDir = join(root, 'linked')
      symlinkSync(join(home, '.ssh'), tmpDir)
      await expect(darwin({ tmpDir })).rejects.toThrow(/not a directory/)
    })

    it('the startup wipe takes <sid>/mcp along with <sid>/tmp, and nothing else', () => {
      const mcp = join(dataDir, 'sessions', 's1', 'mcp', 'h', 'tmp')
      const spill = join(dataDir, 'sessions', 's1', 'spill')
      for (const d of [mcp, spill, sessionTmpDir(dataDir, 's1')]) mkdirSync(d, { recursive: true })
      wipeSessionTmp(dataDir)
      expect(existsSync(join(dataDir, 'sessions', 's1', 'mcp'))).toBe(false)
      expect(existsSync(sessionTmpDir(dataDir, 's1'))).toBe(false)
      expect(existsSync(spill)).toBe(true)
    })
  })

  describe('exactHosts (M1)', () => {
    const DEFAULTS = () => cfg({ network: { allow: ['github.com'] } }, { allowLoopback: true })

    it('the allow list holds only the hosts; without it the default list is added', async () => {
      const seen: ProxyOptions[] = []
      const { svc } = service({ config: DEFAULTS, startProxy: async o => { seen.push(o); return startProxy(o) } })
      const a = await svc.planExec('/opt/m/server', [], session(), baseEnv, base({ allowHosts: ['api.example.com'], exactHosts: true }))
      a.release()
      const b = await svc.planExec('/opt/m/server', [], session(), baseEnv, base({ allowHosts: ['api.example.com'], proxyScope: 'run_2' }))
      b.release()
      expect(seen[0].allow()).toEqual(['api.example.com'])
      expect(seen[1].allow()).toEqual(['github.com', 'api.example.com'])
    })

    it('the proxy itself refuses a host on the default list', async () => {
      const { svc } = service({ config: DEFAULTS, lookup: async () => [{ address: '93.184.216.34', family: 4 }] })
      const plan = await svc.planExec('/opt/m/server', [], session(), baseEnv, base({ exactHosts: true }))
      expect(await connectStatus(portOf(plan.env), 'github.com:443')).toMatch(/ 403 /)
      plan.release()
    })

    it('loopback stays closed in the profile and the env, whatever the config says', async () => {
      const on = await darwin({ exactHosts: true }, { config: DEFAULTS })
      expect(on.profile).not.toContain('localhost:*')
      const off = await darwin({ proxyScope: 'run_2' }, { config: DEFAULTS })
      expect(off.profile).toContain('localhost:*')
      expect(on.plan.env.NO_PROXY).toBe('')
      expect(on.plan.env.no_proxy).toBe('')
      expect(off.plan.env.NO_PROXY).toContain('127.0.0.1')
    })
  })

  describe('the store root (M13)', () => {
    it('is write-denied and can not be moved, even with cwd = home; it stays readable', async () => {
      const store = pluginStoreRootOf(join(home, '.mff'))
      const plan = await service({ dataDir: join(home, '.mff') }).svc.plan('true', session('s1', home), baseEnv)
      plan.release()
      const profile = profileOf(plan.args)
      expect(lines(profile, '(deny file-write* ')[0]).toContain(subpath(store))
      expect(lines(profile, '(deny file-write-unlink ')[0]).toContain(literal(store))
      for (const l of lines(profile, '(deny file-read* ')) expect(l).not.toContain(store)
    })

    it('execPolicy lists it among the persistence paths, last', () => {
      const p = service().svc.execPolicy('s1', repo)
      expect(p.persistence).toContain(pluginStoreRootOf(dataDir))
    })

    it('bwrap: mounted back read-only when it exists inside a writable root', async () => {
      const data = join(home, '.mff')
      const store = pluginStoreRootOf(data)
      mkdirSync(data)
      mkdirSync(store)
      const plan = await service({ ...linux(), env: { HOME: home }, dataDir: data }).svc.plan('true', session('s1', home), baseEnv)
      plan.release()
      expect(app(plan.args, '--ro-bind', store, store)).toBeGreaterThan(app(plan.args, '--bind', home, home))
    })
  })

  describe('hide on bwrap', () => {
    it('tops first, keep read-only after them, credentials hidden after keep', async () => {
      const kept = join(home, 'kept')
      const cred = join(home, '.ssh')
      mkdirSync(kept)
      const plan = await service(linux()).svc.planExec('/opt/m/server', [], session('s1', repo), baseEnv, base({ hide: { tops: [root], keep: [kept, home] } }))
      plan.release()
      const a = plan.args
      const top = app(a, '--tmpfs', root)
      expect(top).toBeGreaterThan(-1)
      expect(app(a, '--ro-bind', kept, kept)).toBeGreaterThan(top)
      expect(app(a, '--ro-bind', home, home)).toBeGreaterThan(top)
      expect(app(a, '--tmpfs', cred)).toBeGreaterThan(app(a, '--ro-bind', home, home))
    })

    it('an allowWrite under a top is bound, because hide asked for it; an IM top still drops one', async () => {
      const data = join(dataDir, 'plugin-data', 'p', 's')
      mkdirSync(data, { recursive: true })
      const plan = await service(linux()).svc.planExec('/opt/m/server', [], session('s1', repo), baseEnv, base({ allowRead: [data], allowWrite: [data], hide: { tops: [root], keep: [repo] } }))
      plan.release()
      expect(app(plan.args, '--bind', data, data)).toBeGreaterThan(app(plan.args, '--tmpfs', dataDir))
    })

    it('a cwd that is hidden is not bound back, and the plan still chdirs into its empty tmpfs', async () => {
      const plan = await service(linux()).svc.planExec('/opt/m/server', [], session('s1', repo), baseEnv, base({ hide: { tops: [home, repo], keep: [] } }))
      plan.release()
      expect(app(plan.args, '--tmpfs', repo)).toBeGreaterThan(-1)
      expect(app(plan.args, '--ro-bind', repo, repo)).toBe(-1)
      expect(app(plan.args, '--bind', repo, repo)).toBe(-1)
      expect(app(plan.args, '--ro-bind', join(repo, '.git'), join(repo, '.git'))).toBe(-1)
      expect(app(plan.args, '--chdir', repo)).toBeGreaterThan(-1)
    })

    it('a git dir outside what is kept stays hidden', async () => {
      const top = join(root, 'wt')
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e.invalid', 'commit', '-q', '--allow-empty', '-m', 'i'], { cwd: repo, env: gitTestEnv() })
      execFileSync('git', ['worktree', 'add', '-q', '--detach', top, 'HEAD'], { cwd: repo, env: gitTestEnv() })
      const pin = pinFromPaths(top, join(repo, '.git', 'worktrees', 'wt'), join(repo, '.git'))
      const plan = await service({ ...linux(), originOf: () => 'app', repoPin: () => pin }).svc.planExec('/opt/m/server', [], { ...session(), cwd: top }, baseEnv, base({ hide: { tops: [home], keep: [top] } }))
      plan.release()
      expect(plan.args.filter(x => x.startsWith(join(repo, '.git')))).toEqual([])
    })

    it('the relay program at the top of a hidden root still refuses', async () => {
      const sock = join(root, 'net.sock')
      writeFileSync(sock, '')
      const exe = join(home, 'electron')
      writeFileSync(exe, '')
      const { svc } = service({
        ...linux(), execPath: exe,
        startProxy: async () => ({ port: 1, unixPath: sock, closing: false, closed: new Promise<void>(() => {}), touch() {}, close: async () => {} }) as unknown as ProxyHandle,
      })
      await expect(svc.planExec('/opt/m/server', [], session('s1', repo), baseEnv, base({ hide: { tops: [home], keep: [repo] } }))).rejects.toThrow(/hidden checkout/)
    })
  })

  describe('execPolicy.untranslatedPaths (M10)', () => {
    const parsed = (...specs: { effect: 'deny' | 'ask' | 'allow'; rule: string }[]) => specs.map((sp, i) => parseRule(sp, i) as Rule)
    it('counts path rules only; untranslatedRules still counts the shell ones', () => {
      const policy = (r: Rule[]) => service({ rules: () => r }).svc.execPolicy('s1', repo)
      const shell = policy(parsed({ effect: 'deny', rule: 'shell(git push*)' }))
      expect(shell.untranslatedPaths).toBe(0)
      expect(shell.untranslatedRules).toBe(1)
      const path = policy(parsed({ effect: 'deny', rule: 'read(**/x*)' }))
      expect(path.untranslatedPaths).toBe(1)
      expect(path.untranslatedRules).toBe(1)
      expect(policy([]).untranslatedPaths).toBe(0)
    })
  })
})

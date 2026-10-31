// 内核 `sandbox` 服务(05 spec §10、§11):级别、每会话临时目录与代理、每条 shell 命令的执行计划。
// - 级别 = 启动时探测的结果 + 现读的配置(enabled、allowLoopback)+ 最近一次代理启动是否失败;
// - 黑名单 / 持久化清单都从内核启动时的环境快照算(与权限门同一份),不读 process.env;
//   含 `..` 等坏值的条目丢掉(其解析后的形态已在清单里):一个坏环境变量不能让所有命令都跑不了;
// - cwd / 临时目录等自身路径坏了照样抛错:plan reject,调用方让命令失败,绝不退回无沙箱执行;
// - 代理每会话一个,按需启动;命令在跑(plan 之后、release 之前)时保持不关,之后按空闲关闭。
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, type Dirent } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix, resolve } from 'node:path'
import type { KernelEvent, PermissionsConfig, SandboxStatus } from '../protocol/index'
import { canonicalRoots, credentialRoots, persistenceRoots, type EnvSnapshot } from '../lib/fs/paths'
import { createGit, type Git } from '../lib/git/snapshot'
import { bwrapArgs, ensureGitHooksDir, execRootFor } from '../lib/sandbox/bwrap'
import type { DetectResult } from '../lib/sandbox/detect'
import { startProxy as realStartProxy, type DenyEvent, type LookupFn, type ProxyHandle, type ProxyOptions, type Upstream } from '../lib/sandbox/net/proxy'
import { cleanPath, realSpelling, within } from '../lib/sandbox/paths'
import { RELAY_PORT } from '../lib/sandbox/relay'
import { sandboxExecArgs, seatbeltProfile } from '../lib/sandbox/seatbelt'
import { redact } from '../lib/tools/redact'
import { sandboxEnv } from '../lib/tools/shellEnv'
import type { SandboxService, ShellPlan } from '../lib/tools/types'
import { nullLogger, type Logger } from './log'

const SAFE_ID = /^[A-Za-z0-9_-]+$/
const MAX_MODULE_DIRS = 2000
/**
 * 已认出的 git 目录里不往下走的子目录(final review I1、M1):objects / refs / logs 体量大;hooks / info / lfs / branches
 * 是 git 内部目录,里面不会有子模块(git 拒绝在另一个子模块的 git 目录里放 git 目录)。只在"直接位于已认出的 git 目录里"时跳过:
 * 名为 vendor/logs 的子模块在 modules/vendor/logs,vendor 不是 git 目录,logs 照样要走、要认
 */
const GIT_INTERNAL_DIRS = new Set(['objects', 'refs', 'logs', 'hooks', 'info', 'lfs', 'branches'])
const DEFAULT_IDLE_MS = 600_000

/** 本会话临时目录(= 沙箱里的 TMPDIR);只给路径 */
export function sessionTmpDir(dataDir: string, sessionId: string): string {
  if (!SAFE_ID.test(sessionId)) throw new Error('invalid session id')
  return join(dataDir, 'sessions', sessionId, 'tmp')
}

/** 工作进程启动时清空所有会话的 tmp(语义上是临时的)。tmp 是链接时只删链接 */
export function wipeSessionTmp(dataDir: string, log: Logger = nullLogger): void {
  const dir = join(dataDir, 'sessions')
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const d of entries) {
    if (!d.isDirectory() || !SAFE_ID.test(d.name)) continue
    try {
      rmSync(join(dir, d.name, 'tmp'), { recursive: true, force: true })
    } catch (err) {
      log.warn('wipe session tmp failed', { sessionId: d.name, error: String(err) })
    }
  }
}

export interface SandboxOpts {
  platform: NodeJS.Platform
  dataDir: string
  home: string
  /** 内核启动时的环境快照(黑名单 / 持久化 / bwrap 的 HOME 与 socket 变量都从它取) */
  env: EnvSnapshot
  detected: DetectResult
  /** 现读的权限配置 */
  permissions: () => PermissionsConfig
  append: (e: Omit<KernelEvent, 'seq' | 'ts'>) => void
  /** 会话当前的 turn(拦截事件按 turn 去重) */
  currentTurn?: (sessionId: string) => string | undefined
  /** Linux 中转用的可执行文件;默认 process.execPath */
  execPath?: string
  upstream?: Upstream
  lookup?: LookupFn
  /** 代理空闲多久关闭;默认 10 分钟 */
  idleMs?: number
  /** 查 gitDir 用的 git;默认 createGit({ base: env }) */
  git?: Git
  /** 代理 Unix socket 的父目录(不能在沙箱可写范围内);默认 os.tmpdir() */
  proxyParent?: string
  uid?: number
  log?: Logger
  /** 测试注入 */
  startProxy?: (o: ProxyOptions) => Promise<ProxyHandle>
}

interface SessionProxy {
  handle?: ProxyHandle
  /** 本会话最近一次启动代理失败(级别按会话算,review M3) */
  failed: boolean
  starting?: Promise<ProxyHandle | undefined>
  holds: number
  keepalive?: NodeJS.Timeout
  denied: { turn?: string; keys: Set<string> }
}

interface RepoGit {
  gitDirs: string[]
  /** worktree 时工作树根里的 `.git` 文件(或链接) */
  cwdGitFile?: string
}

export function createSandboxService(o: SandboxOpts): SandboxService {
  const log = o.log ?? nullLogger
  const platform = o.platform
  const git = o.git ?? createGit({ base: o.env as NodeJS.ProcessEnv })
  const start = o.startProxy ?? realStartProxy
  const idleMs = o.idleMs ?? DEFAULT_IDLE_MS
  const execPath = o.execPath ?? process.execPath
  const proxies = new Map<string, SessionProxy>()
  const repos = new Map<string, Promise<RepoGit>>()
  let closed = false

  /** 这个级别下命令是否经会话代理上网:macOS 总是;Linux 只有 full(网络命名空间 + 中转) */
  const usesProxy = () => platform === 'darwin' || (platform === 'linux' && o.detected.level === 'full')

  /** 级别:探测结果 + 现读的配置 + 代理是否失败(status 看任一会话,plan 只看本会话) */
  function levelOf(c: PermissionsConfig, proxyFailed: boolean): Pick<SandboxStatus, 'level' | 'missing'> {
    if (!c.sandbox.enabled) return { level: 'none', missing: ['disabled'] }
    let level = o.detected.level
    const missing = [...o.detected.missing]
    if (level !== 'none') {
      if (platform === 'darwin' && c.sandbox.allowLoopback) {
        level = 'partial'
        missing.push('loopback')
      }
      if (proxyFailed && usesProxy()) {
        level = 'partial'
        missing.push('proxy')
      }
    }
    return { level, missing }
  }

  /** 有 sessionId:算上该会话最近一次代理启动是否失败;没有:只看探测与配置(一个会话的代理坏了不影响别的会话,re-review N1) */
  function status(sessionId?: string): SandboxStatus {
    const c = o.permissions()
    const r = levelOf(c, sessionId !== undefined && proxies.get(sessionId)?.failed === true)
    return { ...r, autoDegraded: r.level === 'none' && !c.allowUnsandboxedAuto }
  }

  // ---- 清单(每次 plan 现算:之后才建出的 ~/.ssh 链接也拦得住)----

  let warnedDrop = false
  /** 环境快照来的条目:坏值(`..`、相对、控制字符)丢掉,不让每条命令都失败 */
  const usable = (paths: string[]) =>
    paths.filter(p => {
      try {
        cleanPath(p, 'sandbox')
        return true
      } catch {
        if (!warnedDrop) log.warn('sandbox dropped an unusable deny path (from an env var)')
        warnedDrop = true
        return false
      }
    })
  const credentialList = () => usable(canonicalRoots(credentialRoots(o.home, platform, o.env), { platform }))
  const persistenceList = () => usable(canonicalRoots(persistenceRoots(o.home, platform, o.env), { platform }))

  /** 路径本身 + 它在某个可写根里(严格在内)的各级父目录;原样与 realpath 两种拼写 */
  function withAncestors(paths: string[], writable: string[]): string[] {
    const roots = [...new Set(writable.flatMap(w => [w, realSpelling(w)]))]
    const out = new Set<string>()
    for (const raw of paths) {
      for (const p of new Set([raw, realSpelling(raw)])) {
        out.add(p)
        for (let a = posix.dirname(p); a !== '/' && a !== posix.dirname(a); a = posix.dirname(a)) {
          if (roots.some(r => a !== r && within(a, r))) out.add(a)
        }
      }
    }
    return [...out]
  }

  // ---- git ----

  /**
   * git 的答案(review I1):不用 --path-format(git 2.31 才有,旧版原样回显未知参数且退出 0),相对结果按 cwd 解析。
   * 结果第一行像参数(`-` 开头,更老的 git 不认 --git-common-dir)也当没答上来
   */
  async function askGit(cwd: string): Promise<{ repo?: RepoGit; ran: boolean }> {
    let r: Awaited<ReturnType<Git>>
    try {
      r = await git(['rev-parse', '--git-common-dir'], { cwd })
    } catch (err) {
      log.warn('sandbox git lookup failed', { error: String(err) })
      return { ran: false }
    }
    const line = r.code === 0 ? r.stdout.toString().split('\n')[0] : ''
    if (!line || line.startsWith('-')) return { ran: r.code !== 0 } // 非 0 = 确实不是仓库(仍要走一遍目录兜底)
    try {
      const gitDir = realpathSync.native(resolve(cwd, line))
      let cwdGitFile: string | undefined
      const t = await git(['rev-parse', '--show-toplevel'], { cwd })
      const top = t.code === 0 ? t.stdout.toString().split('\n')[0] : ''
      if (top.startsWith('/')) {
        const f = join(realpathSync.native(top), '.git')
        try {
          if (!lstatSync(f).isDirectory()) cwdGitFile = f
        } catch {
          // 没有 .git(GIT_DIR 之类):不保护
        }
      }
      return { repo: { gitDirs: [gitDir], cwdGitFile }, ran: true }
    } catch (err) {
      log.warn('sandbox git lookup failed', { error: String(err) })
      return { ran: false }
    }
  }

  /**
   * 兜底(git 不在 / 太老 / 出错):从 cwd 往上找 `.git`。目录 → 它就是 gitDir;文件 → 按 `gitdir:` 与 commondir 解析。
   * 有 `.git` 却解析不出 → 抛错(命令失败,不在没有 git 保护的情况下跑)
   */
  function walkGit(cwd: string): RepoGit {
    for (let d = cwd; ; d = posix.dirname(d)) {
      const p = join(d, '.git')
      let st
      try {
        st = lstatSync(p)
      } catch {
        if (d === posix.dirname(d)) return { gitDirs: [] }
        continue
      }
      try {
        if (st.isDirectory()) return { gitDirs: [realpathSync.native(p)] }
        if (st.isSymbolicLink() && statSync(p).isDirectory()) return { gitDirs: [realpathSync.native(p)], cwdGitFile: p }
        const m = /^gitdir:[ \t]*(.+?)[ \t]*$/m.exec(readFileSync(p, 'utf8'))
        if (!m) throw new Error('no gitdir line')
        const gd = realpathSync.native(resolve(d, m[1]))
        let common = gd
        try {
          common = realpathSync.native(resolve(gd, readFileSync(join(gd, 'commondir'), 'utf8').trim()))
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
        }
        return { gitDirs: [common], cwdGitFile: p }
      } catch (err) {
        throw new Error(`sandbox: can't resolve the git dir of ${JSON.stringify(p)}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  const MAX_REPOS = 256

  /** 一个会话查一次;git 没答上来的结果不缓存(review M6) */
  async function repoFor(sessionId: string, cwd: string): Promise<RepoGit> {
    const key = `${sessionId}\0${cwd}`
    const cached = repos.get(key)
    if (cached) return cached
    const a = await askGit(cwd)
    if (a.repo) {
      remember(key, a.repo)
      return a.repo
    }
    const walked = walkGit(cwd)
    if (a.ran && walked.gitDirs.length === 0) remember(key, walked) // git 说不是仓库,目录里也没有 .git
    return walked
  }

  function remember(key: string, repo: RepoGit): void {
    repos.set(key, Promise.resolve(repo))
    if (repos.size > MAX_REPOS) repos.delete(repos.keys().next().value!)
  }

  function forgetRepo(sessionId: string): void {
    for (const k of repos.keys()) if (k.startsWith(`${sessionId}\0`)) repos.delete(k)
  }

  /**
   * `.git/modules` 下的子模块 git 目录(有 config 的目录;名字可带 `/`,如 vendor/lib),
   * 以及它们与 modules 之间的各级目录(re-review C1、R2)。每条命令现走一遍,不跟随符号链接;
   * 已认出的 git 目录里的内部子目录(GIT_INTERNAL_DIRS)不走,其余子目录都走。
   * 只数候选目录(走到的目录);超过 MAX_MODULE_DIRS 个 → 抛错(命令失败,不在保护不全时跑)
   */
  function moduleGitDirs(g: string): { dirs: string[]; between: string[] } {
    const dirs: string[] = []
    const between = new Set<string>()
    let visited = 0
    const isDir = (p: string) => {
      try {
        return lstatSync(p).isDirectory()
      } catch {
        return false
      }
    }
    const has = (p: string) => {
      try {
        lstatSync(p)
        return true
      } catch {
        return false
      }
    }
    const children = (d: string) => {
      try {
        return readdirSync(d, { withFileTypes: true }).filter(c => c.isDirectory()).map(c => join(d, c.name))
      } catch {
        return []
      }
    }
    const visit = (d: string, chain: string[]): void => {
      if (++visited > MAX_MODULE_DIRS) throw new Error(`sandbox: more than ${MAX_MODULE_DIRS} directories under ${JSON.stringify(join(g, 'modules'))}`)
      // 只认 config(re-review R2):modules 下新建 config 被 b 步拒绝,沙箱里伪造不出来,也删不掉;
      // HEAD / objects 都能伪造,不能用来认
      const recognised = has(join(d, 'config'))
      if (recognised) {
        dirs.push(d)
        for (const c of chain) between.add(c)
      }
      // 认出来也接着往下走(modules / 其他目录):伪造的"git 目录"不能把真的子模块藏起来。
      // 只跳过已认出的 git 目录里直接的内部子目录;没认出的目录(如 modules/vendor)的每个子目录都走
      for (const c of children(d)) if (!(recognised && GIT_INTERNAL_DIRS.has(posix.basename(c)))) visit(c, [...chain, d])
    }
    const root = join(g, 'modules')
    if (isDir(root)) for (const c of children(root)) visit(c, [root])
    return { dirs, between: [...between] }
  }

  /** Linux:worktrees/*\/{config.worktree,commondir,gitdir} 与 cwd 的 .git 文件(bwrapArgs 只挂存在的) */
  function gitProtected(repo: RepoGit): string[] {
    const out: string[] = []
    for (const g of repo.gitDirs) {
      let names: string[] = []
      try {
        names = readdirSync(join(g, 'worktrees'))
      } catch {
        // 没有 worktree
      }
      for (const n of names) for (const f of ['config.worktree', 'commondir', 'gitdir']) out.push(join(g, 'worktrees', n, f))
      for (const m of moduleGitDirs(g).dirs) out.push(join(m, 'hooks'), join(m, 'config'))
    }
    if (repo.cwdGitFile) out.push(repo.cwdGitFile)
    return out
  }

  // ---- 代理 ----

  function entryFor(sessionId: string): SessionProxy {
    let e = proxies.get(sessionId)
    if (!e) proxies.set(sessionId, (e = { holds: 0, failed: false, denied: { keys: new Set() } }))
    return e
  }

  function onDeny(sessionId: string, e: SessionProxy, d: DenyEvent): void {
    const turn = o.currentTurn?.(sessionId)
    if (turn !== e.denied.turn) {
      e.denied.turn = turn
      e.denied.keys.clear()
    }
    const key = `${d.host}:${d.port}`
    if (e.denied.keys.has(key)) return
    e.denied.keys.add(key)
    try {
      // host 来自沙箱里的命令,可能把读到的密钥编进域名标签:与工具输出一样打码(review M3)
      o.append({ type: 'sandbox.netDenied', sessionId, payload: { host: redact(d.host), port: d.port, reason: d.reason } })
    } catch (err) {
      log.warn('sandbox.netDenied append failed', { error: String(err) })
    }
  }

  /** 不在任何可写根里(两种拼写)的 socket 父目录;都不行 → 抛错(review M2) */
  function socketParent(writable: string[]): string {
    const roots = [...new Set(writable.flatMap(w => [w, realSpelling(w)]))]
    for (const c of new Set([o.proxyParent ?? tmpdir(), '/tmp'])) {
      const spells = [c, realSpelling(c)]
      if (!spells.some(x => roots.some(r => within(x, r)))) return c
    }
    throw new Error('sandbox: no proxy socket directory outside the writable roots')
  }

  /** 代理已关、没有命令在跑:整条记录连同 git 缓存丢掉(review M5);失败标记要留着给 status */
  function prune(sessionId: string, e: SessionProxy): void {
    if (e.holds === 0 && !e.handle && !e.starting && !e.failed && proxies.get(sessionId) === e) {
      proxies.delete(sessionId)
      forgetRepo(sessionId)
    }
  }

  async function proxyFor(sessionId: string, e: SessionProxy, writable: string[]): Promise<ProxyHandle | undefined> {
    if (e.handle && !e.handle.closing) {
      e.handle.touch()
      return e.handle
    }
    if (e.starting) return e.starting
    const starting = start({
      allow: () => o.permissions().network.allow,
      upstream: o.upstream,
      lookup: o.lookup,
      onDeny: d => onDeny(sessionId, e, d),
      idleMs,
      ...(platform === 'linux' && { unixSocket: { parent: socketParent(writable) } }),
    }).then(
      h => {
        e.failed = false
        if (closed) {
          void h.close()
          return undefined
        }
        e.handle = h
        void h.closed.then(() => {
          if (e.handle === h) e.handle = undefined
          prune(sessionId, e)
        })
        return h
      },
      err => {
        e.failed = true
        log.warn('sandbox proxy failed to start', { error: String(err) })
        return undefined
      },
    )
    e.starting = starting
    try {
      return await starting
    } finally {
      if (e.starting === starting) e.starting = undefined
    }
  }

  /** 命令在跑:定期 touch,空闲计时从命令结束才开始 */
  function hold(sessionId: string, e: SessionProxy): () => void {
    e.holds++
    if (e.holds === 1) {
      e.keepalive = setInterval(() => e.handle?.touch(), Math.max(5, Math.floor(idleMs / 2)))
      e.keepalive.unref()
    }
    let released = false
    return () => {
      if (released) return
      released = true
      e.holds--
      if (e.holds === 0) {
        clearInterval(e.keepalive)
        e.keepalive = undefined
        e.handle?.touch()
        prune(sessionId, e)
      }
    }
  }

  // ---- 计划 ----

  function ensureTmp(tmp: string): void {
    mkdirSync(tmp, { recursive: true, mode: 0o700 })
    const st = lstatSync(tmp)
    if (!st.isDirectory()) throw new Error('sandbox: session tmp is not a directory')
    if ((st.mode & 0o777) !== 0o700) chmodSync(tmp, 0o700)
  }

  async function plan(command: string, s: { sessionId: string; cwd: string; spillDir: string }, env: NodeJS.ProcessEnv): Promise<ShellPlan> {
    if (closed) throw new Error('sandbox closed')
    // 配置只取一次:之后的 await 里 permissions.set 改了也不影响这条命令(review M4)
    const cfg = o.permissions()
    const base = levelOf(cfg, false).level
    if (base === 'none') return { file: command, args: [], env, sandboxed: false, level: 'none', release: () => {} }

    const tmp = sessionTmpDir(o.dataDir, s.sessionId)
    ensureTmp(tmp)
    const repo = await repoFor(s.sessionId, s.cwd)
    const writable = [s.cwd, ...repo.gitDirs, tmp]
    const e = usesProxy() ? entryFor(s.sessionId) : undefined
    const release = e ? hold(s.sessionId, e) : () => {}
    try {
      const proxy = e ? await proxyFor(s.sessionId, e, writable) : undefined
      if (closed) throw new Error('sandbox closed')
      // 本会话的代理没起来 → 网络全断,级别如实报 partial
      const level: 'full' | 'partial' = e?.failed ? 'partial' : base
      const creds = credentialList()
      const persistence = persistenceList()

      if (platform === 'darwin') {
        const allowLoopback = cfg.sandbox.allowLoopback
        const modules = repo.gitDirs.map(moduleGitDirs)
        const moduleDirs = modules.flatMap(m => m.dirs)
        const moduleGuard = moduleDirs.flatMap(m => [join(m, 'hooks'), join(m, 'config')])
        const profile = seatbeltProfile({
          writable,
          gitDirs: repo.gitDirs,
          cwdGitFile: repo.cwdGitFile,
          denyRead: [...creds, o.dataDir],
          reAllowRead: [s.spillDir, tmp],
          denyWrite: [...creds, o.dataDir, ...persistence, ...moduleGuard],
          reAllowWrite: [tmp],
          moveBlock: withAncestors([...creds, o.dataDir, ...persistence, ...repo.gitDirs.flatMap(g => [g, `${g}/hooks`, `${g}/config`, `${g}/modules`, `${g}/worktrees`]), ...moduleDirs, ...moduleGuard, ...modules.flatMap(m => m.between), ...(repo.cwdGitFile ? [repo.cwdGitFile] : [])], writable),
          proxyPort: proxy?.port,
          allowLoopback,
        })
        const { file, args } = sandboxExecArgs(profile, command)
        return { file, args, env: sandboxEnv(env, { tmp, proxyPort: proxy?.port, level, allowLoopback }), sandboxed: true, level, release }
      }

      // linux(bwrap)
      for (const g of repo.gitDirs) ensureGitHooksDir(g)
      const hideDirs: string[] = []
      const hideFiles: string[] = []
      for (const c of creds) {
        let dir = false
        try {
          dir = statSync(c).isDirectory()
        } catch {
          // 不存在:bwrapArgs 不挂
        }
        ;(dir ? hideDirs : hideFiles).push(c)
      }
      const bwLevel = o.detected.level as 'full' | 'partial'
      const unixSock = proxy?.unixPath
      const args = bwrapArgs({
        level: bwLevel,
        cwd: s.cwd,
        tmp,
        spill: s.spillDir,
        gitDirs: repo.gitDirs,
        gitProtected: gitProtected(repo),
        hideDirs,
        hideFiles,
        dataDir: o.dataDir,
        persistence,
        unixSock,
        execPath,
        execRoot: execRootFor(execPath),
        command,
        env: o.env,
        uid: o.uid ?? process.getuid?.(),
      })
      // 只有中转真的跑起来时才给代理变量(Task 8);与 bwrapArgs 同一判断
      const relay = bwLevel === 'full' && unixSock !== undefined && existsSync(unixSock)
      return {
        file: o.detected.bwrap ?? '/usr/bin/bwrap',
        args,
        env: sandboxEnv(env, { tmp, proxyPort: relay ? RELAY_PORT : undefined, level, allowLoopback: false }),
        sandboxed: true,
        level,
        release,
      }
    } catch (err) {
      release()
      throw err
    }
  }

  async function close(): Promise<void> {
    closed = true
    const pending: Promise<unknown>[] = []
    for (const e of proxies.values()) {
      clearInterval(e.keepalive)
      e.keepalive = undefined
      if (e.starting) pending.push(e.starting.then(h => h?.close()))
      if (e.handle) pending.push(e.handle.close())
    }
    await Promise.allSettled(pending)
    proxies.clear()
  }

  return { status, plan, close }
}

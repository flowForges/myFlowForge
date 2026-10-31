// 内核 `sandbox` 服务(05 spec §10、§11):级别、每会话临时目录与代理、每条 shell 命令的执行计划。
// - 级别 = 启动时探测的结果 + 现读的配置(enabled、allowLoopback)+ 最近一次代理启动是否失败;
// - 黑名单 / 持久化清单都从内核启动时的环境快照算(与权限门同一份),不读 process.env;
//   含 `..` 等坏值的条目丢掉(其解析后的形态已在清单里):一个坏环境变量不能让所有命令都跑不了;
// - cwd / 临时目录等自身路径坏了照样抛错:plan reject,调用方让命令失败,绝不退回无沙箱执行;
// - 代理每会话一个,按需启动;命令在跑(plan 之后、release 之前)时保持不关,之后按空闲关闭。
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, chmodSync, type Dirent } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import type { KernelEvent, PermissionsConfig, SandboxStatus } from '../protocol/index'
import { canonicalRoots, credentialRoots, persistenceRoots, type EnvSnapshot } from '../lib/fs/paths'
import { createGit, type Git } from '../lib/git/snapshot'
import { bwrapArgs, ensureGitHooksDir, execRootFor } from '../lib/sandbox/bwrap'
import type { DetectResult } from '../lib/sandbox/detect'
import { startProxy as realStartProxy, type DenyEvent, type LookupFn, type ProxyHandle, type ProxyOptions, type Upstream } from '../lib/sandbox/net/proxy'
import { cleanPath, realSpelling, within } from '../lib/sandbox/paths'
import { RELAY_PORT } from '../lib/sandbox/relay'
import { sandboxExecArgs, seatbeltProfile } from '../lib/sandbox/seatbelt'
import { sandboxEnv } from '../lib/tools/shellEnv'
import type { SandboxService, ShellPlan } from '../lib/tools/types'
import { nullLogger, type Logger } from './log'

const SAFE_ID = /^[A-Za-z0-9_-]+$/
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
  let proxyFailed = false
  let closed = false

  /** 这个级别下命令是否经会话代理上网:macOS 总是;Linux 只有 full(网络命名空间 + 中转) */
  const usesProxy = () => platform === 'darwin' || (platform === 'linux' && o.detected.level === 'full')

  function status(): SandboxStatus {
    const c = o.permissions()
    const autoDegraded = (level: SandboxStatus['level']) => level === 'none' && !c.allowUnsandboxedAuto
    if (!c.sandbox.enabled) return { level: 'none', missing: ['disabled'], autoDegraded: autoDegraded('none') }
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
    return { level, missing, autoDegraded: autoDegraded(level) }
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

  async function lookupGit(cwd: string): Promise<RepoGit> {
    try {
      const r = await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd })
      const dir = r.code === 0 ? r.stdout.toString().split('\n')[0] : ''
      if (!dir || !dir.startsWith('/')) return { gitDirs: [] }
      const gitDir = realpathSync.native(dir)
      let cwdGitFile: string | undefined
      const t = await git(['rev-parse', '--path-format=absolute', '--show-toplevel'], { cwd })
      const top = t.code === 0 ? t.stdout.toString().split('\n')[0] : ''
      if (top.startsWith('/')) {
        const f = join(realpathSync.native(top), '.git')
        try {
          if (!lstatSync(f).isDirectory()) cwdGitFile = f
        } catch {
          // 没有 .git(GIT_DIR 之类):不保护
        }
      }
      return { gitDirs: [gitDir], cwdGitFile }
    } catch (err) {
      log.warn('sandbox git lookup failed', { error: String(err) })
      return { gitDirs: [] }
    }
  }

  function repoFor(sessionId: string, cwd: string): Promise<RepoGit> {
    const key = `${sessionId}\0${cwd}`
    let p = repos.get(key)
    if (!p) repos.set(key, (p = lookupGit(cwd)))
    return p
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
    }
    if (repo.cwdGitFile) out.push(repo.cwdGitFile)
    return out
  }

  // ---- 代理 ----

  function entryFor(sessionId: string): SessionProxy {
    let e = proxies.get(sessionId)
    if (!e) proxies.set(sessionId, (e = { holds: 0, denied: { keys: new Set() } }))
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
      o.append({ type: 'sandbox.netDenied', sessionId, payload: { host: d.host, port: d.port, reason: d.reason } })
    } catch (err) {
      log.warn('sandbox.netDenied append failed', { error: String(err) })
    }
  }

  async function proxyFor(sessionId: string, e: SessionProxy): Promise<ProxyHandle | undefined> {
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
      ...(platform === 'linux' && { unixSocket: { parent: o.proxyParent ?? tmpdir() } }),
    }).then(
      h => {
        proxyFailed = false
        if (closed) {
          void h.close()
          return undefined
        }
        e.handle = h
        void h.closed.then(() => {
          if (e.handle === h) e.handle = undefined
        })
        return h
      },
      err => {
        proxyFailed = true
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
  function hold(e: SessionProxy): () => void {
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
    const st = status()
    if (st.level === 'none') return { file: command, args: [], env, sandboxed: false, level: 'none', release: () => {} }

    const tmp = sessionTmpDir(o.dataDir, s.sessionId)
    ensureTmp(tmp)
    const repo = await repoFor(s.sessionId, s.cwd)
    const e = usesProxy() ? entryFor(s.sessionId) : undefined
    const release = e ? hold(e) : () => {}
    try {
      const proxy = e ? await proxyFor(s.sessionId, e) : undefined
      if (closed) throw new Error('sandbox closed')
      const level = status().level as 'full' | 'partial' // 代理结果可能改了级别
      const cfg = o.permissions()
      const creds = credentialList()
      const persistence = persistenceList()
      const writable = [s.cwd, ...repo.gitDirs, tmp]

      if (platform === 'darwin') {
        const allowLoopback = cfg.sandbox.allowLoopback
        const profile = seatbeltProfile({
          writable,
          gitDirs: repo.gitDirs,
          cwdGitFile: repo.cwdGitFile,
          denyRead: [...creds, o.dataDir],
          reAllowRead: [s.spillDir, tmp],
          denyWrite: [...creds, o.dataDir, ...persistence],
          reAllowWrite: [tmp],
          moveBlock: withAncestors([...creds, o.dataDir, ...persistence, ...repo.gitDirs.flatMap(g => [g, `${g}/hooks`, `${g}/config`]), ...(repo.cwdGitFile ? [repo.cwdGitFile] : [])], writable),
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

// 内核 `sandbox` 服务(05 spec §10、§11):级别、每会话临时目录与代理、每条 shell 命令的执行计划。
// - 级别 = 启动时探测的结果 + 现读的配置(enabled、allowLoopback)+ 最近一次代理启动是否失败;
// - 黑名单 / 持久化清单都从内核启动时的环境快照算(与权限门同一份),不读 process.env;
//   含 `..` 等坏值的条目丢掉(其解析后的形态已在清单里):一个坏环境变量不能让所有命令都跑不了;
// - cwd / 临时目录等自身路径坏了照样抛错:plan reject,调用方让命令失败,绝不退回无沙箱执行;
// - 代理每会话一个,按需启动;命令在跑(plan 之后、release 之前)时保持不关,之后按空闲关闭。
//   04:委派的运行各有一个(键 `sessionId\0scope`),多出它自己的主机,release 时立刻关。
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, type Dirent } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import type { KernelEvent, PermissionsConfig, SandboxStatus, SessionOrigin } from '../protocol/index'
import { canonicalRoots, credentialRoots, persistenceRoots, pluginStoreRootOf, PROJECT_CONFIG_DIRS, type EnvSnapshot } from '../lib/fs/paths'
import type { RepoPin } from '../lib/git/snapshot'
import { imHiddenTops } from '../lib/git/imWorktree'
import { userGitState, worktreeRootOf } from '../lib/git/worktree'
import { literalRoots, matches, type MatchCtx, type Rule } from '../lib/permissions/rules'
import { bwrapArgs, ensureGitHooksDir, execRootFor } from '../lib/sandbox/bwrap'
import type { DetectResult } from '../lib/sandbox/detect'
import { startProxy as realStartProxy, type DenyEvent, type LookupFn, type ProxyHandle, type ProxyOptions, type Upstream } from '../lib/sandbox/net/proxy'
import { cleanPath, realSpelling, within } from '../lib/sandbox/paths'
import { RELAY_PORT } from '../lib/sandbox/relay'
import { sandboxExecArgs, seatbeltProfile } from '../lib/sandbox/seatbelt'
import { redact } from '../lib/tools/redact'
import { shellQuote } from '../lib/tools/shellQuote'
import { sandboxEnv } from '../lib/tools/shellEnv'
import type { ExecPlanOpts, ExecPolicy, SandboxService, ShellPlan } from '../lib/tools/types'
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

function ensureDir(p: string): void {
  try {
    mkdirSync(p)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
  }
}
/** shell 工具:什么都不豁免 */
const SHELL_PLAN: Omit<ExecPlanOpts, 'proxyScope'> & { proxyScope?: string } = { allowRead: [], allowWrite: [], allowHosts: [], readOnly: false, denyRead: [], denyWrite: [] }

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
      rmSync(join(dir, d.name, 'mcp'), { recursive: true, force: true }) // MCP 服务各自的临时目录(09 M5)
    } catch (err) {
      log.warn('wipe session tmp failed', { sessionId: d.name, error: String(err) })
    }
  }
}

/** 代理 Unix socket 的候选父目录(按顺序);工作进程启动时也在这些目录里清残留(final review M4) */
export function proxySocketParents(proxyParent?: string): string[] {
  return [...new Set([proxyParent ?? tmpdir(), '/tmp'])]
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
  /** 现读的用户规则(execPolicy 翻译用);必填:漏接等于用户规则悄悄失效 */
  rules: () => Rule[]
  append: (e: Omit<KernelEvent, 'seq' | 'ts'>) => void
  /** 会话当前的 turn(拦截事件按 turn 去重) */
  currentTurn?: (sessionId: string) => string | undefined
  /** Linux 中转用的可执行文件;默认 process.execPath */
  execPath?: string
  upstream?: Upstream
  lookup?: LookupFn
  /** 代理空闲多久关闭;默认 10 分钟 */
  idleMs?: number
  /** 会话建立时定下的仓库;没有 = 没有仓库。这里不跑 git,也不从 cwd 往上找:cwd 是模型写得到的 */
  repoPin?: (sessionId: string) => RepoPin | undefined
  /**
   * 会话的来源,每次计划现问。不是 app、acp 的会话,用户的 git 状态只读(07 spec §8.2):否则链接 worktree 里的 shell 能 `git branch -f main`。
   * 没给 = 不加;给了而答不上来 = 加,失败方向是关
   */
  originOf?: (sessionId: string) => SessionOrigin | undefined
  /** IM 会话的 worktree 从哪个检出建的(07 spec §8.1) */
  projectTopOf?: (sessionId: string) => string | undefined
  /** 代理 Unix socket 的父目录(不能在沙箱可写范围内);默认 os.tmpdir() */
  proxyParent?: string
  uid?: number
  log?: Logger
  /** 测试注入 */
  startProxy?: (o: ProxyOptions) => Promise<ProxyHandle>
}

interface SessionProxy {
  /** 有 = 一次运行的代理:只给这次运行的主机,release 时立刻关 */
  scoped?: { allowHosts: string[]; exact?: boolean }
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
  const start = o.startProxy ?? realStartProxy
  const idleMs = o.idleMs ?? DEFAULT_IDLE_MS
  const execPath = o.execPath ?? process.execPath
  const proxies = new Map<string, SessionProxy>()
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
  // 插件存储根和门同一份(09 M13)
  const persistenceList = () => usable(canonicalRoots([...persistenceRoots(o.home, platform, o.env), pluginStoreRootOf(o.dataDir)], { platform }))

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

  /** root 到 inner 之间的目录,含 root、不含 inner;两种拼写都算过 */
  function between(inner: string, root: string): string[] {
    const r = realSpelling(root)
    const out: string[] = []
    for (let a = posix.dirname(realSpelling(inner)); within(a, r); a = posix.dirname(a)) {
      out.push(a)
      if (a === r) break
    }
    return out
  }

  // ---- git ----

  /**
   * 会话钉住的仓库。<worktree 根>/<会话>/<运行> 下的 cwd 是这个会话委派运行的 worktree,它自己的 `.git` 文件也要保护。
   * 现算 `.git` 是不是文件,不跑 git
   */
  function repoFor(sessionId: string, cwd: string): RepoGit {
    const pin = o.repoPin?.(sessionId)
    if (pin?.kind !== 'repo') return { gitDirs: [] }
    const runs = join(realSpelling(worktreeRootOf(o.dataDir)), sessionId)
    const real = realSpelling(cwd)
    const top = within(real, runs) && real !== runs ? join(runs, posix.relative(runs, real).split('/')[0]) : pin.top
    const f = join(top, '.git')
    let cwdGitFile: string | undefined
    try {
      if (!lstatSync(f).isDirectory()) cwdGitFile = f
    } catch {
      // 没有 .git:没什么要保护的
    }
    return { gitDirs: [pin.commonDir], cwdGitFile }
  }

  /**
   * IM 会话读不到用户的检出(07 spec §8.1):tops 整个拒读,只留 worktree 要用的 git 目录(keep),凭据和数据目录里的不算。
   * cwd 就在里面的不算:那不是从它建的 worktree
   */
  function imHidden(sessionId: string, cwd: string): { tops: string[]; keep: string[] } {
    if (o.originOf?.(sessionId) !== 'im') return { tops: [], keep: [] }
    const pin = o.repoPin?.(sessionId)
    if (pin?.kind !== 'repo') return { tops: [], keep: [] }
    const real = realSpelling(cwd)
    const tops = imHiddenTops(pin, o.projectTopOf?.(sessionId)).filter(t => !within(real, realSpelling(t)))
    const closed = [...credentialList(), o.dataDir]
    const keep = [pin.commonDir, pin.gitDir].filter(k => tops.some(t => within(realSpelling(k), realSpelling(t))) && !closed.some(c => within(k, c) || within(realSpelling(k), realSpelling(c))))
    return { tops, keep: [...new Set(keep)] }
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

  /** 主机名单在建条目时定下,一个条目一份 */
  function entryFor(key: string, scoped: SessionProxy['scoped']): SessionProxy {
    let e = proxies.get(key)
    if (!e) proxies.set(key, (e = { scoped, holds: 0, failed: false, denied: { keys: new Set() } }))
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
    for (const c of proxySocketParents(o.proxyParent)) {
      const spells = [c, realSpelling(c)]
      if (!spells.some(x => roots.some(r => within(x, r)))) return c
    }
    throw new Error('sandbox: no proxy socket directory outside the writable roots')
  }

  /**
   * 代理已关、没有命令在跑:整条记录丢掉(review M5);失败标记要留着给 status。
   * 运行的条目没人再问 status,失败了也删
   */
  function prune(key: string, e: SessionProxy): void {
    if (e.holds === 0 && !e.handle && !e.starting && (!e.failed || e.scoped) && proxies.get(key) === e) {
      proxies.delete(key)
    }
  }

  async function proxyFor(key: string, sessionId: string, e: SessionProxy, writable: string[]): Promise<ProxyHandle | undefined> {
    if (e.handle && !e.handle.closing) {
      e.handle.touch()
      return e.handle
    }
    if (e.starting) return e.starting
    const starting = start({
      allow: () => (e.scoped?.exact ? e.scoped.allowHosts : e.scoped ? [...o.permissions().network.allow, ...e.scoped.allowHosts] : o.permissions().network.allow),
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
          prune(key, e)
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
  function hold(key: string, sessionId: string, e: SessionProxy): () => void {
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
        if (e.scoped) {
          const closing = (h?: ProxyHandle) => h?.close().catch(err => log.warn('sandbox run proxy close failed', { error: String(err) }))
          void closing(e.handle)
          void e.starting?.then(closing)
        } else e.handle?.touch()
        prune(key, e)
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
    return buildPlan(command, s, env, SHELL_PLAN, cfg, base)
  }

  async function planExec(file: string, args: string[], s: { sessionId: string; cwd: string; spillDir: string }, env: NodeJS.ProcessEnv, x: ExecPlanOpts): Promise<ShellPlan> {
    if (closed) throw new Error('sandbox closed')
    const cfg = o.permissions()
    const base = levelOf(cfg, false).level
    if (base === 'none') return { file, args, env, sandboxed: false, level: 'none', release: () => {} }
    if (!file.startsWith('/')) throw new Error('sandbox: the program path must be absolute')
    if (!SAFE_ID.test(x.proxyScope)) throw new Error('sandbox: invalid proxy scope')
    return buildPlan(shellQuote([file, ...args]), s, env, x, cfg, base)
  }

  /**
   * 从黑名单拿掉 allowRead 的两种拼写。豁免本身是链接且落在别的凭据根里 → 抛错:`~/.qoder/.auth → ~/.ssh` 时
   * ~/.ssh 正是 .auth 的 realpath 拼写,不拦就被一起放出来了。比较用没展开过的根,展开后的清单里已经分不清谁是谁
   */
  function exemptFrom(creds: string[], allowRead: string[]): string[] {
    const named = new Set(allowRead)
    const others = [...usable(credentialRoots(o.home, platform, o.env)).filter(c => !named.has(c)), o.dataDir]
    for (const a of allowRead) {
      const real = realSpelling(a)
      if (real === posix.join(realSpelling(posix.dirname(a)), posix.basename(a))) continue // 不是链接
      if (others.some(c => within(real, c) || within(real, realSpelling(c)))) throw new Error(`sandbox: ${JSON.stringify(a)} leads into a credential root`)
    }
    const exempt = new Set(allowRead.flatMap(a => [a, realSpelling(a)]))
    return creds.filter(c => !exempt.has(c))
  }

  /**
   * cwd 里 CLI 会自己加载的配置目录(final review I-2):写了就是下次委派时在沙箱外跑命令。
   * cwd = 家目录时它们是 CLI 自己的状态目录,由凭据和持久化清单管,运行要写的子目录在 allowWrite 里,不在这里盖
   */
  function projectConfigDirs(cwd: string, allowWrite: string[]): string[] {
    return PROJECT_CONFIG_DIRS.map(d => join(cwd, d)).filter(d => !allowWrite.some(a => within(a, d) || within(realSpelling(a), realSpelling(d))))
  }

  /** 是链接的可写项丢掉:cwd = ~/.qoder 的会话能把 logs 换成指向别处的链接,下次运行就写到那里去了 */
  function plainDirs(paths: string[]): string[] {
    return paths.filter(p => {
      try {
        if (!lstatSync(p).isSymbolicLink()) return true
      } catch {
        return true // 不存在:Seatbelt 按路径生效,bwrap 不挂
      }
      log.warn('sandbox dropped a symlinked writable path', { path: p })
      return false
    })
  }

  async function buildPlan(
    command: string,
    s: { sessionId: string; cwd: string; spillDir: string },
    env: NodeJS.ProcessEnv,
    raw: Omit<ExecPlanOpts, 'proxyScope'> & { proxyScope?: string },
    cfg: PermissionsConfig,
    base: 'full' | 'partial',
  ): Promise<ShellPlan> {
    // 都先校验并规范化:坏路径在起代理之前就抛错
    const cleaned = (list: string[]) => list.map(q => cleanPath(q, 'sandbox'))
    const x = {
      ...raw,
      allowRead: cleaned(raw.allowRead),
      allowWrite: cleaned(raw.allowWrite),
      denyRead: cleaned(raw.denyRead),
      denyWrite: cleaned(raw.denyWrite),
      hide: raw.hide && { tops: cleaned(raw.hide.tops), keep: cleaned(raw.hide.keep) },
      tmpDir: raw.tmpDir === undefined ? undefined : cleanPath(raw.tmpDir, 'sandbox'),
    }
    // 放回排在拒读之后:keep 含着一个根,这个根就白隐藏了(存储根在 cwd 里、cwd:'none' 的 cwd 在运行时根里)。不跑,调用方报 sandbox_unavailable
    if (x.hide) {
      const hiddenRoots = [...x.hide.tops, ...imHidden(s.sessionId, s.cwd).tops]
      for (const k of x.hide.keep) {
        const top = hiddenRoots.find(t => within(t, k) || within(realSpelling(t), realSpelling(k)))
        if (top !== undefined) throw new Error(`sandbox: kept path ${JSON.stringify(k)} holds a hidden root ${JSON.stringify(top)}`)
      }
    }
    const tmp = x.tmpDir ?? sessionTmpDir(o.dataDir, s.sessionId)
    ensureTmp(tmp)
    const repo = repoFor(s.sessionId, s.cwd)
    const pin = o.repoPin?.(s.sessionId)
    const origin = o.originOf?.(s.sessionId)
    const gitReadOnly = o.originOf !== undefined && origin !== 'app' && origin !== 'acp' && pin?.kind === 'repo'
    if (gitReadOnly) x.denyWrite = [...x.denyWrite, ...cleaned(userGitState(pin))]
    // 只读运行:连同"cwd 就在它里面"的额外可写项一起去掉
    const grantWrite = () => plainDirs(x.allowWrite).filter(a => !x.readOnly || !(within(s.cwd, a) || within(realSpelling(s.cwd), realSpelling(a))))
    // 隐藏运行(09 §10.3):可写的 cwd 不带上它外面的 git 目录,第三方的服务碰不到用户的检出
    const writableWith = (extra: string[]) => [...(x.readOnly ? [] : [s.cwd, ...(gitReadOnly || x.hide ? [] : repo.gitDirs)]), tmp, ...extra]
    const key = x.proxyScope === undefined ? s.sessionId : `${s.sessionId}\0${x.proxyScope}`
    // 同一 tick 里查和占,并发的两个计划只有一个过:第二个的主机名单不会悄悄变成第一个的
    if (x.proxyScope !== undefined && proxies.get(key)?.holds) throw new Error('sandbox: proxy scope is in use')
    const e = usesProxy() ? entryFor(key, x.proxyScope === undefined ? undefined : { allowHosts: x.allowHosts, ...(x.exactHosts && { exact: true }) }) : undefined
    const release = e ? hold(key, s.sessionId, e) : () => {}
    try {
      const proxy = e ? await proxyFor(key, s.sessionId, e, writableWith(grantWrite())) : undefined
      if (closed) throw new Error('sandbox closed')
      // 等代理的时候 cwd = ~/.qoder 的会话可能已经把条目换成了链接,所以在生成配置之前才定;从这里到配置之间没有 await
      const allowWrite = grantWrite()
      const writable = writableWith(allowWrite)
      // 本会话的代理没起来 → 网络全断,级别如实报 partial
      const level: 'full' | 'partial' = e?.failed ? 'partial' : base
      const creds = credentialList()
      const persistence = persistenceList()
      const hidden = exemptFrom(creds, x.allowRead)
      // keep 只放普通路径:落在凭据或数据目录里的不算,不然 keep 就能点名放开它们(两种拼写都比,和 imHidden 一样)
      // hidden 两种拼写都有,数据目录也要:它在链接后面时,真身可能就在 keep 或 allowRead 里
      const closedRoots = [...new Set([...hidden, o.dataDir, realSpelling(o.dataDir)])]
      const hideKeep = (x.hide?.keep ?? []).filter(k => !closedRoots.some(c => within(k, c) || within(realSpelling(k), realSpelling(c))))
      // 豁免目录里嵌套的凭据不跟着放出来;keep 也是豁免(09 M4)
      const exempted = [...x.allowRead, ...hideKeep]
      const insideExemption = (c: string) => exempted.some(a => within(c, a) || within(c, realSpelling(a)))
      const nested = closedRoots.filter(insideExemption)
      const im = imHidden(s.sessionId, s.cwd)
      const tops = cleaned([...im.tops, ...(x.hide?.tops ?? [])])
      const keep = cleaned([...im.keep, ...hideKeep])

      if (platform === 'darwin') {
        const allowLoopback = cfg.sandbox.allowLoopback && !x.exactHosts
        const modules = repo.gitDirs.map(moduleGitDirs)
        const moduleDirs = modules.flatMap(m => m.dirs)
        const moduleGuard = moduleDirs.flatMap(m => [join(m, 'hooks'), join(m, 'config')])
        // 隐藏运行放回来的东西都在隐藏的根或数据目录下:祖先拿不到元数据,程序连 realpath 都走不通(09 M4)
        const opened = x.hide ? [...keep, ...x.allowRead, tmp, s.spillDir] : keep
        const closedAbove = x.hide ? [...tops, o.dataDir] : tops
        const profile = seatbeltProfile({
          projectConfig: projectConfigDirs(s.cwd, x.allowWrite),
          writable,
          gitDirs: repo.gitDirs,
          cwdGitFile: repo.cwdGitFile,
          denyRead: [...hidden, o.dataDir, ...tops],
          reAllowRead: [s.spillDir, tmp, ...x.allowRead, ...keep],
          traverse: opened.flatMap(k => closedAbove.flatMap(t => between(k, t))),
          denyWrite: [...creds, o.dataDir, ...persistence, ...moduleGuard],
          reAllowWrite: [tmp, ...x.allowRead.filter(a => allowWrite.some(w => within(a, w) || within(realSpelling(a), realSpelling(w))))],
          finalDenyRead: [...x.denyRead, ...nested],
          // 读规则也拒写:否则 `mv secret/a ./a`、`ln` 就把它带出来了(与 Codex 的 `none` 一致)
          finalDenyWrite: [...x.denyRead, ...x.denyWrite, ...nested, ...persistence.filter(insideExemption), ...tops.filter(t => !writable.some(w => within(realSpelling(w), realSpelling(t))))],
          // 可写根本身(及它在别的可写根里的父目录)也不能挪:Seatbelt 只按源、目标路径判,挪走之后里面的东西就换了路径,
          // 哪条规则都不再认得(`mv "$PWD" "$TMPDIR/r"` 再改 .git/hooks)。x.allowWrite 是要求的全部:缺的、丢掉的也不能在沙箱里建出来或换掉
          moveBlock: withAncestors([...writable, ...x.allowWrite, ...creds, o.dataDir, ...persistence, ...x.denyRead, ...x.denyWrite, ...repo.gitDirs.flatMap(g => [g, `${g}/hooks`, `${g}/config`, `${g}/modules`, `${g}/worktrees`]), ...moduleDirs, ...moduleGuard, ...modules.flatMap(m => m.between), ...(repo.cwdGitFile ? [repo.cwdGitFile] : [])], writable),
          proxyPort: proxy?.port,
          allowLoopback,
          ...(x.hide && { noNamedIpc: true }),
        })
        const { file, args } = sandboxExecArgs(profile, command)
        return { file, args, env: sandboxEnv(env, { tmp, proxyPort: proxy?.port, level, allowLoopback }), sandboxed: true, level, release, ...(e?.failed && { networkLost: true as const }) }
      }

      // linux(bwrap)
      for (const g of repo.gitDirs) ensureGitHooksDir(g)
      // bwrap 只挂存在的路径:和 hooks 一样先建空目录,才能只读挂上
      const projectConfig = projectConfigDirs(s.cwd, x.allowWrite)
      for (const d of projectConfig) ensureDir(d)
      const hideDirs: string[] = []
      const hideFiles: string[] = []
      for (const c of hidden) {
        let dir = false
        try {
          dir = statSync(c).isDirectory()
        } catch {
          // 不存在:bwrapArgs 不挂
        }
        ;(dir ? hideDirs : hideFiles).push(c)
      }
      const bwLevel = o.detected.level as 'full' | 'partial'
      // bwrap 从宿主挂,会盖掉隐藏。隐藏运行只留 keep 里的:cwd 外的 git 目录、被隐藏的 cwd 都不挂回来
      const inKeep = (p: string) => hideKeep.some(k => within(realSpelling(p), realSpelling(k)))
      const visibleGit = (p: string) => !x.hide || inKeep(p)
      const unixSock = proxy?.unixPath
      const args = bwrapArgs({
        level: bwLevel,
        cwd: s.cwd,
        tmp,
        spill: s.spillDir,
        gitDirs: repo.gitDirs.filter(visibleGit),
        gitProtected: gitProtected(repo).filter(visibleGit),
        hideDirs,
        hideFiles,
        dataDir: o.dataDir,
        persistence,
        unixSock,
        execPath,
        execRoot: execRootFor(execPath),
        readOnly: x.readOnly,
        // 与 Seatbelt 一致:在隐藏的根里的,只有豁免项放出来(bind 的源是宿主,不筛就绕过了隐藏)
        // 隐藏运行的 allowWrite 是调用方点名放回来的,在根里也挂;IM 的根里的不挂
        extraWritable: allowWrite.filter(a => (x.allowRead.some(r => within(a, r)) || !closedRoots.some(c => within(a, c) || within(realSpelling(a), realSpelling(c)))) && (x.hide !== undefined || !tops.some(t => within(realSpelling(a), realSpelling(t))))),
        hiddenTops: tops,
        // IM 的 keep 是 git 目录,上面已经单独挂了
        hiddenKeep: hideKeep,
        hideCwd: x.hide !== undefined && !inKeep(s.cwd),
        ruleDenyRead: x.denyRead,
        ruleDenyWrite: [...x.denyWrite, ...projectConfig],
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
        // 没有命名空间(bwLevel partial)时网络本来就是开的,代理怎样都不算断网
        ...(bwLevel === 'full' && !relay && { networkLost: true as const }),
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

  /**
   * 给执行器翻译隔离用的策略(04 spec §8.4)。literalRoots 的根都翻译过;
   * bwrap 只能挂存在的路径,所以 Linux 上根还不存在的规则另算"翻译不了",根照样列着(Codex 的权限档按路径生效)
   */
  function execPolicy(sessionId: string, cwd: string, resource?: string): ExecPolicy {
    const rules = o.rules()
    const ctx: MatchCtx = { cwd, home: o.home, platform, realpath: realpathSync.native }
    const translated = (subject: 'read' | 'write') => {
      const r = literalRoots(rules, subject, ctx)
      if (platform !== 'linux') return r
      const unmountable = rules.filter(rule => {
        const { roots } = literalRoots([rule], subject, ctx)
        return roots.length > 0 && !roots.some(existsSync)
      })
      return { roots: r.roots, untranslated: r.untranslated + unmountable.length }
    }
    const read = translated('read')
    const write = translated('write')
    const restrictive = rules.filter(r => r.effect !== 'allow')
    // 本身就命中这个执行器的 shell 规则,权限门已经判过了
    const shell = restrictive.filter(r => r.subject === 'shell' && !(resource !== undefined && matches(r, resource, ctx)))
    const im = imHidden(sessionId, cwd)
    return {
      denyRead: [...credentialList(), o.dataDir, ...im.tops],
      ...(im.keep.length > 0 && { keepRead: im.keep }),
      persistence: persistenceList(),
      dataDir: o.dataDir,
      level: status(sessionId).level,
      ruleDenyRead: read.roots,
      ruleDenyWrite: write.roots,
      untranslatedRules: read.untranslated + write.untranslated + shell.length,
      untranslatedPaths: read.untranslated + write.untranslated,
      totalRules: restrictive.length,
    }
  }

  return { status, plan, execPolicy, planExec, close }
}

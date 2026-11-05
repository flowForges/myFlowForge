import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { imHiddenTops } from '../lib/git/imWorktree'
import { canonicalRoots, credentialRoots, hasGitSegment, isComparablePath, isCredentialPath, isInside, isRootLike, OUTSIDE, persistenceRoots, pluginStoreRootOf, PROJECT_CONFIG_DIRS, resolveToolPath, type EnvSnapshot } from '../lib/fs/paths'
import { evaluate, type MatchCtx, type Rule } from '../lib/permissions/rules'
import type { PermissionRequest } from '../lib/tools/types'
import type { ApprovalMode, SandboxStatus } from '../protocol/index'
import type { SessionInfo } from './sessions'

export type { PermissionRequest }

export type Decision = 'allow' | 'deny' | 'ask'

export interface DecideEnv {
  /** 凭据黑名单(已规范化) */
  roots: string[]
  /** 持久化文件(登录脚本、自启动、git 全局配置;已规范化):只拒写 */
  persistence: string[]
  /** mff-ai 数据目录:整个在黑名单里,只有本会话 spillDir 可读 */
  dataDir: string
  spillDir?: string
  platform: NodeJS.Platform
  /** 用户规则(permissions 段,已编译) */
  rules: Rule[]
  sandbox: SandboxStatus
  allowUnsandboxedAuto: boolean
  /** 规则里 `~` 的基准 */
  home: string
  /** 规则模式字面前缀取 realpath 用;要传同一个函数,规则引擎按它缓存编译结果 */
  realpath?: (p: string) => string
}

/** 内置默认的 exec 结果(spec §4 第 3 条、§13):auto 只在有沙箱(或显式放开)时放行 */
function execDefault(mode: ApprovalMode, sandbox: SandboxStatus, allowUnsandboxedAuto: boolean): 'allow' | 'ask' {
  if (mode !== 'auto') return 'ask'
  return sandbox.level === 'none' && !allowUnsandboxedAuto ? 'ask' : 'allow'
}

/** IM 的消息是远程的(07 spec §8.3):auto 只在完整沙箱放行,不看 allowUnsandboxedAuto;partial 下命令能直接上网 */
const remoteExec = (mode: ApprovalMode, sandbox: SandboxStatus, unsandboxed = false): 'allow' | 'ask' =>
  mode === 'auto' && !unsandboxed && sandbox.level === 'full' ? 'allow' : 'ask'

/** 这次运行本身没有隔离:默认判定按无沙箱算,不看会话级别 */
const NONE_LEVEL: SandboxStatus = { level: 'none', missing: [], autoDegraded: false }

/**
 * 内置默认规则的显示形态(permissions.get 用;不可编辑)。判定里不走模式匹配,直接按 cwd 比较:
 * cwd 里的 `*`、`?`、括号不会被当成通配符或写法
 */
export function defaultRules(s: SessionInfo | undefined, sandbox: SandboxStatus, allowUnsandboxedAuto: boolean, platform: NodeJS.Platform = process.platform): string[] {
  const cwd = s ? s.cwd : '<cwd>'
  // 没有 cwd 或 cwd 是根:读写被硬拒绝,不列默认的 allow
  const listed = cwd !== undefined && (!s || !isRootLike(cwd, platform))
  const out = listed ? [`allow read(${cwd}/**)`, `allow write(${cwd}/**)`] : []
  const shell = !s ? '<mode>' : s.origin === 'im' ? remoteExec(s.approvalMode, sandbox) : execDefault(s.approvalMode, sandbox, allowUnsandboxedAuto)
  out.push(`${shell} shell(*)`)
  return out
}

/** 05 spec §5.3:硬拒绝 → 用户规则(deny > ask > allow)→ 内置默认 → 兜底拒绝 */
export function decide(req: PermissionRequest, s: SessionInfo | undefined, env: DecideEnv): Decision {
  if (req.actor === 'kernel') return 'allow'
  const { action, resource } = req
  const ctx = (cwd: string): MatchCtx => ({ cwd, home: env.home, platform: env.platform, realpath: env.realpath })
  if (action === 'read' || action === 'write') {
    if (resource === undefined) return 'deny'
    if (action === 'read' && env.spillDir && isInside(resource, env.spillDir, env.platform)) return 'allow'
    // 硬拒绝:规则放不开
    const cwd = s?.cwd
    if (!cwd || isRootLike(cwd, env.platform) || !isComparablePath(resource, env.platform)) return 'deny'
    if (isCredentialPath(resource, [...env.roots, env.dataDir], env.platform)) return 'deny'
    // 用户的 allow read 规则是对当面操作写的:放不开 IM 会话读用户的检出(07 §8.1),和沙箱同一份
    if (s?.origin === 'im' && !isInside(resource, cwd, env.platform) && imHiddenTops(s.repo, s.projectTop).some(t => !isInside(cwd, t, env.platform) && isInside(resource, t, env.platform))) return 'deny'
    if (action === 'write') {
      if (hasGitSegment(resource, env.platform)) return 'deny' // .git/hooks、.git/config 能让 git status 跑代码
      if (!isInside(resource, cwd, env.platform)) return 'deny' // 工作目录外的写
      if (isCredentialPath(resource, env.persistence, env.platform)) return 'deny' // 下次开终端 / 登录就执行
      if (PROJECT_CONFIG_DIRS.some(d => isInside(resource, join(cwd, d), env.platform))) return 'deny' // CLI 的主进程在沙箱外加载它们
    }
    const user = evaluate(env.rules, { action, resource }, ctx(cwd))
    if (user) return user
    return isInside(resource, cwd, env.platform) ? 'allow' : 'deny' // 默认 allow read / write(<cwd>/**),其余兜底拒绝
  }
  if (action === 'exec') {
    if (!s) return 'deny' // 没有会话就没有审批对象
    const user = evaluate(env.rules, { action, resource: resource ?? '' }, ctx(s.cwd ?? ''))
    if (user === 'deny' || user === 'ask') return user
    // 比会话宽的运行、有规则落实不了的运行:只有人能放行,allow 规则和 allowUnsandboxedAuto 都不算(04 spec §6、C2、C3)
    if (req.mustAsk || (req.unsandboxed && env.sandbox.level !== 'none')) return 'ask'
    // allow shell(*) 是对沙箱里的 shell 写的,放不开第三方的网络(09 M19)
    const named = req.confirm ? evaluate(env.rules.filter(r => r.effect === 'allow' && r.pattern.startsWith('mcp ')), { action, resource: resource ?? '' }, ctx(s.cwd ?? '')) : user
    if (req.confirm && named !== 'allow') return 'ask'
    const remote = s.origin === 'im'
    // 规则是对当面操作写的
    if (user === 'allow' && (!remote || env.sandbox.level === 'full')) return 'allow'
    if (remote) return remoteExec(s.approvalMode, env.sandbox, req.unsandboxed)
    return execDefault(s.approvalMode, req.unsandboxed ? NONE_LEVEL : env.sandbox, env.allowUnsandboxedAuto)
  }
  // 06 spec §8:不进规则语言,不走审批;能看到什么、写到哪由 memory-default 的 policy 按会话定
  if (action === 'memory') return s ? 'allow' : 'deny'
  // 09 §10.4:mcp 的 list、tools、describe,skill:只读索引,工具自己按视图查过了
  if (action === 'plugin') return s ? 'allow' : 'deny'
  return 'deny'
}

/** 读写判定不看沙箱级别,给 decide 的占位(不会被用到) */
const NOT_ASKED: SandboxStatus = { level: 'none', missing: [], autoDegraded: false }

export interface GateDeps {
  sessions: { get(id: string): SessionInfo | undefined; spillDir(id: string): string }
  home: string
  dataDir: string
  platform: NodeJS.Platform
  /** 启动时的环境快照(内核拷一份传进来,之后环境变化不影响) */
  env: EnvSnapshot
  /** 当前权限配置(每批判定现取:permissions.set 之后立即生效) */
  permissions: () => { rules: Rule[]; config: { allowUnsandboxedAuto: boolean } }
  /** 沙箱级别(内核 sandbox 服务);按会话问:代理没起来只影响它自己的会话 */
  sandbox: (sessionId?: string) => SandboxStatus
}

/** 规范化路径(最近存在的祖先 realpath);失败时用原样 */
function canonical(p: string, platform: NodeJS.Platform): string {
  const r = resolveToolPath(p, '.', { platform })
  return r === OUTSIDE ? p : r
}

/** 黑名单根 + 数据目录的原样与 realpath 形态;每次现算,之后才建出的 ~/.ssh 链接也拦得住 */
export function blacklist(d: Pick<GateDeps, 'home' | 'dataDir' | 'platform' | 'env'>): string[] {
  return canonicalRoots([...credentialRoots(d.home, d.platform, d.env), d.dataDir], { platform: d.platform })
}

/**
 * 持久化文件的原样与 realpath 形态(~/.zshrc 链到 dotfiles 仓库时,仓库里的目标也拒写);每次现算。
 * 插件存储根同一份(09 M13):cwd = ~ 的会话改得到插件代码,下次启动服务时没人同意过
 */
export function persistenceList(d: Pick<GateDeps, 'home' | 'dataDir' | 'platform' | 'env'>): string[] {
  return canonicalRoots([...persistenceRoots(d.home, d.platform, d.env), pluginStoreRootOf(d.dataDir)], { platform: d.platform })
}

export class PermissionGate {
  constructor(private deps: GateDeps) {}

  /** permissions.get 的 defaults:有会话按会话展开,没有保留占位符 */
  defaults(sessionId?: string): string[] {
    const s = sessionId === undefined ? undefined : this.deps.sessions.get(sessionId)
    const { allowUnsandboxedAuto } = this.deps.permissions().config
    return defaultRules(s, this.deps.sandbox(s?.sessionId), allowUnsandboxedAuto, this.deps.platform)
  }

  check(req: PermissionRequest): Decision {
    return this.checkMany([req])[0]
  }

  /** 批量判断(grep / glob 逐个文件过门):黑名单与各会话 spillDir 只算一次 */
  checkMany(reqs: PermissionRequest[]): Decision[] {
    const { sessions, dataDir, platform } = this.deps
    let shared: Omit<DecideEnv, 'spillDir' | 'platform' | 'sandbox'> | undefined
    const spills = new Map<string, string | undefined>()
    const levels = new Map<string | undefined, SandboxStatus>()
    /** 级别只对 exec 有用,按会话问一次 */
    const levelOf = (sessionId: string | undefined) => {
      let l = levels.get(sessionId)
      if (!l) levels.set(sessionId, (l = this.deps.sandbox(sessionId)))
      return l
    }
    return reqs.map(req => {
      if (req.actor === 'kernel') return 'allow'
      const s = req.sessionId === undefined ? undefined : sessions.get(req.sessionId)
      let spillDir: string | undefined
      if (s) {
        if (!spills.has(s.sessionId)) {
          try {
            spills.set(s.sessionId, canonical(sessions.spillDir(s.sessionId), platform))
          } catch {
            spills.set(s.sessionId, undefined)
          }
        }
        spillDir = spills.get(s.sessionId)
      }
      if (!shared) {
        const { rules, config } = this.deps.permissions()
        shared = {
          roots: blacklist(this.deps),
          persistence: persistenceList(this.deps),
          dataDir: canonical(dataDir, platform),
          rules,
          allowUnsandboxedAuto: config.allowUnsandboxedAuto,
          home: this.deps.home,
          realpath: realpathSync.native,
        }
      }
      // 读写不看级别;exec 没有会话直接拒,不问
      const sandbox = req.action === 'exec' && s ? levelOf(s.sessionId) : NOT_ASKED
      return decide(req, s, { ...shared, sandbox, spillDir, platform })
    })
  }
}

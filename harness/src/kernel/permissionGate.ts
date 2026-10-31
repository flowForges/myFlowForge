import { realpathSync } from 'node:fs'
import { canonicalRoots, credentialRoots, hasGitSegment, isComparablePath, isCredentialPath, isInside, isRootLike, OUTSIDE, persistenceRoots, resolveToolPath, type EnvSnapshot } from '../lib/fs/paths'
import { evaluate, type MatchCtx, type Rule } from '../lib/permissions/rules'
import type { PermissionRequest } from '../lib/tools/types'
import type { ApprovalMode, SandboxStatus } from '../protocol/index'
import { SANDBOX_STUB } from './permissions'
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

/**
 * 内置默认规则的显示形态(permissions.get 用;不可编辑)。判定里不走模式匹配,直接按 cwd 比较:
 * cwd 里的 `*`、`?`、括号不会被当成通配符或写法
 */
export function defaultRules(s: SessionInfo | undefined, sandbox: SandboxStatus, allowUnsandboxedAuto: boolean, platform: NodeJS.Platform = process.platform): string[] {
  const cwd = s ? s.cwd : '<cwd>'
  // 没有 cwd 或 cwd 是根:读写被硬拒绝,不列默认的 allow
  const listed = cwd !== undefined && (!s || !isRootLike(cwd, platform))
  const out = listed ? [`allow read(${cwd}/**)`, `allow write(${cwd}/**)`] : []
  out.push(`${s ? execDefault(s.approvalMode, sandbox, allowUnsandboxedAuto) : '<mode>'} shell(*)`)
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
    if (action === 'write') {
      if (hasGitSegment(resource, env.platform)) return 'deny' // .git/hooks、.git/config 能让 git status 跑代码
      if (!isInside(resource, cwd, env.platform)) return 'deny' // 工作目录外的写
      if (isCredentialPath(resource, env.persistence, env.platform)) return 'deny' // 下次开终端 / 登录就执行
    }
    const user = evaluate(env.rules, { action, resource }, ctx(cwd))
    if (user) return user
    return isInside(resource, cwd, env.platform) ? 'allow' : 'deny' // 默认 allow read / write(<cwd>/**),其余兜底拒绝
  }
  if (action === 'exec') {
    if (!s) return 'deny' // 没有会话就没有审批对象
    const user = evaluate(env.rules, { action, resource: resource ?? '' }, ctx(s.cwd ?? ''))
    return user ?? execDefault(s.approvalMode, env.sandbox, env.allowUnsandboxedAuto)
  }
  return 'deny'
}

export interface GateDeps {
  sessions: { get(id: string): SessionInfo | undefined; spillDir(id: string): string }
  home: string
  dataDir: string
  platform: NodeJS.Platform
  /** 启动时的环境快照(内核拷一份传进来,之后环境变化不影响) */
  env: EnvSnapshot
  /** 当前权限配置(每批判定现取:permissions.set 之后立即生效);不给 = 没有用户规则 */
  permissions?: () => { rules: Rule[]; config: { allowUnsandboxedAuto: boolean } }
  /**
   * 沙箱级别。Task 11 接上之前不给:此时 auto 照 03 放行(不降级)
   */
  sandbox?: () => SandboxStatus
}

/** 规范化路径(最近存在的祖先 realpath);失败时用原样 */
function canonical(p: string, platform: NodeJS.Platform): string {
  const r = resolveToolPath(p, '.', { platform })
  return r === OUTSIDE ? p : r
}

/** 黑名单根 + 数据目录的原样与 realpath 形态;每次现算,之后才建出的 ~/.ssh 链接也拦得住 */
export function blacklist(d: Omit<GateDeps, 'sessions'>): string[] {
  return canonicalRoots([...credentialRoots(d.home, d.platform, d.env), d.dataDir], { platform: d.platform })
}

/** 持久化文件的原样与 realpath 形态(~/.zshrc 链到 dotfiles 仓库时,仓库里的目标也拒写);每次现算 */
export function persistenceList(d: Omit<GateDeps, 'sessions'>): string[] {
  return canonicalRoots(persistenceRoots(d.home, d.platform, d.env), { platform: d.platform })
}

export class PermissionGate {
  constructor(private deps: GateDeps) {}

  /** 沙箱状态与是否允许无沙箱 auto;沙箱还没接上时不降级 */
  private execEnv(): { sandbox: SandboxStatus; allowUnsandboxedAuto: boolean } {
    const { sandbox, permissions } = this.deps
    if (!sandbox) return { sandbox: SANDBOX_STUB, allowUnsandboxedAuto: true }
    return { sandbox: sandbox(), allowUnsandboxedAuto: permissions?.().config.allowUnsandboxedAuto ?? false }
  }

  /** permissions.get 的 defaults:有会话按会话展开,没有保留占位符 */
  defaults(sessionId?: string): string[] {
    const s = sessionId === undefined ? undefined : this.deps.sessions.get(sessionId)
    const e = this.execEnv()
    return defaultRules(s, e.sandbox, e.allowUnsandboxedAuto, this.deps.platform)
  }

  check(req: PermissionRequest): Decision {
    return this.checkMany([req])[0]
  }

  /** 批量判断(grep / glob 逐个文件过门):黑名单与各会话 spillDir 只算一次 */
  checkMany(reqs: PermissionRequest[]): Decision[] {
    const { sessions, dataDir, platform } = this.deps
    let shared: Omit<DecideEnv, 'spillDir' | 'platform'> | undefined
    const spills = new Map<string, string | undefined>()
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
      shared ??= {
        roots: blacklist(this.deps),
        persistence: persistenceList(this.deps),
        dataDir: canonical(dataDir, platform),
        rules: this.deps.permissions?.().rules ?? [],
        ...this.execEnv(),
        home: this.deps.home,
        realpath: realpathSync.native,
      }
      return decide(req, s, { ...shared, spillDir, platform })
    })
  }
}

import { canonicalRoots, credentialRoots, hasGitSegment, isCredentialPath, isInside, isRootLike, OUTSIDE, persistenceRoots, resolveToolPath, type EnvSnapshot } from '../lib/fs/paths'
import type { PermissionRequest } from '../lib/tools/types'
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
}

/** spec §10 规则 1–6,按顺序 */
export function decide(req: PermissionRequest, s: SessionInfo | undefined, env: DecideEnv): Decision {
  if (req.actor === 'kernel') return 'allow'
  const { action, resource } = req
  if (action === 'read' || action === 'write') {
    if (resource === undefined) return 'deny'
    if (action === 'read' && env.spillDir && isInside(resource, env.spillDir, env.platform)) return 'allow'
    if (!s?.cwd || isRootLike(s.cwd, env.platform) || !isInside(resource, s.cwd, env.platform)) return 'deny'
    if (isCredentialPath(resource, [...env.roots, env.dataDir], env.platform)) return 'deny'
    if (action === 'write' && hasGitSegment(resource, env.platform)) return 'deny' // .git/hooks、.git/config 能让 git status 跑代码
    if (action === 'write' && isCredentialPath(resource, env.persistence, env.platform)) return 'deny' // 下次开终端 / 登录就执行
    return 'allow'
  }
  if (action === 'exec') {
    if (!s) return 'deny' // 没有会话就没有审批对象
    return s.approvalMode === 'auto' ? 'allow' : 'ask'
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

  check(req: PermissionRequest): Decision {
    return this.checkMany([req])[0]
  }

  /** 批量判断(grep / glob 逐个文件过门):黑名单与各会话 spillDir 只算一次 */
  checkMany(reqs: PermissionRequest[]): Decision[] {
    const { sessions, dataDir, platform } = this.deps
    let shared: { roots: string[]; persistence: string[]; dataDir: string } | undefined
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
      shared ??= { roots: blacklist(this.deps), persistence: persistenceList(this.deps), dataDir: canonical(dataDir, platform) }
      return decide(req, s, { ...shared, spillDir, platform })
    })
  }
}

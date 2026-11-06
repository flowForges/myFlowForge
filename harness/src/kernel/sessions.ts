import { realpathSync, statSync } from 'node:fs'
import { join, posix, win32 } from 'node:path'
import type { ApprovalMode, KernelEvent, ModelRef, SessionAudience, SessionOrigin, Toolset } from '../protocol/index'
import { RpcError } from './rpcError'
import { isCredentialPath, isInside, isRootLike, pluginStoreRootOf, type EnvSnapshot } from '../lib/fs/paths'
import { parsePin, type RepoPin } from '../lib/git/snapshot'
import { imWorktreeRootOf } from '../lib/git/imWorktree'
import { worktreeRootOf } from '../lib/git/worktree'
import { blacklist } from './permissionGate'

// 内核 sessions 服务:从 session.created 载荷重建每个会话的选项,供权限门与循环插件查询

export interface SessionInfo {
  sessionId: string
  cwd?: string
  approvalMode: ApprovalMode
  toolset?: Toolset
  model?: ModelRef
  origin: SessionOrigin
  /** 建会话时定下,之后不能改;推算规则见 audienceOf */
  audience: SessionAudience
  /** 建会话时定下的仓库。沙箱外的 git 只认它;旧日志里的会话没有,按没有仓库算(那时模型可能已经写过了) */
  repo?: RepoPin
  /** IM 会话:worktree 从哪个检出建的(07 §8.1) */
  projectTop?: string
}

/** 08 §4.1:列表要的、SessionInfo 之外的。分开放:get() 的形状不变 */
export interface SessionMeta {
  /** 最后一条 session.renamed,没有就是 session.created 的,再没有是 新会话 */
  title: string
  createdAt: number
  /** 这个会话最近一条事件的时间;后台写的检查点不算 */
  updatedAt: number
  /** 有 session.deleted:不再列出、不再收消息 */
  deleted: boolean
}

export const DEFAULT_TITLE = '新会话'
const SAFE_ID = /^[A-Za-z0-9_-]+$/
const titleOf = (raw: unknown): string | undefined => (typeof raw === 'string' && raw !== '' ? raw : undefined)

/** 没写 = app(只有不是 app 时才写进事件);不认识的值不当 app:app 是唯一在地写的来源 */
function originOf(raw: unknown): SessionOrigin {
  if (raw === undefined || raw === 'app') return 'app'
  return raw === 'im' || raw === 'acp' ? raw : 'schedule'
}

/**
 * 要原始的 origin:originOf 把不认识的值归成 schedule,而 schedule 算 owner。
 * 判错不对称:私聊当群聊只是没记忆,群聊当私聊是泄露,所以不认识的一律 group
 */
function audienceOf(raw: unknown, rawOrigin: unknown): SessionAudience {
  if (raw === 'owner' || raw === 'group') return raw
  if (raw !== undefined) return 'group'
  return rawOrigin === undefined || rawOrigin === 'app' || rawOrigin === 'schedule' || rawOrigin === 'acp' ? 'owner' : 'group'
}

export class Sessions {
  private byId = new Map<string, SessionInfo>()
  private metaById = new Map<string, SessionMeta>()

  constructor(private dataDir: string) {}

  load(events: Iterable<KernelEvent>): void {
    for (const e of events) this.observe(e)
  }

  observe(e: KernelEvent): void {
    const meta = e.sessionId === undefined ? undefined : this.metaById.get(e.sessionId)
    if (meta && e.type !== 'memory.checkpoint') meta.updatedAt = e.ts
    if (e.type === 'session.renamed') {
      const t = titleOf((e.payload as { title?: unknown } | null)?.title)
      if (meta && t !== undefined) meta.title = t
      return
    }
    if (e.type === 'session.deleted') {
      if (meta) meta.deleted = true
      return
    }
    // 只收窄不放宽(07 §8.3):auto 的条件没了,这个会话从此每条命令都问,重启后也是。放宽要开新会话
    if (e.type === 'session.approvalNarrowed' && e.sessionId) {
      const narrowed = this.byId.get(e.sessionId)
      if (narrowed) narrowed.approvalMode = 'ask'
      return
    }
    if (e.type !== 'session.created' || !e.sessionId) return
    const p = (e.payload ?? {}) as Partial<Omit<SessionInfo, 'sessionId'>> & { title?: unknown }
    const info: SessionInfo = {
      sessionId: e.sessionId,
      approvalMode: p.approvalMode === 'auto' ? 'auto' : 'ask', // v2 会话没有该字段
      origin: originOf(p.origin),
      audience: audienceOf(p.audience, p.origin),
    }
    if (typeof p.cwd === 'string') info.cwd = p.cwd
    if (p.toolset === 'patch' || p.toolset === 'edit') info.toolset = p.toolset
    if (p.model) info.model = p.model
    if (info.cwd !== undefined) info.repo = parsePin(p.repo)
    if (typeof p.projectTop === 'string' && posix.isAbsolute(p.projectTop)) info.projectTop = p.projectTop
    this.byId.set(e.sessionId, info)
    // 同一 id 再来一条 session.created(只有插件写得出来)也不能让删掉的会话复活
    this.metaById.set(e.sessionId, { title: titleOf(p.title) ?? DEFAULT_TITLE, createdAt: e.ts, updatedAt: e.ts, deleted: this.isDeleted(e.sessionId) })
  }

  /** 标题、时间、删没删;get() 照常回答删掉的会话(各部分启动时要靠它清残留) */
  meta(id: string): SessionMeta | undefined {
    const m = this.metaById.get(id)
    return m && { ...m }
  }

  isDeleted(id: string): boolean {
    return this.metaById.get(id)?.deleted === true
  }

  /** 没删的会话,按建立顺序 */
  list(): SessionInfo[] {
    return [...this.byId.values()].filter(i => !this.isDeleted(i.sessionId))
  }

  deletedIds(): string[] {
    return [...this.metaById].filter(([, m]) => m.deleted).map(([id]) => id)
  }

  get(id: string): SessionInfo | undefined {
    return this.byId.get(id)
  }

  /** 工具输出落盘目录(只给路径,不创建) */
  spillDir(id: string): string {
    return join(this.sessionDir(id), 'spill')
  }

  /** `<数据目录>/sessions/<id>`;id 不合 SAFE_ID 就抛错(删会话时靠它不出这个目录) */
  sessionDir(id: string): string {
    if (!SAFE_ID.test(id)) throw new Error('invalid session id')
    return join(this.dataDir, 'sessions', id)
  }
}

export interface CwdEnv {
  home: string
  dataDir: string
  platform: NodeJS.Platform
  /** 内核启动时的环境快照(凭据黑名单含环境变量挪走的位置) */
  env?: EnvSnapshot
  /** 测试注入(win32 路径在 posix 上跑) */
  fs?: { realpath(p: string): string; isDirectory(p: string): boolean }
}

const realFs = { realpath: (p: string) => realpathSync.native(p), isDirectory: (p: string) => statSync(p).isDirectory() }

/** 会话工作目录:绝对、存在、是目录、不是根、不在凭据黑名单 / mff-ai 数据目录里;返回 realpath */
export function validateCwd(raw: string, env: CwdEnv): string {
  const invalid = () => new RpcError(-32602, 'invalid cwd')
  const win = env.platform === 'win32'
  const path = win ? win32 : posix
  // win32 只收 `X:\…`(拒 `\\?\`、UNC、`\foo` 这种无盘符的);与权限门的判断一致
  if (win ? !/^[A-Za-z]:[\\/]/.test(raw) : !path.isAbsolute(raw)) throw invalid()
  const fs = env.fs ?? realFs
  let real: string
  try {
    real = fs.realpath(raw)
    if (!fs.isDirectory(real)) throw invalid()
  } catch {
    throw invalid()
  }
  if (path.dirname(real) === real || isRootLike(real, env.platform)) throw invalid() // 文件系统根(含盘符根、折叠后为根的 /System/Volumes/Data)
  const roots = blacklist({ home: env.home, dataDir: env.dataDir, platform: env.platform, env: env.env ?? {} })
  if (isCredentialPath(real, roots, env.platform)) throw invalid() // 也拒 realpath 后变成 UNC / 带 `:` 的
  // worktree 根和 <根>/<会话>:开在这里的会话写得到别的运行留下的 worktree。单个保留的 worktree 可以当 cwd。IM 的根同样
  for (const wtRoot of [worktreeRootOf(env.dataDir), imWorktreeRootOf(env.dataDir)]) {
    let wtReal = wtRoot
    try {
      wtReal = fs.realpath(wtRoot)
    } catch {
      // 还没建
    }
    for (const r of new Set([wtRoot, wtReal])) {
      if (isInside(real, r, env.platform) && path.relative(r, real).split(path.sep).filter(Boolean).length < 2) throw invalid()
    }
  }
  // 插件存储根和它里面(09 M13):可写的 cwd 开在这里就是改插件代码
  const store = pluginStoreRootOf(env.dataDir)
  let storeReal = store
  try {
    storeReal = fs.realpath(store)
  } catch {
    // 还没建
  }
  for (const r of new Set([store, storeReal])) if (isInside(real, r, env.platform)) throw invalid()
  return real
}

import { realpathSync, statSync } from 'node:fs'
import { join, posix, win32 } from 'node:path'
import type { ApprovalMode, KernelEvent, ModelRef, Toolset } from '../protocol/index'
import { RpcError } from './rpcError'

// 内核 sessions 服务:从 session.created 载荷重建每个会话的选项,供权限门与循环插件查询

export interface SessionInfo {
  sessionId: string
  cwd?: string
  approvalMode: ApprovalMode
  toolset?: Toolset
  model?: ModelRef
}

const SAFE_ID = /^[A-Za-z0-9_-]+$/

export class Sessions {
  private byId = new Map<string, SessionInfo>()

  constructor(private dataDir: string) {}

  load(events: Iterable<KernelEvent>): void {
    for (const e of events) this.observe(e)
  }

  observe(e: KernelEvent): void {
    if (e.type !== 'session.created' || !e.sessionId) return
    const p = (e.payload ?? {}) as Partial<Omit<SessionInfo, 'sessionId'>>
    const info: SessionInfo = { sessionId: e.sessionId, approvalMode: p.approvalMode === 'auto' ? 'auto' : 'ask' } // v2 会话没有该字段
    if (typeof p.cwd === 'string') info.cwd = p.cwd
    if (p.toolset === 'patch' || p.toolset === 'edit') info.toolset = p.toolset
    if (p.model) info.model = p.model
    this.byId.set(e.sessionId, info)
  }

  get(id: string): SessionInfo | undefined {
    return this.byId.get(id)
  }

  /** 工具输出落盘目录(只给路径,不创建) */
  spillDir(id: string): string {
    if (!SAFE_ID.test(id)) throw new Error('invalid session id')
    return join(this.dataDir, 'sessions', id, 'spill')
  }
}

export interface CwdEnv {
  home: string
  dataDir: string
  platform: NodeJS.Platform
}

// TODO(Task 3):换成 lib/fs/paths 的 isCredentialPath(凭据黑名单 + mff-ai 数据目录)
function isBlacklistedCwd(_real: string, _env: CwdEnv): boolean {
  return false
}

/** 会话工作目录:绝对、存在、是目录、不是根、不在凭据黑名单里;返回 realpath */
export function validateCwd(raw: string, env: CwdEnv): string {
  const invalid = () => new RpcError(-32602, 'invalid cwd')
  const path = env.platform === 'win32' ? win32 : posix
  if (!path.isAbsolute(raw)) throw invalid()
  let real: string
  try {
    real = realpathSync.native(raw)
    if (!statSync(real).isDirectory()) throw invalid()
  } catch {
    throw invalid()
  }
  if (path.dirname(real) === real) throw invalid() // 文件系统根(含盘符根)
  if (isBlacklistedCwd(real, env)) throw invalid()
  return real
}

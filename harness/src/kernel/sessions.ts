import { realpathSync, statSync } from 'node:fs'
import { join, posix, win32 } from 'node:path'
import type { ApprovalMode, KernelEvent, ModelRef, Toolset } from '../protocol/index'
import { RpcError } from './rpcError'
import { isCredentialPath, isRootLike } from '../lib/fs/paths'
import { blacklist } from './permissionGate'

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
  env?: { APPDATA?: string }
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
  return real
}

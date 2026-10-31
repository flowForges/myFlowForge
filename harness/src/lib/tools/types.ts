// 工具与 tools 服务的接口(spec §6);实现在 plugins/tools-registry
import type { ZodType } from 'zod'
import type { SandboxStatus } from '../../protocol/rpc'

/** 权限请求;路径资源由工具解析成绝对路径后给出(lib/fs/paths 的 resolveToolPath) */
export interface PermissionRequest {
  actor: 'kernel' | string
  action: 'read' | 'write' | 'exec' | string
  resource?: string
  sessionId?: string
}

export interface ToolContext {
  sessionId: string
  turnId: string
  callId: string
  /** 会话工作目录(建会话时已 realpath) */
  cwd: string
  /** 本会话的落盘目录(内核 sessions 服务给出) */
  spillDir: string
  signal: AbortSignal
}

export interface ToolResult {
  content: string
  isError?: boolean
  meta?: Record<string, unknown>
}

export interface Tool {
  /** 模型看到的名字 */
  name: string
  description: string
  /** JSON Schema */
  parameters: object
  /** 权限请求:由参数算出动作与资源;返回多个时全部要放行;空数组 = 拒绝(tools 服务不执行) */
  permission(args: unknown, ctx: ToolContext): PermissionRequest[]
  run(args: unknown, ctx: ToolContext): Promise<ToolResult>
}

export interface ToolsService {
  register(tool: Tool): () => void
  list(filter?: (t: Tool) => boolean): Tool[]
  /** 校验参数 → 权限门(必要时等审批)→ 执行 → 截断 / 落盘 → 写事件;永不抛错 */
  call(name: string, rawArgs: string, ctx: ToolContext): Promise<ToolResult>
}

/** 工具在 permission / run 里用自己的 zod 校验参数;不合格 → 抛错(tools 服务把消息作为 isError 交给模型) */
export function argsOf<T>(schema: ZodType<T>, raw: unknown): T {
  const r = schema.safeParse(raw)
  if (r.success) return r.data
  const issues = r.error.issues.map(i => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
  throw new Error(`参数无效:${issues.join('; ')}`)
}

/** 一条 shell 命令的执行计划(05 spec §10);由内核 `sandbox` 服务生成,shell 工具执行 */
export interface ShellPlan {
  /** sandboxed:可执行文件(sandbox-exec / bwrap);否则就是命令本身(调用方用 shell:true) */
  file: string
  args: string[]
  env: NodeJS.ProcessEnv
  sandboxed: boolean
  /** 本条命令实际的级别(ToolResult.meta.sandbox) */
  level: SandboxStatus['level']
  /** 命令结束后调用一次(多调无害):会话代理从此按空闲计时。不调 → 代理一直开到内核关闭 */
  release(): void
}

/** 内核 `sandbox` 服务(实现在 kernel/sandbox.ts) */
export interface SandboxService {
  /** 不给 sessionId:探测结果 + 配置;给了:另算该会话的代理是否没起来(partial + proxy) */
  status(sessionId?: string): SandboxStatus
  /**
   * 生成本条命令的计划;级别 none → { file: command, args: [], env 原样, sandboxed: false }。
   * 生成沙箱配置失败 → reject:调用方让命令失败,绝不退回无沙箱执行
   */
  plan(command: string, s: { sessionId: string; cwd: string; spillDir: string }, env: NodeJS.ProcessEnv): Promise<ShellPlan>
  close(): Promise<void>
}

// 工具与 tools 服务的接口(spec §6);实现在 plugins/tools-registry
import type { ZodType } from 'zod'

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
  /** 权限请求:由参数算出动作与资源;返回多个时全部要放行 */
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

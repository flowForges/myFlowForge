// 工具与 tools 服务的接口(spec §6);实现在 plugins/tools-registry
import type { ZodType } from 'zod'
import type { SandboxStatus } from '../../protocol/rpc'

/** 权限请求;路径资源由工具解析成绝对路径后给出(lib/fs/paths 的 resolveToolPath) */
export interface PermissionRequest {
  actor: 'kernel' | string
  action: 'read' | 'write' | 'exec' | string
  resource?: string
  sessionId?: string
  /** 审批卡片的摘要;委派工具给(已打码) */
  summary?: string
  /** 本会话放行的键;mustAsk 时不给 */
  key?: string
  /** 这次运行的实际隔离是 none;委派工具总是显式给,其他工具不给 = 按会话级别 */
  unsandboxed?: boolean
  /** 有用户 deny / ask 规则这次落实不了:任何模式都问,且没有本会话放行 */
  mustAsk?: boolean
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
  /**
   * 权限门 / 审批卡看到的沙箱级别(tools-registry 填)。shell 的计划若是 none 而这里不是 none,
   * 说明放行之后沙箱没了:不执行(review I1)。不填 = 不比较
   */
  sandboxLevel?: SandboxStatus['level']
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
  /** 委派工具:toolDefs 把它们按名字排序接在工具集之后 */
  delegate?: boolean
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

/** 一条挂起时收下的用户消息;ts 是那条 message.user 的时间 */
export interface FollowUp {
  text: string
  ts: number
}

/** 每轮一个,随 session.prompt 的总线载荷交给处理者;不调 park 的循环,轮一直回 ERR_BUSY */
export interface TurnInbox {
  /** 同步置 parked;有消息、轮中止、unpark 或下一次 park 时 resolve。resolve 不代表有消息,要看 take() */
  park(): Promise<void>
  /** 同步清 parked */
  unpark(): void
  /** 已收下、还没进本轮消息的 */
  take(): FollowUp[]
}

export interface RunNotice {
  runId: string
  text: string
}

/** `executors` 服务:循环只经它等后台运行,不 import 插件 */
export interface BackgroundRuns {
  /** 排队中 + 运行中 */
  active(turnId: string): number
  /** 已结束、还没取走 */
  pending(turnId: string): number
  /** 已结束、还没送达的;每条恰好一次 */
  take(turnId: string): RunNotice[]
  /** 有通知可取或 signal 中止时 resolve */
  wait(turnId: string, signal: AbortSignal): Promise<void>
  /** 杀掉本轮所有运行;每个 run.ended 都写完才 resolve */
  abandon(turnId: string, reason?: string): Promise<void>
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

/** 给执行器翻译隔离用的策略 */
export interface ExecPolicy {
  denyRead: string[]
  persistence: string[]
  dataDir: string
  level: SandboxStatus['level']
  ruleDenyRead: string[]
  ruleDenyWrite: string[]
  /** literalRoots 翻译不了的 deny / ask 读写规则,加上 deny / ask 的 shell 规则(Task 7) */
  untranslatedRules: number
  totalRules: number
}

/** planExec 的选项(04 spec §8.2) */
export interface ExecPlanOpts {
  /** 从凭据黑名单里豁免,可读 */
  allowRead: string[]
  /** 额外可写 */
  allowWrite: string[]
  /** 只给这一次运行的代理 */
  allowHosts: string[]
  /** runId:独立代理实例 */
  proxyScope: string
  /** cwd 不进可写根 */
  readOnly: boolean
  /** 用户规则翻译来的 */
  denyRead: string[]
  denyWrite: string[]
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
  /** 同步:委派工具的 permission() 要用;resource 是执行器 id */
  execPolicy(sessionId: string, cwd: string, resource?: string): ExecPolicy
  /** plan() 的 argv 版本:CLI 主程序包进沙箱;失败 → reject,绝不退回无沙箱 */
  planExec(file: string, args: string[], s: { sessionId: string; cwd: string; spillDir: string }, env: NodeJS.ProcessEnv, o: ExecPlanOpts): Promise<ShellPlan>
  close(): Promise<void>
}

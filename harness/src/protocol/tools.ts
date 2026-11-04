import { z } from 'zod'

// v3:工具调用、审批、快照相关的会话选项与事件载荷

export const ApprovalModeSchema = z.enum(['ask', 'auto'])
export type ApprovalMode = z.infer<typeof ApprovalModeSchema>

export const ToolsetSchema = z.enum(['patch', 'edit'])
export type Toolset = z.infer<typeof ToolsetSchema>

// 04:会话来源;不是 app 的会话,写模式委派一律进 worktree(acp 除外:编辑器里开的,和 app 一样在地跑)
// 06:acp 是客户端代发,可能是脚本,不算用户本人说的话
export const SessionOriginSchema = z.enum(['app', 'im', 'schedule', 'acp'])
export type SessionOrigin = z.infer<typeof SessionOriginSchema>

// 06:谁在会话里。group 看不到主人的记忆,也留不下记忆;建会话时定下,之后不能改
export const SessionAudienceSchema = z.enum(['owner', 'group'])
export type SessionAudience = z.infer<typeof SessionAudienceSchema>

export const ToolStartedPayloadSchema = z.object({
  turnId: z.string(),
  callId: z.string(),
  name: z.string(),
  argsPreview: z.string(),
})
export type ToolStartedPayload = z.infer<typeof ToolStartedPayloadSchema>

/** 事件日志里是完整 content;推给客户端时由 wire 视图截断并加 truncated */
export const ToolEndedPayloadSchema = z.object({
  turnId: z.string(),
  callId: z.string(),
  name: z.string(),
  ok: z.boolean(),
  ms: z.number(),
  content: z.string(),
  isError: z.boolean().optional(),
  truncated: z.boolean().optional(),
})
export type ToolEndedPayload = z.infer<typeof ToolEndedPayloadSchema>

export const ApprovalRequestedPayloadSchema = z.object({
  approvalId: z.string(),
  turnId: z.string(),
  callId: z.string(),
  tool: z.string(),
  summary: z.string(),
  /** 本会话放行的键。没有 = allow_session 只算这一次,客户端不该提供那个选项 */
  key: z.string().optional(),
  /** 这次不在隔离里跑:委派工具按这次运行的实际隔离,其他工具按会话的沙箱级别 none */
  unsandboxed: z.boolean().optional(),
})
export type ApprovalRequestedPayload = z.infer<typeof ApprovalRequestedPayloadSchema>

export const ApprovalResolvedPayloadSchema = z.object({
  approvalId: z.string(),
  decision: z.enum(['allow', 'deny']),
  by: z.enum(['user', 'session', 'timeout', 'cancel']),
})
export type ApprovalResolvedPayload = z.infer<typeof ApprovalResolvedPayloadSchema>

export const TurnSnapshotPayloadSchema = z.object({
  turnId: z.string(),
  phase: z.enum(['start', 'end']),
  ref: z.string().optional(),
  changed: z.number().optional(),
  reason: z.string().optional(),
})
export type TurnSnapshotPayload = z.infer<typeof TurnSnapshotPayloadSchema>

export const TurnRolledBackPayloadSchema = z.object({ turnId: z.string(), files: z.number(), skipped: z.array(z.string()).optional() })
export type TurnRolledBackPayload = z.infer<typeof TurnRolledBackPayloadSchema>

export const FileChangeSchema = z.object({ path: z.string(), status: z.enum(['A', 'M', 'D', 'T']) })
export type FileChange = z.infer<typeof FileChangeSchema>

/** message.assistant.parts:模型层 Part 去掉 image */
export const AssistantPartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('tool_call'), id: z.string(), name: z.string(), args: z.string() }),
  z.object({ type: z.literal('tool_result'), callId: z.string(), content: z.string(), isError: z.boolean().optional() }),
  // accountId / protocol / modelId:产出该 replay 的模型;重建历史时只回传给同一个
  z.object({
    type: z.literal('reasoning'),
    text: z.string().optional(),
    replay: z.unknown().optional(),
    accountId: z.string().optional(),
    protocol: z.string().optional(),
    modelId: z.string().optional(),
  }),
])
export type AssistantPart = z.infer<typeof AssistantPartSchema>

// 04:委派给本机 CLI(spec §12、§14)
export const ExecutorIsolationSchema = z.enum(['own', 'wrapped', 'none'])
export type ExecutorIsolation = z.infer<typeof ExecutorIsolationSchema>

export const ExecutorRunStatusSchema = z.enum(['ok', 'failed', 'cancelled', 'timeout', 'stalled', 'interrupted'])
export type ExecutorRunStatus = z.infer<typeof ExecutorRunStatusSchema>

export const ExecutorRunReasonSchema = z.enum([
  'not_installed',
  'auth_missing',
  'quota',
  'spawn_failed',
  'exit_nonzero',
  'cli_error',
  'no_result',
  'timeout',
  'stalled',
  'cancelled',
  'kernel_stopping',
  'daemon_restart',
  'sandbox_unavailable',
  'worktree_unavailable',
  'worktree_limit',
  'queue_full',
  'too_many_runs',
  'denied',
  'untrusted_binary',
  'kill_failed',
])
export type ExecutorRunReason = z.infer<typeof ExecutorRunReasonSchema>

/** 改动清单的来源:快照 diff、CLI 自报,或都没有 */
export const ExecutorChangesSourceSchema = z.enum(['git', 'cli', 'none'])
export type ExecutorChangesSource = z.infer<typeof ExecutorChangesSourceSchema>

export const ExecutorRunQueuedPayloadSchema = z.object({
  runId: z.string(),
  turnId: z.string(),
  callId: z.string(),
  executor: z.string(),
  summary: z.string(),
  readOnly: z.boolean(),
  isolation: ExecutorIsolationSchema,
  position: z.number(),
})
export type ExecutorRunQueuedPayload = z.infer<typeof ExecutorRunQueuedPayloadSchema>

export const ExecutorRunStartedPayloadSchema = z.object({
  runId: z.string(),
  turnId: z.string(),
  executor: z.string(),
  cwd: z.string(),
  isolation: ExecutorIsolationSchema,
  worktree: z.string().optional(),
  untranslatedRules: z.number().optional(),
})
export type ExecutorRunStartedPayload = z.infer<typeof ExecutorRunStartedPayloadSchema>

export const ExecutorRunProgressPayloadSchema = z.object({
  runId: z.string(),
  turnId: z.string(),
  kind: z.enum(['tool', 'file', 'text', 'think']),
  text: z.string(),
})
export type ExecutorRunProgressPayload = z.infer<typeof ExecutorRunProgressPayloadSchema>

export const ExecutorRunEndedPayloadSchema = z.object({
  runId: z.string(),
  turnId: z.string(),
  executor: z.string(),
  status: ExecutorRunStatusSchema,
  reason: ExecutorRunReasonSchema.optional(),
  ms: z.number(),
  exit: z.number().optional(),
  signal: z.string().optional(),
  /** 用户套餐的用量,不算进 turn.usage */
  usage: z.object({ input: z.number(), output: z.number(), cached: z.number().optional() }).optional(),
  /** files 只有路径:CLI 自报时没有状态;要状态用 executor.changes */
  changed: z.object({
    files: z.array(z.string()),
    source: ExecutorChangesSourceSchema,
    concurrent: z.boolean().optional(),
    /** 只在 wire 视图里:files 被截掉的条数 */
    filesTruncated: z.number().optional(),
  }),
  violations: z.array(z.string()).optional(),
  /** 只在 wire 视图里:violations 被截掉的条数 */
  violationsTruncated: z.number().optional(),
  worktree: z.string().optional(),
  rawLog: z.string().optional(),
  nativeId: z.string().optional(),
  droppedProgress: z.number().optional(),
})
export type ExecutorRunEndedPayload = z.infer<typeof ExecutorRunEndedPayloadSchema>

/** 给模型的;step 只有循环写时才有,finally 与崩溃恢复写的没有。事件日志里是完整 text,wire 视图截断并加 truncated */
export const ExecutorNoticePayloadSchema = z.object({
  turnId: z.string(),
  step: z.number().optional(),
  runId: z.string(),
  text: z.string(),
  truncated: z.boolean().optional(),
})
export type ExecutorNoticePayload = z.infer<typeof ExecutorNoticePayloadSchema>

export const TurnParkedPayloadSchema = z.object({ turnId: z.string(), step: z.number(), active: z.number(), pending: z.number() })
export type TurnParkedPayload = z.infer<typeof TurnParkedPayloadSchema>

export const TurnResumedPayloadSchema = z.object({ turnId: z.string(), step: z.number(), cause: z.enum(['notice', 'message', 'abort']) })
export type TurnResumedPayload = z.infer<typeof TurnResumedPayloadSchema>

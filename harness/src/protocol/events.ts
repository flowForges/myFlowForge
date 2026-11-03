import { z } from 'zod'
import { AccountViewSchema } from './models'

export const EVENT_TYPES = [
  'kernel.started',
  'kernel.stopping',
  'plugin.activated',
  'plugin.failed',
  'session.created',
  'turn.started',
  'message.user',
  'message.assistant.delta',
  'message.assistant',
  'turn.ended',
  'turn.failed',
  'account.updated',
  'message.reasoning.delta',
  'turn.usage',
  'auth.chatgpt.ended',
  'tool.started',
  'tool.ended',
  'approval.requested',
  'approval.resolved',
  'turn.snapshot',
  'turn.rolledBack',
  'permissions.updated',
  'sandbox.netDenied',
  'executor.run.queued',
  'executor.run.started',
  'executor.run.progress',
  'executor.run.ended',
  'executor.notice',
  'turn.parked',
  'turn.resumed',
  'memory.injected',
  'memory.checkpoint',
  'context.rebuilt',
  'memory.deleted',
  'events.redacted',
  'memory.updated',
  'memory.proposal',
  'memory.consolidated',
  'memory.recommendation',
] as const

export const EventTypeSchema = z.enum(EVENT_TYPES)
export type EventType = z.infer<typeof EventTypeSchema>

export const KernelEventSchema = z.object({
  seq: z.number(),
  ts: z.number(),
  type: EventTypeSchema,
  sessionId: z.string().optional(),
  payload: z.unknown(),
})
export type KernelEvent = z.infer<typeof KernelEventSchema>

// v2 新事件的载荷
export const AccountUpdatedPayloadSchema = z.object({ account: AccountViewSchema })
export type AccountUpdatedPayload = z.infer<typeof AccountUpdatedPayloadSchema>

export const ReasoningDeltaPayloadSchema = z.object({ turnId: z.string(), text: z.string() })
export type ReasoningDeltaPayload = z.infer<typeof ReasoningDeltaPayloadSchema>

/** ChatGPT 登录流结束(成功 / 失败 / 超时 / 取消 / 被新登录顶替),每个 flow 恰好一次 */
export const ChatgptEndedPayloadSchema = z.object({ flowId: z.string(), ok: z.boolean(), accountId: z.string().optional() })
export type ChatgptEndedPayload = z.infer<typeof ChatgptEndedPayloadSchema>

export const TurnUsagePayloadSchema = z.object({
  turnId: z.string(),
  input: z.number(),
  output: z.number(),
  cacheRead: z.number().optional(),
  cacheWrite: z.number().optional(),
})
export type TurnUsagePayload = z.infer<typeof TurnUsagePayloadSchema>

// 05:权限配置换了(只带条数,不带规则内容)
export const PermissionsUpdatedPayloadSchema = z.object({ rules: z.number(), network: z.number() })
export type PermissionsUpdatedPayload = z.infer<typeof PermissionsUpdatedPayloadSchema>

// 05:沙箱代理拦下的连接(记在会话上)
export const SandboxNetDeniedPayloadSchema = z.object({ host: z.string(), port: z.number(), reason: z.string() })
export type SandboxNetDeniedPayload = z.infer<typeof SandboxNetDeniedPayloadSchema>

// 06:记忆(spec §16)。只有 injected、checkpoint、recommendation 带文本;truncated 只在 wire 视图里
export const MemoryInjectedPayloadSchema = z.object({
  turnId: z.string(),
  kind: z.enum(['session', 'turn']),
  text: z.string(),
  /** 这段文本用到的每一条记忆的 id;删除时靠它定位 */
  items: z.array(z.string()),
  coreVersion: z.string().optional(),
  truncated: z.boolean().optional(),
})
export type MemoryInjectedPayload = z.infer<typeof MemoryInjectedPayloadSchema>

export const MemoryCheckpointPayloadSchema = z.object({
  throughSeq: z.number(),
  /** 写手开始时读到的日志位置:之后才撤销它包含的轮,这个检查点才失效 */
  asOfSeq: z.number(),
  text: z.string(),
  model: z.string(),
  tokens: z.number(),
  covers: z.number(),
  usd: z.number().optional(),
  redacted: z.boolean().optional(),
  truncated: z.boolean().optional(),
})
export type MemoryCheckpointPayload = z.infer<typeof MemoryCheckpointPayloadSchema>

export const ContextRebuiltPayloadSchema = z.object({
  turnId: z.string(),
  step: z.number(),
  checkpointSeq: z.number(),
  throughSeq: z.number(),
  before: z.number(),
  after: z.number(),
})
export type ContextRebuiltPayload = z.infer<typeof ContextRebuiltPayloadSchema>

export const MemoryDeletedPayloadSchema = z.object({ id: z.string(), rawSeqs: z.array(z.number()) })
export type MemoryDeletedPayload = z.infer<typeof MemoryDeletedPayloadSchema>

export const EventsRedactedPayloadSchema = z.object({ by: z.string(), seqs: z.array(z.number()) })
export type EventsRedactedPayload = z.infer<typeof EventsRedactedPayloadSchema>

export const MemoryUpdatedPayloadSchema = z.object({ id: z.string().optional(), file: z.string().optional(), op: z.string(), source: z.string() })
export type MemoryUpdatedPayload = z.infer<typeof MemoryUpdatedPayloadSchema>

export const MemoryProposalTargetSchema = z.enum(['USER.md', 'MEMORY.md'])
export const MemoryProposalStatusSchema = z.enum(['pending', 'approved', 'rejected', 'expired'])
export const MemoryProposalPayloadSchema = z.object({ id: z.string(), target: MemoryProposalTargetSchema, status: MemoryProposalStatusSchema })
export type MemoryProposalPayload = z.infer<typeof MemoryProposalPayloadSchema>

export const MemoryConsolidatedPayloadSchema = z.object({
  extracted: z.number(),
  promoted: z.number(),
  proposed: z.number(),
  skipped: z.string().optional(),
  model: z.string().optional(),
  tokens: z.number().optional(),
  usd: z.number().optional(),
})
export type MemoryConsolidatedPayload = z.infer<typeof MemoryConsolidatedPayloadSchema>

export const MemoryRecommendationPayloadSchema = z.object({
  id: z.string(),
  category: z.literal('routine'),
  habitId: z.string(),
  text: z.string(),
  cwd: z.string(),
})
export type MemoryRecommendationPayload = z.infer<typeof MemoryRecommendationPayloadSchema>

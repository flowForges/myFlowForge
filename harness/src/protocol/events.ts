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

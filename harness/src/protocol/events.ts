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

export const TurnUsagePayloadSchema = z.object({
  turnId: z.string(),
  input: z.number(),
  output: z.number(),
  cacheRead: z.number().optional(),
  cacheWrite: z.number().optional(),
})
export type TurnUsagePayload = z.infer<typeof TurnUsagePayloadSchema>

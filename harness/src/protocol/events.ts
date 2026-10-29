import { z } from 'zod'

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

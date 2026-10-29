import { z } from 'zod'
import { KernelEventSchema } from './events'

// JSON-RPC 错误码
export const ERR_DRAINING = -32001
export const ERR_UNAUTHORIZED = -32002
export const ERR_BUSY = -32003

const Ok = z.object({ ok: z.boolean() })
const Empty = z.object({})

export const StatusResultSchema = z.object({
  state: z.enum(['starting', 'running', 'draining']),
  uptimeMs: z.number(),
  rssMb: z.number(),
  version: z.string(),
  plugins: z.array(
    z.object({
      id: z.string(),
      state: z.enum(['active', 'failed', 'disabled']),
      error: z.string().optional(),
    }),
  ),
})
export type StatusResult = z.infer<typeof StatusResultSchema>

export const SnapshotResultSchema = z.object({
  status: StatusResultSchema,
  sessions: z.array(z.object({ id: z.string(), title: z.string(), updatedAt: z.number() })),
  lastSeq: z.number(),
})
export type SnapshotResult = z.infer<typeof SnapshotResultSchema>

export const ControlStatusSchema = z.object({
  state: z.enum(['starting', 'running', 'restarting', 'tripped', 'stopping']),
  workerPid: z.number().optional(),
  restarts: z.number(),
  trippedReason: z.enum(['crash-loop', 'oom']).optional(),
  version: z.string(),
  protocolVersion: z.number(),
})
export type ControlStatus = z.infer<typeof ControlStatusSchema>

export const WorkerMethods = {
  auth: { params: z.object({ token: z.string() }), result: Ok },
  hello: {
    params: z.object({ clientVersion: z.string(), protocolVersion: z.number() }),
    result: z.object({ version: z.string(), protocolVersion: z.number(), compatible: z.boolean() }),
  },
  status: { params: Empty, result: StatusResultSchema },
  snapshot: { params: Empty, result: SnapshotResultSchema },
  'events.subscribe': {
    params: z.object({ after: z.number() }),
    result: z.union([z.object({ ok: z.literal(true) }), z.object({ reset: z.literal(true), lastSeq: z.number() })]),
  },
  'events.tail': {
    params: z.object({ limit: z.number() }),
    result: z.object({ events: z.array(KernelEventSchema) }),
  },
  'session.create': {
    params: z.object({ commandId: z.string(), title: z.string().optional() }),
    result: z.object({ sessionId: z.string() }),
  },
  'session.prompt': {
    params: z.object({ commandId: z.string(), sessionId: z.string(), text: z.string() }),
    result: z.object({ accepted: z.boolean(), turnId: z.string() }),
  },
  'session.cancel': {
    params: z.object({ commandId: z.string(), sessionId: z.string() }),
    result: Ok,
  },
} as const

export const ControlMethods = {
  auth: { params: z.object({ token: z.string() }), result: Ok },
  status: { params: Empty, result: ControlStatusSchema },
  shutdown: { params: Empty, result: Ok },
  restart: { params: Empty, result: Ok },
  resetTrip: { params: Empty, result: Ok },
  autostart: {
    params: z.object({
      on: z.boolean(),
      spec: z.object({ execPath: z.string(), daemonJs: z.string() }),
    }),
    result: z.object({ ok: z.boolean(), errors: z.array(z.string()) }),
  },
} as const

export type WorkerMethodName = keyof typeof WorkerMethods
export type ControlMethodName = keyof typeof ControlMethods
export type WorkerParams<M extends WorkerMethodName> = z.infer<(typeof WorkerMethods)[M]['params']>
export type WorkerResult<M extends WorkerMethodName> = z.infer<(typeof WorkerMethods)[M]['result']>
export type ControlParams<M extends ControlMethodName> = z.infer<(typeof ControlMethods)[M]['params']>
export type ControlResult<M extends ControlMethodName> = z.infer<(typeof ControlMethods)[M]['result']>

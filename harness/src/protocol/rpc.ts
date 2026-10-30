import { z } from 'zod'
import { KernelEventSchema } from './events'
import {
  AccountProtocolSchema,
  AccountViewSchema,
  CatalogViewSchema,
  ModelErrorViewSchema,
  ModelRefSchema,
  QuotaSchema,
  SecretsBackendSchema,
} from './models'

// JSON-RPC 错误码
export const ERR_DRAINING = -32001
export const ERR_UNAUTHORIZED = -32002
export const ERR_BUSY = -32003

const Ok = z.object({ ok: z.boolean() })
const Empty = z.object({})

// 传输层挑战应答(见 auth.ts);两个口都一样,由 rpcServer 自己处理
const AuthMethods = {
  'auth.challenge': {
    params: z.object({ clientNonce: z.string() }),
    result: z.object({ serverNonce: z.string(), proof: z.string() }),
  },
  'auth.verify': { params: z.object({ proof: z.string() }), result: Ok },
} as const

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
  secretsBackend: SecretsBackendSchema.optional(),
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
  pid: z.number().optional(), // 监管进程 pid(控制口 status 填)
  workerPid: z.number().optional(),
  restarts: z.number(),
  trippedReason: z.enum(['crash-loop', 'oom']).optional(),
  version: z.string(),
  protocolVersion: z.number(),
})
export type ControlStatus = z.infer<typeof ControlStatusSchema>

export const WorkerMethods = {
  ...AuthMethods,
  hello: {
    params: z.object({ clientVersion: z.string(), protocolVersion: z.number() }),
    result: z.object({ version: z.string(), protocolVersion: z.number(), compatible: z.boolean() }),
  },
  status: { params: Empty, result: StatusResultSchema },
  snapshot: { params: Empty, result: SnapshotResultSchema },
  'events.subscribe': {
    params: z.object({ after: z.number().int().nonnegative() }),
    result: z.union([z.object({ ok: z.literal(true) }), z.object({ reset: z.literal(true), lastSeq: z.number() })]),
  },
  'events.tail': {
    params: z.object({ limit: z.number().int().min(1).max(1000) }),
    result: z.object({ events: z.array(KernelEventSchema) }),
  },
  'session.create': {
    params: z.object({ commandId: z.string(), title: z.string().optional(), model: ModelRefSchema.optional() }),
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
  // 以下由插件经 ctx.rpc.register 提供
  'models.catalog': { params: Empty, result: CatalogViewSchema },
  'models.accounts': {
    params: Empty,
    result: z.object({ accounts: z.array(AccountViewSchema), secretsBackend: SecretsBackendSchema }),
  },
  'models.addAccount': {
    params: z.object({
      commandId: z.string(),
      presetId: z.string(),
      label: z.string().optional(),
      apiKey: z.string().optional(),
      baseUrl: z.string().optional(),
      protocol: AccountProtocolSchema.optional(),
      restrictionAck: z.boolean().optional(),
    }),
    result: AccountViewSchema,
  },
  'models.removeAccount': {
    params: z.object({ commandId: z.string().optional(), accountId: z.string() }),
    result: Ok,
  },
  'models.testAccount': {
    params: z.object({ commandId: z.string().optional(), accountId: z.string() }),
    result: z.object({ ok: z.boolean(), error: ModelErrorViewSchema.optional() }),
  },
  'models.setDefault': { params: ModelRefSchema, result: z.object({ ok: z.literal(true) }) },
  'models.quota': { params: z.object({ accountId: z.string() }), result: QuotaSchema.nullable() },
  'auth.chatgpt.begin': { params: Empty, result: z.object({ flowId: z.string(), authUrl: z.string() }) },
  'auth.chatgpt.cancel': { params: z.object({ flowId: z.string() }), result: Ok },
} as const

export const ControlMethods = {
  ...AuthMethods,
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

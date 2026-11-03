import { z } from 'zod'
import { KernelEventSchema, MemoryConsolidatedPayloadSchema, MemoryProposalStatusSchema, MemoryProposalTargetSchema } from './events'
import {
  AccountProtocolSchema,
  AccountViewSchema,
  CatalogViewSchema,
  ModelErrorViewSchema,
  ModelRefSchema,
  QuotaSchema,
  SecretsBackendSchema,
} from './models'
import {
  ApprovalModeSchema,
  ExecutorChangesSourceSchema,
  ExecutorIsolationSchema,
  FileChangeSchema,
  SessionAudienceSchema,
  SessionOriginSchema,
  ToolsetSchema,
} from './tools'

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

// 05:沙箱级别(spec §7);Missing 是稳定代码,界面直接显示
export const SandboxMissingSchema = z.enum(['platform', 'sandbox-exec', 'bwrap', 'userns', 'netns', 'proxy', 'loopback', 'disabled'])
export type SandboxMissing = z.infer<typeof SandboxMissingSchema>
export const SandboxStatusSchema = z.object({
  level: z.enum(['full', 'partial', 'none']),
  missing: z.array(SandboxMissingSchema),
  autoDegraded: z.boolean(),
})
export type SandboxStatus = z.infer<typeof SandboxStatusSchema>

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
  // 05:旧后台没有该字段
  sandbox: SandboxStatusSchema.optional(),
  // 06:db/ 或 events.sqlite 收不紧(文件系统没有权限位),事件日志里的核心记忆别的用户可能读得到。正常时没有该字段
  dbUnprotected: z.literal(true).optional(),
})
export type StatusResult = z.infer<typeof StatusResultSchema>

export const SnapshotResultSchema = z.object({
  status: StatusResultSchema,
  sessions: z.array(z.object({ id: z.string(), title: z.string(), updatedAt: z.number() })),
  lastSeq: z.number(),
})
export type SnapshotResult = z.infer<typeof SnapshotResultSchema>

// 05:权限配置段(spec §4、§6)
export const RuleSpecSchema = z.object({
  effect: z.enum(['deny', 'ask', 'allow']),
  rule: z.string(),
  match: z.array(z.string()).optional(),
  noMatch: z.array(z.string()).optional(),
})
export const RuleErrorSchema = z.object({
  index: z.number(),
  rule: z.string(),
  reason: z.enum(['syntax', 'subject', 'pattern', 'test_failed', 'network']),
  case: z.string().optional(),
})
export const PermissionsConfigSchema = z.object({
  rules: z.array(RuleSpecSchema),
  network: z.object({ allow: z.array(z.string()) }),
  sandbox: z.object({ enabled: z.boolean(), allowLoopback: z.boolean() }),
  allowUnsandboxedAuto: z.boolean(),
})
export type PermissionsConfig = z.infer<typeof PermissionsConfigSchema>

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

// 04:执行器探测结果(spec §13);missing 是稳定代码,含 unsupported、codex_selftest、codex_network 等
export const ExecutorListResultSchema = z.object({
  executors: z.array(
    z.object({
      id: z.string(),
      installed: z.boolean(),
      version: z.string().optional(),
      auth: z.enum(['ok', 'missing', 'unknown']),
      isolation: ExecutorIsolationSchema,
      missing: z.array(z.string()),
    }),
  ),
})
export type ExecutorListResult = z.infer<typeof ExecutorListResultSchema>

// 06:记忆(spec §16)。路径不来自调用方拼接:只有这三种形状
export const MemoryFileSchema = z.union([z.literal('USER.md'), z.literal('MEMORY.md'), z.string().regex(/^topics\/[a-z0-9-]{1,40}\.md$/)])
export type MemoryFile = z.infer<typeof MemoryFileSchema>

export const MemoryLayerSchema = z.enum(['user', 'memory', 'topic', 'diary', 'session', 'raw'])
export type MemoryLayer = z.infer<typeof MemoryLayerSchema>

export const MemoryItemSchema = z.object({
  id: z.string(),
  layer: MemoryLayerSchema,
  text: z.string(),
  source: z.string().optional(),
  scope: z.string().optional(),
  file: z.string().optional(),
  sessionId: z.string().optional(),
  ts: z.number().optional(),
  flags: z.array(z.string()).optional(),
})
export type MemoryItem = z.infer<typeof MemoryItemSchema>

export const MemoryChangeSchema = z.object({
  ts: z.number(),
  id: z.string(),
  file: z.string().optional(),
  op: z.string(),
  before: z.string().nullable().optional(),
  after: z.string().nullable().optional(),
  source: z.string(),
})
export type MemoryChange = z.infer<typeof MemoryChangeSchema>

export const MemoryProposalSchema = z.object({
  id: z.string(),
  target: MemoryProposalTargetSchema,
  op: z.enum(['add', 'replace']),
  text: z.string(),
  replaces: z.string().optional(),
  evidence: z.array(z.string()),
  source: z.enum(['extract', 'model']),
  flags: z.array(z.string()),
  status: MemoryProposalStatusSchema,
  createdAt: z.number(),
  decidedAt: z.number().optional(),
})
export type MemoryProposal = z.infer<typeof MemoryProposalSchema>

export const MemoryHabitSchema = z.object({
  id: z.string(),
  kind: z.literal('routine'),
  weekday: z.number(),
  hour: z.number(),
  cwd: z.string(),
  status: z.enum(['detected', 'confirmed', 'dismissed']),
})
export type MemoryHabit = z.infer<typeof MemoryHabitSchema>

export const MemoryHealthSchema = z.object({
  dbBytes: z.number(),
  rawRows: z.number(),
  noteRows: z.number(),
  cursorLag: z.number(),
  pendingProposals: z.number(),
  lastConsolidation: z.string().optional(),
  // 预算相关字段由后台任务(Task 8)提供
  budget: z.object({ tokens: z.number(), usd: z.number(), tokensLimit: z.number(), usdLimit: z.number() }).optional(),
  backgroundModel: ModelRefSchema.optional(),
  /** 稳定代码,如 db_recovered、file_over_cap:USER.md */
  problems: z.array(z.string()),
})
export type MemoryHealth = z.infer<typeof MemoryHealthSchema>

const MemoryItems = z.object({ items: z.array(MemoryItemSchema) })

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
    params: z.object({
      commandId: z.string(),
      title: z.string().optional(),
      model: ModelRefSchema.optional(),
      cwd: z.string().optional(),
      approvalMode: ApprovalModeSchema.optional(),
      toolset: ToolsetSchema.optional(),
      origin: SessionOriginSchema.optional(),
      audience: SessionAudienceSchema.optional(),
    }),
    result: z.object({ sessionId: z.string() }),
  },
  'session.prompt': {
    params: z.object({ commandId: z.string(), sessionId: z.string(), text: z.string() }),
    // followUp:消息被挂起的那一轮收下,turnId 是那一轮
    result: z.object({ accepted: z.boolean(), turnId: z.string(), followUp: z.boolean().optional() }),
  },
  'session.cancel': {
    params: z.object({ commandId: z.string(), sessionId: z.string() }),
    result: Ok,
  },
  'approval.respond': {
    params: z.object({ approvalId: z.string(), decision: z.enum(['allow', 'allow_session', 'deny']) }),
    result: Ok,
  },
  'permissions.get': {
    params: z.object({ sessionId: z.string().optional() }),
    result: z.object({
      config: PermissionsConfigSchema,
      defaults: z.array(z.string()),
      errors: z.array(RuleErrorSchema),
      sandbox: SandboxStatusSchema,
    }),
  },
  // config 宽松收下,由内核严格校验(无效 → -32602 invalid rules + RuleError[])
  'permissions.set': { params: z.object({ commandId: z.string(), config: z.unknown() }), result: Ok },
  // 以下由插件经 ctx.rpc.register 提供
  'turn.rollback': {
    params: z.object({ commandId: z.string(), sessionId: z.string(), turnId: z.string() }),
    // skipped:写不回的子模块路径(不算进 files)
    result: z.object({ ok: z.literal(true), files: z.number(), skipped: z.array(z.string()).optional() }),
  },
  'turn.changes': {
    params: z.object({ sessionId: z.string(), turnId: z.string() }),
    result: z.object({ files: z.array(FileChangeSchema) }),
  },
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
  'executor.list': { params: Empty, result: ExecutorListResultSchema },
  'executor.refresh': { params: z.object({ commandId: z.string().optional() }), result: ExecutorListResultSchema },
  'executor.cancel': { params: z.object({ commandId: z.string(), sessionId: z.string(), runId: z.string() }), result: Ok },
  'executor.changes': {
    params: z.object({ sessionId: z.string(), runId: z.string() }),
    result: z.object({ files: z.array(FileChangeSchema), source: ExecutorChangesSourceSchema, concurrent: z.boolean().optional() }),
  },
  'executor.worktree.discard': { params: z.object({ commandId: z.string(), sessionId: z.string(), runId: z.string() }), result: Ok },
  'memory.list': { params: z.object({ layer: MemoryLayerSchema.optional(), limit: z.number().int().min(1).optional(), before: z.number().optional() }), result: MemoryItems },
  'memory.get': { params: z.object({ id: z.string() }), result: MemoryItemSchema.extend({ evidence: z.array(z.string()).optional() }) },
  'memory.search': {
    params: z.object({ query: z.string().min(1), layer: z.enum(['notes', 'raw', 'all']).optional(), limit: z.number().int().min(1).optional() }),
    result: MemoryItems,
  },
  'memory.update': { params: z.object({ commandId: z.string(), id: z.string(), text: z.string() }), result: z.object({ ok: z.boolean(), masked: z.number() }) },
  // sources:用户自己的原话,还留在对话记录里(08 列给用户,逐条删)
  'memory.delete': { params: z.object({ commandId: z.string(), id: z.string() }), result: z.object({ ok: z.boolean(), redacted: z.number(), sources: z.array(z.string()) }) },
  'memory.file.get': { params: z.object({ file: MemoryFileSchema }), result: z.object({ content: z.string(), hash: z.string(), cap: z.number() }) },
  'memory.file.set': {
    params: z.object({ commandId: z.string(), file: MemoryFileSchema, content: z.string(), expectedHash: z.string() }),
    result: z.object({ ok: z.boolean(), hash: z.string(), masked: z.number() }),
  },
  'memory.changes': { params: z.object({ limit: z.number().int().min(1).optional() }), result: z.object({ items: z.array(MemoryChangeSchema) }) },
  'memory.health': { params: Empty, result: MemoryHealthSchema },
  'memory.proposals.list': { params: z.object({ status: MemoryProposalStatusSchema.optional() }), result: z.object({ items: z.array(MemoryProposalSchema) }) },
  'memory.proposals.decide': { params: z.object({ commandId: z.string(), id: z.string(), decision: z.enum(['approve', 'reject']), text: z.string().optional() }), result: Ok },
  'memory.consolidate': {
    params: z.object({ commandId: z.string() }),
    result: MemoryConsolidatedPayloadSchema,
  },
  'memory.habits.list': { params: Empty, result: z.object({ items: z.array(MemoryHabitSchema) }) },
  'memory.habits.decide': { params: z.object({ commandId: z.string(), id: z.string(), decision: z.enum(['confirmed', 'dismissed']) }), result: Ok },
  'memory.recommendations.set': { params: z.object({ commandId: z.string(), routine: z.boolean() }), result: Ok },
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

import { z } from 'zod'
import { ChannelStateSchema, KernelEventSchema, MemoryConsolidatedPayloadSchema, MemoryProposalStatusSchema, MemoryProposalTargetSchema } from './events'
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
  GrantsSchema,
  McpReasonSchema,
  McpServerNameSchema,
  McpStateSchema,
  PluginConsentSchema,
  PluginFormatSchema,
  PluginIdSchema,
  PluginInstallStateSchema,
  PluginSettingKeySchema,
  PluginSourceParamSchema,
  PluginSourceSchema,
} from './plugins'
import {
  ApprovalModeSchema,
  ExecutorChangesSourceSchema,
  ExecutorIsolationSchema,
  FileChangeSchema,
  FileDiffSchema,
  MergeResultSchema,
  RunRowSchema,
  SessionAudienceSchema,
  SessionOriginSchema,
  ToolsetSchema,
} from './tools'

// JSON-RPC 错误码
export const ERR_DRAINING = -32001
export const ERR_UNAUTHORIZED = -32002
export const ERR_BUSY = -32003
// 08 §5.2:app 宿主放进信封的码,工作进程从不发
export const ERR_APP_DISABLED = -32000
export const ERR_APP_TIMEOUT = -32010
export const ERR_APP_GONE = -32011

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
      // 09:开发插件,什么都能做。08 要一直显示
      trust: z.literal('dev').optional(),
    }),
  ),
  // 09:稳定代码,如 dev_crashed。正常时没有该字段
  problems: z.array(z.string()).optional(),
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

// 08 §4.1:会话列表的一行。approvalMode 是收窄之后的;open 和 pendingApprovals 来自内核内存
export const SessionSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  origin: SessionOriginSchema,
  audience: SessionAudienceSchema,
  cwd: z.string().optional(),
  model: ModelRefSchema.optional(),
  approvalMode: ApprovalModeSchema,
  toolset: ToolsetSchema.optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  open: z.object({ turnId: z.string(), parked: z.boolean() }).optional(),
  pendingApprovals: z.number(),
})
export type SessionSummary = z.infer<typeof SessionSummarySchema>

/** session.state 的 open:approvalIds 是 Approvals 里属于这一轮的 */
export const SessionOpenStateSchema = z.object({ turnId: z.string(), parked: z.boolean(), approvalIds: z.array(z.string()) })

const EventPage = z.object({ events: z.array(KernelEventSchema), hasMore: z.boolean() })

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

/** 能点名的条目:笔记 n_、手写行 h_、原始层 r_<seq>。别的形状进不来,空串和普通单词都不算 */
export const MEMORY_ID = /^(?:[nh]_[A-Za-z0-9_-]{1,62}|r_[1-9]\d{0,15})$/
const MemoryIdSchema = z.string().regex(MEMORY_ID)

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
  /**
   * 稳定代码,如 db_recovered、delete_pending:<id>。file_over_cap:<文件> 后面跟着细节,要按前缀比。
   * 插件激活失败(plugin.failed)时这个方法不存在:-32601,调用方看 status 的 plugins
   */
  problems: z.array(z.string()),
})
export type MemoryHealth = z.infer<typeof MemoryHealthSchema>

const MemoryItems = z.object({ items: z.array(MemoryItemSchema) })

// 07:Telegram 渠道(spec §13)。账号和聊天的 id 都是字符串
const TelegramBotSchema = z.object({ id: z.number(), username: z.string() })

export const TelegramProjectSchema = z.object({ name: z.string(), path: z.string(), auto: z.boolean() })
export type TelegramProject = z.infer<typeof TelegramProjectSchema>

export const TelegramConfigSchema = z.object({ enabled: z.boolean(), staleMinutes: z.number(), projects: z.array(TelegramProjectSchema) })
export type TelegramConfig = z.infer<typeof TelegramConfigSchema>

export const TelegramStatusSchema = z.object({
  state: ChannelStateSchema,
  reason: z.string().optional(),
  enabled: z.boolean(),
  tokenSet: z.boolean(),
  bot: TelegramBotSchema.optional(),
  secretsBackend: SecretsBackendSchema,
  /** 只说是哪一类,不带 URL */
  proxy: z.enum(['none', 'env', 'socks']),
  lastOkAt: z.number().optional(),
  paired: z.array(z.object({ accountId: z.string(), name: z.string(), pairedAt: z.number() })),
  pairing: z.object({ active: z.boolean(), expiresAt: z.number().optional() }),
  dropped: z.object({ unpaired: z.number(), stale: z.number(), group: z.number(), attachment: z.number(), badUpdate: z.number() }),
  undelivered: z.number(),
  problems: z.array(z.string()),
})
export type TelegramStatus = z.infer<typeof TelegramStatusSchema>

export const TelegramChatsSchema = z.object({
  chats: z.array(z.object({ chatId: z.string(), accountId: z.string(), sessionId: z.string(), project: z.string().optional(), model: ModelRefSchema.optional(), queued: z.number(), running: z.boolean() })),
  worktrees: z.array(z.object({ id: z.string(), project: z.string(), path: z.string(), sessionIds: z.array(z.string()), createdAt: z.number(), usedByChat: z.string().optional(), bytes: z.number().optional(), merged: z.boolean().optional() })),
})
export type TelegramChats = z.infer<typeof TelegramChatsSchema>

// 09:插件(spec §14)
export const PluginListResultSchema = z.object({
  plugins: z.array(z.object({
    id: z.string(),
    version: z.string(),
    format: PluginFormatSchema,
    enabled: z.boolean(),
    state: z.string(),
    problems: z.array(z.string()),
    source: PluginSourceSchema,
    integrity: z.string(),
    installedAt: z.number(),
  })),
  dev: z.array(z.object({ id: z.string(), hash: z.string(), trustedAt: z.number() })),
  problems: z.array(z.string()),
})
export type PluginListResult = z.infer<typeof PluginListResultSchema>

export const PluginDetailSchema = z.object({
  consent: PluginConsentSchema,
  grants: GrantsSchema,
  /** value 只有不敏感的才有 */
  settings: z.array(z.object({ key: z.string(), set: z.boolean(), sensitive: z.boolean(), value: z.string().optional() })),
  servers: z.array(z.object({ name: McpServerNameSchema, state: McpStateSchema, reason: McpReasonSchema.optional() })),
})
export type PluginDetail = z.infer<typeof PluginDetailSchema>

export const PluginInstallStatusSchema = z.object({ state: PluginInstallStateSchema, error: z.string().optional(), /** 违规的相对路径,已清理,第三方文字:只给同意页,不进事件和模型 */ path: z.string().optional(), consent: PluginConsentSchema.optional(), consentHash: z.string().optional() })
export type PluginInstallStatus = z.infer<typeof PluginInstallStatusSchema>

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
      /** origin im:worktree 从哪个检出建的。沙箱和权限门不让这个会话读那里(07 §8.1) */
      projectTop: z.string().optional(),
    }),
    result: z.object({ sessionId: z.string() }),
  },
  'session.prompt': {
    // external:转发或经内联机器人来的,不是用户本人的话(07 §12.1)
    params: z.object({ commandId: z.string(), sessionId: z.string(), text: z.string(), external: z.boolean().optional() }),
    // followUp:消息被挂起的那一轮收下,turnId 是那一轮
    result: z.object({ accepted: z.boolean(), turnId: z.string(), followUp: z.boolean().optional() }),
  },
  'session.cancel': {
    params: z.object({ commandId: z.string(), sessionId: z.string() }),
    result: Ok,
  },
  // 08 §4.1–4.3。list / state / events 只读,排空时照常回答;未知或已删的会话 -32602 unknown session
  'session.list': { params: Empty, result: z.object({ sessions: z.array(SessionSummarySchema) }) },
  'session.state': {
    params: z.object({ sessionId: z.string(), limit: z.number().int().min(1).max(1000).optional() }),
    // events 经 toWire,seq 升序;有开着的轮时至少从它的 message.user 起(最多 5000 条)。lastSeq 是整个日志的,实时事件 seq <= 它的丢掉
    result: EventPage.extend({ session: SessionSummarySchema, lastSeq: z.number(), open: SessionOpenStateSchema.optional() }),
  },
  'session.events': {
    params: z.object({ sessionId: z.string(), beforeSeq: z.number().int(), limit: z.number().int().min(1).max(1000) }),
    result: EventPage,
  },
  // title 去控制字符和首尾空白后 1..120 字,否则 -32602(内核查,这里只限长度)
  'session.rename': { params: z.object({ commandId: z.string(), sessionId: z.string(), title: z.string().max(4096) }), result: Ok },
  // memory-default 注册。有改动没合并的保留 worktree、又没带 discardUnmerged → -32602,data { reason:'unmerged', runs }
  'session.delete': {
    params: z.object({ commandId: z.string(), sessionId: z.string(), discardUnmerged: z.boolean().optional() }),
    result: z.object({ ok: z.boolean(), redacted: z.number(), notes: z.array(z.string()) }),
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
  // 08 §4.4:path 必须在这一轮的改动清单里,否则 -32602
  'turn.diff': { params: z.object({ sessionId: z.string(), turnId: z.string(), path: z.string() }), result: FileDiffSchema },
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
      // 08 §4.7:只对模型清单为空的预设;restriction 只对自定义预设,别的带了 → -32602(插件查)
      modelIds: z.array(z.string().regex(/^[A-Za-z0-9._:/-]{1,128}$/)).max(50).optional(),
      restriction: z.enum(['coding-tools-only', 'none']).optional(),
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
  // 08 §4.4、§4.5。diff 的 path 是 executor.changes 回的(redact 过的)那个
  'executor.diff': { params: z.object({ sessionId: z.string(), runId: z.string(), path: z.string() }), result: FileDiffSchema },
  'executor.runs': { params: z.object({ limit: z.number().int().min(1).max(200).optional() }), result: z.object({ runs: z.array(RunRowSchema) }) },
  // 拒绝:-32602,data 是 MergeRefusalSchema;运行没结束 -32003
  'executor.worktree.merge': { params: z.object({ commandId: z.string(), sessionId: z.string(), runId: z.string() }), result: MergeResultSchema },
  'memory.list': { params: z.object({ layer: MemoryLayerSchema.optional(), limit: z.number().int().min(1).optional(), before: z.number().optional() }), result: MemoryItems },
  'memory.get': { params: z.object({ id: MemoryIdSchema }), result: MemoryItemSchema.extend({ evidence: z.array(z.string()).optional() }) },
  'memory.search': {
    params: z.object({ query: z.string().min(1), layer: z.enum(['notes', 'raw', 'all']).optional(), limit: z.number().int().min(1).optional() }),
    result: MemoryItems,
  },
  'memory.update': { params: z.object({ commandId: z.string(), id: MemoryIdSchema, text: z.string() }), result: z.object({ ok: z.boolean(), masked: z.number() }) },
  // sources:用户自己的原话,还留在对话记录里(08 列给用户,逐条删);r_ 派生的草稿行、候选、提议(已一起删)和还引用它的核心条目(n_,可删)
  'memory.delete': { params: z.object({ commandId: z.string(), id: MemoryIdSchema }), result: z.object({ ok: z.boolean(), redacted: z.number(), sources: z.array(z.string()) }) },
  // 08 §4.3:一次 VACUUM。gone:查不到的 id,就是已经没了,不报错
  'memory.deleteMany': {
    params: z.object({ commandId: z.string(), ids: z.array(MemoryIdSchema).min(1).max(200) }),
    result: z.object({ ok: z.boolean(), redacted: z.number(), sources: z.array(z.string()), gone: z.array(z.string()) }),
  },
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
  // 07。setToken、clearToken、pairing.* 故意没有 commandId:kernel.handle 给任何带这个名字的参数写回执,配对码就进库了。
  // token 这里只限长度,形状由处理者查:zod 的 issue 不能有机会带上它
  'channel.telegram.status': { params: Empty, result: TelegramStatusSchema },
  'channel.telegram.setToken': { params: z.object({ token: z.string().max(256) }), result: z.object({ ok: z.boolean(), bot: TelegramBotSchema }) },
  'channel.telegram.clearToken': { params: Empty, result: Ok },
  'channel.telegram.clearWebhook': { params: z.object({ commandId: z.string() }), result: Ok },
  'channel.telegram.pairing.begin': { params: Empty, result: z.object({ code: z.string(), expiresAt: z.number(), link: z.string().optional() }) },
  'channel.telegram.pairing.cancel': { params: Empty, result: Ok },
  'channel.telegram.unpair': { params: z.object({ commandId: z.string(), accountId: z.string() }), result: Ok },
  'channel.telegram.config.get': { params: Empty, result: TelegramConfigSchema },
  // config 宽松收下,由插件校验(项目路径要过 validateCwd)
  'channel.telegram.config.set': { params: z.object({ commandId: z.string(), config: z.unknown() }), result: Ok },
  'channel.telegram.chats': { params: Empty, result: TelegramChatsSchema },
  'channel.telegram.worktree.discard': { params: z.object({ commandId: z.string(), worktreeId: z.string() }), result: Ok },
  // 08 §4.4、§4.5:现拍快照对建 worktree 时记下的 base
  'channel.telegram.worktree.changes': { params: z.object({ worktreeId: z.string() }), result: z.object({ files: z.array(FileChangeSchema) }) },
  'channel.telegram.worktree.diff': { params: z.object({ worktreeId: z.string(), path: z.string() }), result: FileDiffSchema },
  'channel.telegram.worktree.merge': { params: z.object({ commandId: z.string(), worktreeId: z.string() }), result: MergeResultSchema },
  // 09。settings.*、install.prepare 故意没有 commandId:kernel.handle 给任何带这个名字的参数写回执,值就进库了。
  // value 这里只限长度:zod 的 issue 不能有机会带上它
  'plugins.list': { params: Empty, result: PluginListResultSchema },
  'plugins.get': { params: z.object({ id: PluginIdSchema }), result: PluginDetailSchema },
  'plugins.install.prepare': { params: z.object({ source: PluginSourceParamSchema }), result: z.object({ stagingId: z.string() }) },
  'plugins.upgrade.prepare': { params: z.object({ id: PluginIdSchema, ref: z.string().max(256).optional() }), result: z.object({ stagingId: z.string() }) },
  'plugins.install.status': { params: z.object({ stagingId: z.string().max(128) }), result: PluginInstallStatusSchema },
  'plugins.install.confirm': {
    params: z.object({ commandId: z.string(), stagingId: z.string().max(128), consentHash: z.string().max(128), grants: GrantsSchema, enable: z.boolean() }),
    result: z.object({ ok: z.boolean(), id: z.string() }),
  },
  'plugins.install.cancel': { params: z.object({ stagingId: z.string().max(128) }), result: Ok },
  'plugins.setEnabled': { params: z.object({ commandId: z.string(), id: PluginIdSchema, enabled: z.boolean() }), result: Ok },
  'plugins.uninstall': { params: z.object({ commandId: z.string(), id: PluginIdSchema }), result: Ok },
  // 记录丢了之后留下的代码、数据和列在坏记录里的凭据:只有这里能删
  'plugins.store.discard': { params: z.object({ commandId: z.string() }), result: Ok },
  'plugins.grants.set': { params: z.object({ commandId: z.string(), id: PluginIdSchema, grants: GrantsSchema }), result: Ok },
  'plugins.settings.set': { params: z.object({ id: PluginIdSchema, key: PluginSettingKeySchema, value: z.string().max(8192) }), result: Ok },
  'plugins.settings.clear': { params: z.object({ id: PluginIdSchema, key: PluginSettingKeySchema }), result: Ok },
  'plugins.commands': { params: Empty, result: z.object({ commands: z.array(z.object({ name: z.string(), plugin: z.string(), description: z.string(), argumentHint: z.string().optional() })) }) },
  'plugins.command.run': {
    params: z.object({ commandId: z.string(), sessionId: z.string(), name: z.string().max(256), args: z.string().max(8000) }),
    result: z.object({ accepted: z.boolean(), turnId: z.string(), followUp: z.boolean().optional() }),
  },
  'plugins.mcp.status': {
    params: z.object({ sessionId: z.string().optional() }),
    result: z.object({ servers: z.array(z.object({ plugin: z.string(), server: z.string(), sessionId: z.string(), state: McpStateSchema, reason: McpReasonSchema.optional(), pid: z.number().optional() })) }),
  },
  // 字面量确认:08 没法把它做成一个普通开关(§12)
  'plugins.dev.trust': {
    params: z.object({ path: z.string().min(1).max(4096), acknowledge: z.literal('runs_with_full_access') }),
    result: z.object({ ok: z.boolean(), id: z.string(), hash: z.string(), bytes: z.number(), main: z.string(), restartRequired: z.literal(true) }),
  },
  'plugins.dev.remove': { params: z.object({ id: PluginIdSchema }), result: z.object({ ok: z.boolean(), restartRequired: z.literal(true) }) },
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

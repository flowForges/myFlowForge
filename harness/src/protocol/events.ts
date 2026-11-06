import { z } from 'zod'
import { AccountViewSchema } from './models'
import { McpReasonSchema, McpStateSchema, PluginFormatSchema, PluginInstallStateSchema } from './plugins'

export const EVENT_TYPES = [
  'kernel.started',
  'kernel.stopping',
  'plugin.activated',
  'plugin.failed',
  'session.created',
  'session.approvalNarrowed',
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
  'channel.status',
  'channel.paired',
  'channel.unpaired',
  'channel.pairing.burned',
  'plugins.install.state',
  'plugins.installed',
  'plugins.upgraded',
  'plugins.enabled',
  'plugins.disabled',
  'plugins.uninstalled',
  'plugins.grants.updated',
  'plugins.integrity.failed',
  'plugins.injected',
  'plugins.mcp.status',
  'plugins.dev.trusted',
  'plugins.dev.loaded',
  'plugins.store.discarded',
  'session.renamed',
  'session.deleted',
  'executor.worktree.merged',
  'channel.worktree.merged',
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

/** session:整会话抹除(08 §4.3),这时 seqs 是空的:大会话会有几万条 */
export const EventsRedactedPayloadSchema = z.object({ by: z.string(), seqs: z.array(z.number()), session: z.string().optional() })
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

// 07:IM 渠道(spec §13)。都不带令牌、配对码、陌生人的文本。状态是稳定代码,界面直接显示
export const ChannelIdSchema = z.enum(['telegram'])
export type ChannelId = z.infer<typeof ChannelIdSchema>

export const ChannelStateSchema = z.enum(['starting', 'online', 'reconnecting', 'unauthorized', 'conflict', 'no_token', 'disabled', 'secrets_unavailable'])
export type ChannelState = z.infer<typeof ChannelStateSchema>

export const ChannelStatusPayloadSchema = z.object({ channel: ChannelIdSchema, state: ChannelStateSchema, reason: z.string().optional() })
export type ChannelStatusPayload = z.infer<typeof ChannelStatusPayloadSchema>

/** accountId 是字符串:渠道中立,Telegram 的数字 id 转成十进制 */
export const ChannelPairedPayloadSchema = z.object({ channel: ChannelIdSchema, accountId: z.string(), name: z.string() })
export type ChannelPairedPayload = z.infer<typeof ChannelPairedPayloadSchema>

export const ChannelUnpairedPayloadSchema = z.object({ channel: ChannelIdSchema, accountId: z.string(), by: z.enum(['app', 'im']) })
export type ChannelUnpairedPayload = z.infer<typeof ChannelUnpairedPayloadSchema>

export const ChannelPairingBurnedPayloadSchema = z.object({ channel: ChannelIdSchema })
export type ChannelPairingBurnedPayload = z.infer<typeof ChannelPairingBurnedPayloadSchema>

// 09:插件(spec §14)。都不带配置值、环境值、MCP 的 stderr
export const PluginsInstallStatePayloadSchema = z.object({ stagingId: z.string(), state: PluginInstallStateSchema, error: z.string().optional() })
export type PluginsInstallStatePayload = z.infer<typeof PluginsInstallStatePayloadSchema>

/** plugins.installed、plugins.upgraded */
export const PluginInstalledPayloadSchema = z.object({ id: z.string(), version: z.string(), integrity: z.string(), format: PluginFormatSchema, sourceKind: z.enum(['path', 'git']) })
export type PluginInstalledPayload = z.infer<typeof PluginInstalledPayloadSchema>

/** plugins.enabled、disabled、uninstalled、grants.updated、integrity.failed */
export const PluginIdPayloadSchema = z.object({ id: z.string() })
export type PluginIdPayload = z.infer<typeof PluginIdPayloadSchema>

/** 带 sessionId。日志里第一个算,所在的轮回滚了也算(M8、M9) */
export const PluginsInjectedPayloadSchema = z.object({ turnId: z.string(), text: z.string(), skill: z.boolean(), mcp: z.boolean() })
export type PluginsInjectedPayload = z.infer<typeof PluginsInjectedPayloadSchema>

/** 带 sessionId,状态变化才写。state、reason 是稳定代码 */
export const PluginsMcpStatusPayloadSchema = z.object({ plugin: z.string(), server: z.string(), state: McpStateSchema, reason: McpReasonSchema.optional() })
export type PluginsMcpStatusPayload = z.infer<typeof PluginsMcpStatusPayloadSchema>

/** plugins.dev.trusted、plugins.dev.loaded */
export const PluginDevPayloadSchema = z.object({ id: z.string(), hash: z.string() })
export type PluginDevPayload = z.infer<typeof PluginDevPayloadSchema>

// 08 §4.3、§4.5。都带 sessionId(channel.worktree.merged 除外:IM worktree 不属于一个会话)
export const SessionRenamedPayloadSchema = z.object({ title: z.string() })
export type SessionRenamedPayload = z.infer<typeof SessionRenamedPayloadSchema>

/** 墓碑:从这一条起会话不再列出、不再收消息;之后整会话抹除 */
export const SessionDeletedPayloadSchema = z.object({})
export type SessionDeletedPayload = z.infer<typeof SessionDeletedPayloadSchema>

export const ExecutorWorktreeMergedPayloadSchema = z.object({ runId: z.string(), files: z.number() })
export type ExecutorWorktreeMergedPayload = z.infer<typeof ExecutorWorktreeMergedPayloadSchema>

export const ChannelWorktreeMergedPayloadSchema = z.object({ worktreeId: z.string(), files: z.number() })
export type ChannelWorktreeMergedPayload = z.infer<typeof ChannelWorktreeMergedPayloadSchema>

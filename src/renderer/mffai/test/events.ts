// 渲染层测试的事件夹具:形状和协议的 schema 一致。每条都过 KernelEventSchema 和它的载荷 schema,
// 夹具写错了在这里就失败,不会让页面测试对着一个后台根本不会发的形状绿。
import { z } from 'zod'
import type { EventType, KernelEvent } from '@mffai/protocol'
import * as P from '@mffai/protocol/browser'

const turn = z.object({ turnId: z.string() })
const text = turn.extend({ step: z.number().optional(), text: z.string() })

/** 协议没有单独导出载荷 schema 的事件按内核写的样子补上(kernel.ts、pluginHost.ts) */
const PAYLOADS: Record<EventType, z.ZodType> = {
  'kernel.started': z.object({ version: z.string() }),
  'kernel.stopping': z.object({}),
  'plugin.activated': z.object({ id: z.string() }),
  'plugin.failed': z.object({ id: z.string(), error: z.string() }),
  'session.created': z.object({
    title: z.string().optional(), model: P.ModelRefSchema.optional(), cwd: z.string().optional(), repo: z.unknown().optional(),
    approvalMode: P.ApprovalModeSchema, toolset: P.ToolsetSchema.optional(), origin: P.SessionOriginSchema.optional(),
    audience: P.SessionAudienceSchema.optional(), projectTop: z.string().optional(),
  }),
  'session.approvalNarrowed': z.object({ approvalMode: P.ApprovalModeSchema }),
  'turn.started': turn,
  'message.user': turn.extend({ text: z.string(), followUp: z.boolean().optional(), external: z.boolean().optional() }),
  'message.assistant.delta': text,
  'message.assistant': text,
  'turn.ended': turn,
  'turn.failed': turn.extend({ reason: z.string(), message: z.string().optional() }),
  'account.updated': P.AccountUpdatedPayloadSchema,
  'message.reasoning.delta': P.ReasoningDeltaPayloadSchema.extend({ step: z.number().optional() }),
  'turn.usage': P.TurnUsagePayloadSchema.extend({ step: z.number().optional() }),
  'auth.chatgpt.ended': P.ChatgptEndedPayloadSchema,
  'tool.started': P.ToolStartedPayloadSchema,
  'tool.ended': P.ToolEndedPayloadSchema,
  'approval.requested': P.ApprovalRequestedPayloadSchema,
  'approval.resolved': P.ApprovalResolvedPayloadSchema,
  'turn.snapshot': P.TurnSnapshotPayloadSchema,
  'turn.rolledBack': P.TurnRolledBackPayloadSchema,
  'permissions.updated': P.PermissionsUpdatedPayloadSchema,
  'sandbox.netDenied': P.SandboxNetDeniedPayloadSchema,
  'executor.run.queued': P.ExecutorRunQueuedPayloadSchema,
  'executor.run.started': P.ExecutorRunStartedPayloadSchema,
  'executor.run.progress': P.ExecutorRunProgressPayloadSchema,
  'executor.run.ended': P.ExecutorRunEndedPayloadSchema,
  'executor.notice': P.ExecutorNoticePayloadSchema,
  'turn.parked': P.TurnParkedPayloadSchema,
  'turn.resumed': P.TurnResumedPayloadSchema,
  'memory.injected': P.MemoryInjectedPayloadSchema,
  'memory.checkpoint': P.MemoryCheckpointPayloadSchema,
  'context.rebuilt': P.ContextRebuiltPayloadSchema,
  'memory.deleted': P.MemoryDeletedPayloadSchema,
  'events.redacted': P.EventsRedactedPayloadSchema,
  'memory.updated': P.MemoryUpdatedPayloadSchema,
  'memory.proposal': P.MemoryProposalPayloadSchema,
  'memory.consolidated': P.MemoryConsolidatedPayloadSchema,
  'memory.recommendation': P.MemoryRecommendationPayloadSchema,
  'channel.status': P.ChannelStatusPayloadSchema,
  'channel.paired': P.ChannelPairedPayloadSchema,
  'channel.unpaired': P.ChannelUnpairedPayloadSchema,
  'channel.pairing.burned': P.ChannelPairingBurnedPayloadSchema,
  'plugins.install.state': P.PluginsInstallStatePayloadSchema,
  'plugins.installed': P.PluginInstalledPayloadSchema,
  'plugins.upgraded': P.PluginInstalledPayloadSchema,
  'plugins.enabled': P.PluginIdPayloadSchema,
  'plugins.disabled': P.PluginIdPayloadSchema,
  'plugins.uninstalled': P.PluginIdPayloadSchema,
  'plugins.grants.updated': P.PluginIdPayloadSchema,
  'plugins.integrity.failed': P.PluginIdPayloadSchema,
  'plugins.injected': P.PluginsInjectedPayloadSchema,
  'plugins.mcp.status': P.PluginsMcpStatusPayloadSchema,
  'plugins.dev.trusted': P.PluginDevPayloadSchema,
  'plugins.dev.loaded': P.PluginDevPayloadSchema,
  'plugins.store.discarded': z.object({}),
  'session.renamed': P.SessionRenamedPayloadSchema,
  'session.deleted': P.SessionDeletedPayloadSchema,
  'executor.worktree.merged': P.ExecutorWorktreeMergedPayloadSchema,
  'channel.worktree.merged': P.ChannelWorktreeMergedPayloadSchema,
}

let seq = 0
/** 每个测试文件可以把 seq 拨回去;默认从 1 递增 */
export function resetSeq(n = 0): void { seq = n }

/** 一条 KernelEvent。载荷不合 schema 就抛错 */
export function ev<T extends EventType>(type: T, payload: unknown, opts: { sessionId?: string; seq?: number; ts?: number } = {}): KernelEvent {
  const parsed = PAYLOADS[type].safeParse(payload)
  if (!parsed.success) throw new Error(`fixture ${type}: ${parsed.error.message}`)
  const s = opts.seq ?? ++seq
  if (s > seq) seq = s
  return P.KernelEventSchema.parse({ seq: s, ts: opts.ts ?? 1_700_000_000_000 + s, type, ...(opts.sessionId && { sessionId: opts.sessionId }), payload })
}

export const userMsg = (sessionId: string, turnId: string, t: string) => ev('message.user', { turnId, text: t }, { sessionId })
export const assistantMsg = (sessionId: string, turnId: string, t: string) => ev('message.assistant', { turnId, text: t }, { sessionId })
export const redacted = (p: { seqs?: number[]; session?: string }) => ev('events.redacted', { by: 'memory-default', seqs: p.seqs ?? [], ...(p.session && { session: p.session }) })

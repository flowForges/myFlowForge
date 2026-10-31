import { z } from 'zod'

// v3:工具调用、审批、快照相关的会话选项与事件载荷

export const ApprovalModeSchema = z.enum(['ask', 'auto'])
export type ApprovalMode = z.infer<typeof ApprovalModeSchema>

export const ToolsetSchema = z.enum(['patch', 'edit'])
export type Toolset = z.infer<typeof ToolsetSchema>

export const ToolStartedPayloadSchema = z.object({
  turnId: z.string(),
  callId: z.string(),
  name: z.string(),
  argsPreview: z.string(),
})
export type ToolStartedPayload = z.infer<typeof ToolStartedPayloadSchema>

/** 事件日志里是完整 content;推给客户端时由 wire 视图截断并加 truncated */
export const ToolEndedPayloadSchema = z.object({
  turnId: z.string(),
  callId: z.string(),
  name: z.string(),
  ok: z.boolean(),
  ms: z.number(),
  content: z.string(),
  isError: z.boolean().optional(),
  truncated: z.boolean().optional(),
})
export type ToolEndedPayload = z.infer<typeof ToolEndedPayloadSchema>

export const ApprovalRequestedPayloadSchema = z.object({
  approvalId: z.string(),
  turnId: z.string(),
  callId: z.string(),
  tool: z.string(),
  summary: z.string(),
})
export type ApprovalRequestedPayload = z.infer<typeof ApprovalRequestedPayloadSchema>

export const ApprovalResolvedPayloadSchema = z.object({
  approvalId: z.string(),
  decision: z.enum(['allow', 'deny']),
  by: z.enum(['user', 'session', 'timeout', 'cancel']),
})
export type ApprovalResolvedPayload = z.infer<typeof ApprovalResolvedPayloadSchema>

export const TurnSnapshotPayloadSchema = z.object({
  turnId: z.string(),
  phase: z.enum(['start', 'end']),
  ref: z.string().optional(),
  changed: z.number().optional(),
  reason: z.string().optional(),
})
export type TurnSnapshotPayload = z.infer<typeof TurnSnapshotPayloadSchema>

export const TurnRolledBackPayloadSchema = z.object({ turnId: z.string(), files: z.number(), skipped: z.array(z.string()).optional() })
export type TurnRolledBackPayload = z.infer<typeof TurnRolledBackPayloadSchema>

export const FileChangeSchema = z.object({ path: z.string(), status: z.enum(['A', 'M', 'D', 'T']) })
export type FileChange = z.infer<typeof FileChangeSchema>

/** message.assistant.parts:模型层 Part 去掉 image */
export const AssistantPartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('tool_call'), id: z.string(), name: z.string(), args: z.string() }),
  z.object({ type: z.literal('tool_result'), callId: z.string(), content: z.string(), isError: z.boolean().optional() }),
  // accountId / protocol / modelId:产出该 replay 的模型;重建历史时只回传给同一个
  z.object({
    type: z.literal('reasoning'),
    text: z.string().optional(),
    replay: z.unknown().optional(),
    accountId: z.string().optional(),
    protocol: z.string().optional(),
    modelId: z.string().optional(),
  }),
])
export type AssistantPart = z.infer<typeof AssistantPartSchema>

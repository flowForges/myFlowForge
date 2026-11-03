// 记忆服务的接口与配置(06 spec §4、§13);循环只经 memory 服务和 lib/memory,不 import 插件
import { z } from 'zod'
import type { KernelEvent } from '../../protocol/events'
import { ModelRefSchema, type ModelRef } from '../../protocol/models'

export interface ContextBlock {
  kind: 'session' | 'turn'
  text: string
  /** 这段文本用到的每一条记忆的 id */
  items: string[]
  coreVersion?: string
}

export interface MemoryService {
  /** 同步、不抛错;空数组 = 什么都不注入 */
  contextFor(req: { sessionId: string; turnId: string; text: string; events: KernelEvent[]; contextTokens: number }): ContextBlock[]
  /** 每步请求前调;只记数字,要不要后台算由插件定 */
  noteContext(req: { sessionId: string; ref: ModelRef; tokens: number; context: number }): void
}

export const MemoryConfigSchema = z.object({
  recall: z.boolean().default(true),
  backgroundModel: ModelRefSchema.optional(),
  tokensPerDay: z.number().int().min(0).default(400_000),
  usdPerDay: z.number().min(0).default(1),
  // prefault, not default: zod 4's .default({}) skips the inner defaults (measured on 4.4.3: {"n":{}})
  nightly: z.object({ enabled: z.boolean().default(true), hour: z.number().int().min(0).max(23).default(3) }).prefault({}),
  recommendations: z.object({ routine: z.boolean().default(false) }).prefault({}),
})
export type MemoryConfig = z.infer<typeof MemoryConfigSchema>

/**
 * 配置段写坏了退回默认值并告警。ctx.config 是激活时的快照:插件自己留一份当前值,updateConfig 之后更新
 */
export function parseMemoryConfig(raw: unknown, warn: (message: string) => void): MemoryConfig {
  const r = MemoryConfigSchema.safeParse(raw ?? {})
  if (r.success) return r.data
  warn('memory config is invalid, using defaults')
  return MemoryConfigSchema.parse({})
}

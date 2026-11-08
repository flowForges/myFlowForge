import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { z } from 'zod'
import { ModelEntrySchema, ModelRefSchema } from '../protocol/models'

// 账号元数据(密钥只在 SecretStore,这里没有任何密钥字段)
export const AccountConfigSchema = z.object({
  id: z.string().min(1),
  presetId: z.string().min(1),
  label: z.string(),
  baseUrl: z.string().optional(),
  protocol: z.enum(['openai-chat', 'openai-responses', 'anthropic', 'chatgpt']).optional(),
  restrictionAckAt: z.number().optional(),
  // 08 §4.7:只有自定义预设的账号有;其余预设看目录里的 restriction
  restriction: z.enum(['coding-tools-only', 'none']).optional(),
  models: z.array(ModelEntrySchema).optional(), // 手填清单 + 适配器列出的模型
  listedModelIds: z.array(z.string()).optional(), // models 里哪些 id 来自列模型(其余是手填)
})
export type AccountConfig = z.infer<typeof AccountConfigSchema>

export const ModelsConfigSchema = z.object({
  accounts: z.array(AccountConfigSchema).default([]),
  default: ModelRefSchema.optional(),
})
export type ModelsConfig = z.infer<typeof ModelsConfigSchema>

export const KernelConfigSchema = z.object({
  version: z.literal(1).default(1),
  plugins: z.object({ disabled: z.array(z.string()).default([]) }).default({ disabled: [] }),
  models: ModelsConfigSchema.default({ accounts: [] }),
  // 05 §6:宽松收下、原样保留,由 permissions.ts 单独解析 —— 规则写坏了也不能让整份配置被改名(会丢模型账号)
  permissions: z.unknown().optional(),
  // 04 §9.1:同样宽松收下,由 executor-cli 解析;写坏了退回默认值并告警
  executors: z.unknown().optional(),
  // 06:同样宽松收下,由 memory-default 解析(lib/memory/types.ts 的 parseMemoryConfig)
  memory: z.unknown().optional(),
  // 07:同样宽松收下,由 channel-telegram 解析;写坏了这个渠道按关闭算,状态里报 config_invalid
  channels: z.unknown().optional(),
})
export type KernelConfig = z.infer<typeof KernelConfigSchema>

export function saveConfig(file: string, cfg: KernelConfig): void {
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(cfg, null, 2))
  renameSync(tmp, file)
}

export function loadConfig(file: string): KernelConfig {
  if (existsSync(file)) {
    try {
      return KernelConfigSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
    } catch {
      renameSync(file, `${file}.bad-${Date.now()}`)
    }
  }
  const cfg = KernelConfigSchema.parse({})
  saveConfig(file, cfg)
  return cfg
}

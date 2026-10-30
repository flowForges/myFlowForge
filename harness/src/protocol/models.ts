import { z } from 'zod'

// 模型目录 / 账号 / 用量:RPC 结果与事件共用的形状(不含任何密钥)

export const SecretsBackendSchema = z.enum(['keychain', 'dpapi', 'secret-service', 'plaintext-file', 'unavailable', 'unreadable'])
export type SecretsBackend = z.infer<typeof SecretsBackendSchema>

export const AccountStateSchema = z.enum(['ok', 'needs_login', 'not_authorized', 'quota_exhausted', 'error'])
export type AccountState = z.infer<typeof AccountStateSchema>

export const ModelEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  context: z.number(),
  output: z.number(),
  image: z.boolean(),
  reasoning: z.enum(['none', 'toggle', 'effort']),
  deprecated: z.boolean().optional(),
})
export type ModelEntry = z.infer<typeof ModelEntrySchema>

export const PresetViewSchema = z.object({
  id: z.string(),
  label: z.string(),
  region: z.string().optional(),
  billing: z.enum(['metered', 'subscription']),
  restriction: z.enum(['coding-tools-only', 'unknown', 'none']),
  auth: z.enum(['api-key', 'chatgpt-oauth']),
  protocols: z.array(z.string()),
  docsUrl: z.string(),
})
export type PresetView = z.infer<typeof PresetViewSchema>

export const ModelRefSchema = z.object({ accountId: z.string(), modelId: z.string() })
export type ModelRef = z.infer<typeof ModelRefSchema>

export const CatalogViewSchema = z.object({
  presets: z.array(PresetViewSchema),
  models: z.record(z.string(), z.array(ModelEntrySchema)), // presetId -> 模型
  default: ModelRefSchema.optional(),
})
export type CatalogView = z.infer<typeof CatalogViewSchema>

export const AccountViewSchema = z.object({
  id: z.string(),
  presetId: z.string(),
  label: z.string(),
  state: AccountStateSchema,
  baseUrl: z.string().optional(),
  models: z.array(ModelEntrySchema).optional(),
})
export type AccountView = z.infer<typeof AccountViewSchema>

export const ModelErrorViewSchema = z.object({ kind: z.string(), message: z.string() })
export type ModelErrorView = z.infer<typeof ModelErrorViewSchema>

export const QuotaSchema = z.union([
  z.object({
    windows: z.array(z.object({ label: z.string(), usedPercent: z.number(), resetsAt: z.number().optional() })),
  }),
  z.object({ link: z.string() }),
])
export type Quota = z.infer<typeof QuotaSchema>

export const AccountProtocolSchema = z.enum(['openai-chat', 'openai-responses', 'anthropic'])

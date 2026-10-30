// 内置供应商预设(spec §7)。lib 层,只依赖 protocol 类型。
import { z } from 'zod'
import type { PresetView } from '../../../protocol/models'
import type { ChatQuirks } from '../chat'
import type { AnthropicQuirks } from '../anthropic'

const Protocol = z.enum(['openai-chat', 'openai-responses', 'anthropic', 'chatgpt'])
export type PresetProtocol = z.infer<typeof Protocol>

const PresetModelSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  context: z.number().optional(),
  output: z.number().optional(),
  image: z.boolean().optional(),
  reasoning: z.enum(['none', 'toggle', 'effort']).optional(),
  toolCall: z.boolean().optional(),
})
export type PresetModel = z.infer<typeof PresetModelSchema>

export const PresetSchema = z.object({
  id: z.string(),
  label: z.string(),
  region: z.enum(['cn', 'global', 'sgp', 'ams']).optional(),
  protocols: z.object({
    'openai-chat': z.string().optional(),
    'openai-responses': z.string().optional(),
    anthropic: z.string().optional(),
    chatgpt: z.string().optional(),
  }),
  preferred: Protocol,
  auth: z.enum(['api-key', 'chatgpt-oauth']),
  billing: z.enum(['metered', 'subscription']),
  restriction: z.enum(['coding-tools-only', 'unknown', 'none']),
  models: z.union([z.literal('list'), z.array(PresetModelSchema)]),
  quotaProbe: z.enum(['zhipu', 'kimi', 'minimax', 'link']).optional(),
  quirks: z.object({ chat: z.custom<ChatQuirks>().optional(), anthropic: z.custom<AnthropicQuirks>().optional() }),
  docsUrl: z.string().url().startsWith('https://'),
})
export type Preset = z.infer<typeof PresetSchema>

export function toPresetView(p: Preset): PresetView {
  return {
    id: p.id,
    label: p.label,
    ...(p.region ? { region: p.region } : {}),
    billing: p.billing,
    restriction: p.restriction,
    auth: p.auth,
    protocols: Object.keys(p.protocols),
    docsUrl: p.docsUrl,
  }
}

const ids = (...xs: string[]): PresetModel[] => xs.map((id) => ({ id }))
const sub = { auth: 'api-key', billing: 'subscription' } as const
const chatDeepseek: ChatQuirks = { thinking: 'deepseek', replayReasoningContent: true, noDeveloperRole: true }
const chatQwen: ChatQuirks = { thinking: 'qwen', noDeveloperRole: true }
const chatZai: ChatQuirks = { thinking: 'zai', noDeveloperRole: true }
const noDev: ChatQuirks = { noDeveloperRole: true }

export const PRESETS: Preset[] = [
  {
    id: 'openai', label: 'OpenAI', auth: 'api-key', billing: 'metered', restriction: 'none',
    protocols: { 'openai-responses': 'https://api.openai.com/v1', 'openai-chat': 'https://api.openai.com/v1' },
    preferred: 'openai-responses', models: 'list', quirks: {}, docsUrl: 'https://platform.openai.com/docs/api-reference',
  },
  {
    id: 'anthropic', label: 'Anthropic', auth: 'api-key', billing: 'metered', restriction: 'none',
    protocols: { anthropic: 'https://api.anthropic.com' }, preferred: 'anthropic',
    models: ids('claude-opus-5-5', 'claude-sonnet-5', 'claude-haiku-4-5'), quirks: {}, docsUrl: 'https://docs.anthropic.com/en/api/overview',
  },
  {
    id: 'deepseek', label: 'DeepSeek', auth: 'api-key', billing: 'metered', restriction: 'none',
    protocols: { 'openai-chat': 'https://api.deepseek.com', anthropic: 'https://api.deepseek.com/anthropic' },
    preferred: 'openai-chat', models: 'list', quirks: { chat: chatDeepseek }, docsUrl: 'https://api-docs.deepseek.com/',
  },
  {
    id: 'openrouter', label: 'OpenRouter', auth: 'api-key', billing: 'metered', restriction: 'none',
    protocols: { 'openai-chat': 'https://openrouter.ai/api/v1' }, preferred: 'openai-chat', models: 'list', quirks: {},
    docsUrl: 'https://openrouter.ai/docs/api-reference/overview',
  },
  {
    id: 'chatgpt', label: 'ChatGPT 订阅', auth: 'chatgpt-oauth', billing: 'subscription', restriction: 'none',
    protocols: { chatgpt: 'https://api.openai.com/v1' }, preferred: 'chatgpt', models: 'list', quotaProbe: 'link', quirks: {},
    docsUrl: 'https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan',
  },
  {
    id: 'zhipu-cn', label: '智谱 Coding Plan', region: 'cn', ...sub, restriction: 'coding-tools-only',
    protocols: { 'openai-chat': 'https://open.bigmodel.cn/api/coding/paas/v4', anthropic: 'https://open.bigmodel.cn/api/anthropic' },
    preferred: 'anthropic', models: ids('glm-5.3', 'glm-5.3-flash', 'glm-5.3-highspeed'), quotaProbe: 'zhipu',
    quirks: { chat: chatZai }, docsUrl: 'https://docs.bigmodel.cn/cn/coding-plan/overview',
  },
  {
    id: 'zai', label: 'Z.ai Coding Plan', region: 'global', ...sub, restriction: 'coding-tools-only',
    protocols: { 'openai-chat': 'https://api.z.ai/api/coding/paas/v4', anthropic: 'https://api.z.ai/api/anthropic' },
    preferred: 'anthropic', models: ids('glm-5.3', 'glm-5.3-flash', 'glm-5.3-highspeed', 'glm-5.2', 'glm-4.7'), quotaProbe: 'zhipu',
    quirks: { chat: chatZai }, docsUrl: 'https://docs.z.ai/devpack/overview',
  },
  {
    id: 'bailian-coding', label: '阿里百炼 Coding Plan', region: 'cn', ...sub, restriction: 'coding-tools-only',
    protocols: { 'openai-chat': 'https://coding.dashscope.aliyuncs.com/v1', anthropic: 'https://coding.dashscope.aliyuncs.com/apps/anthropic' },
    preferred: 'anthropic', models: ids('qwen3.7-plus', 'qwen3.6-plus', 'kimi-k2.5', 'glm-5', 'MiniMax-M2.5'),
    quirks: { chat: chatQwen }, docsUrl: 'https://help.aliyun.com/zh/model-studio/coding-plan',
  },
  {
    id: 'bailian-token-cn', label: '阿里百炼 Token Plan', region: 'cn', ...sub, restriction: 'unknown',
    protocols: {
      'openai-chat': 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
      anthropic: 'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic',
    },
    preferred: 'openai-chat', models: ids('qwen3.8-max', 'qwen3.8-flash', 'deepseek-v4', 'glm-5.3', 'kimi-k2.7-code'),
    quirks: { chat: chatQwen }, docsUrl: 'https://help.aliyun.com/zh/model-studio/token-plan',
  },
  {
    id: 'qwen-token-intl', label: 'Qwen Token Plan', region: 'global', ...sub, restriction: 'unknown',
    protocols: {
      'openai-chat': 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
      anthropic: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic',
    },
    preferred: 'openai-chat', models: ids('qwen3.8-max', 'qwen3.8-flash', 'deepseek-v4', 'glm-5.3', 'kimi-k2.7-code'),
    quirks: { chat: chatQwen }, docsUrl: 'https://www.alibabacloud.com/help/en/model-studio/token-plan',
  },
  ...(['cn', 'sgp', 'ams'] as const).map(
    (r): Preset => ({
      id: `mimo-${r}`, label: '小米 MiMo Token Plan', region: r, ...sub, restriction: 'unknown',
      protocols: { 'openai-chat': `https://token-plan-${r}.xiaomimimo.com/v1`, anthropic: `https://token-plan-${r}.xiaomimimo.com/anthropic` },
      preferred: 'openai-chat', models: ids('mimo-v2.6-pro', 'mimo-v2.6-flash', 'mimo-v2.5-pro'),
      quirks: { chat: chatDeepseek }, docsUrl: 'https://platform.xiaomimimo.com/#/docs',
    }),
  ),
  {
    id: 'kimi-cn', label: 'Kimi Code', region: 'cn', ...sub, restriction: 'unknown',
    protocols: { 'openai-chat': 'https://api.kimi.com/coding/v1', anthropic: 'https://api.kimi.com/coding' },
    preferred: 'anthropic', models: ids('k3.1-pro', 'k3', 'k3-256k', 'kimi-for-coding'), quotaProbe: 'kimi',
    quirks: { anthropic: { forceAdaptiveThinking: true } }, docsUrl: 'https://www.kimi.com/code/docs',
  },
  {
    id: 'kimi-global', label: 'Kimi Code', region: 'global', ...sub, restriction: 'unknown',
    protocols: { 'openai-chat': 'https://api.kimi.ai/coding/v1', anthropic: 'https://api.kimi.ai/coding' },
    preferred: 'anthropic', models: ids('k3.1-pro', 'k3', 'k3-256k', 'kimi-for-coding'), quotaProbe: 'kimi',
    quirks: { anthropic: { forceAdaptiveThinking: true } }, docsUrl: 'https://www.kimi.com/code/docs',
  },
  {
    id: 'minimax-cn', label: 'MiniMax Token Plan', region: 'cn', ...sub, restriction: 'unknown',
    protocols: { 'openai-chat': 'https://api.minimaxi.com/v1', anthropic: 'https://api.minimaxi.com/anthropic' },
    preferred: 'anthropic', models: ids('MiniMax-M3', 'MiniMax-M3.1-Flash', 'MiniMax-M2.7'), quotaProbe: 'minimax',
    quirks: {}, docsUrl: 'https://platform.minimaxi.com/docs/guides/token-plan',
  },
  {
    id: 'minimax-global', label: 'MiniMax Token Plan', region: 'global', ...sub, restriction: 'unknown',
    protocols: { 'openai-chat': 'https://api.minimax.io/v1', anthropic: 'https://api.minimax.io/anthropic' },
    preferred: 'anthropic', models: ids('MiniMax-M3', 'MiniMax-M3.1-Flash', 'MiniMax-M2.7'), quotaProbe: 'minimax',
    quirks: {}, docsUrl: 'https://platform.minimax.io/docs/guides/token-plan',
  },
  {
    id: 'ark-coding', label: '火山方舟 Coding Plan', region: 'cn', ...sub, restriction: 'coding-tools-only',
    protocols: { 'openai-chat': 'https://ark.cn-beijing.volces.com/api/coding/v3', anthropic: 'https://ark.cn-beijing.volces.com/api/coding' },
    preferred: 'anthropic',
    models: ids('ark-code-latest', 'doubao-seed-2.1-pro', 'doubao-seed-2.1-lite', 'kimi-k3', 'glm-5.3', 'deepseek-v4-pro', 'deepseek-v4-flash'),
    quirks: { chat: noDev }, docsUrl: 'https://www.volcengine.com/docs/82379/1925114',
  },
  // 自定义:地址由用户填,restriction 默认 unknown(用户可改)
  {
    id: 'custom-openai', label: '自定义（OpenAI 兼容）', auth: 'api-key', billing: 'metered', restriction: 'unknown',
    protocols: {}, preferred: 'openai-chat', models: 'list', quirks: {}, docsUrl: 'https://platform.openai.com/docs/api-reference',
  },
  {
    id: 'custom-anthropic', label: '自定义（Anthropic 兼容）', auth: 'api-key', billing: 'metered', restriction: 'unknown',
    protocols: {}, preferred: 'anthropic', models: 'list', quirks: {}, docsUrl: 'https://docs.anthropic.com/en/api/overview',
  },
]

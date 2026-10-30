// 从 models.dev api.json 生成精简模型快照。
// 重新生成:
//   curl -sS https://models.dev/api.json -o /tmp/api.json && node harness/scripts/gen-model-snapshot.mjs /tmp/api.json harness/src/lib/models/catalog/models.snapshot.json
// 第三个参数可选:逗号分隔的 provider id 列表,默认 = 各预设的 snapshotProvider(测试保证两者一致)。
import { readFileSync, writeFileSync } from 'node:fs'

const DEFAULT_PROVIDERS = [
  'openai', 'anthropic', 'deepseek', 'zhipuai-coding-plan', 'zai-coding-plan', 'alibaba-coding-plan-cn', 'alibaba-token-plan-cn',
  'alibaba-token-plan', 'xiaomi-token-plan-cn', 'xiaomi-token-plan-sgp', 'xiaomi-token-plan-ams', 'kimi-code-plan-cn',
  'kimi-code-plan-global', 'minimax-cn-coding-plan', 'minimax-coding-plan', 'volcengine-coding-plan',
]
const [, , input, output, providersArg] = process.argv
const providers = new Set(providersArg ? providersArg.split(',') : DEFAULT_PROVIDERS)
if (!input || !output) {
  console.error('usage: gen-model-snapshot.mjs <api.json> <out.json>')
  process.exit(2)
}

const api = JSON.parse(readFileSync(input, 'utf8'))
const models = {}
for (const provider of Object.values(api)) {
  if (!providers.has(provider.id)) continue
  for (const m of Object.values(provider.models ?? {})) {
    if (!m.modalities?.output?.includes('text')) continue // 丢弃非文本输出模型
    const e = {
      id: m.id,
      name: m.name ?? m.id,
      reasoning: !!m.reasoning,
      toolCall: !!m.tool_call,
      image: !!m.modalities?.input?.includes('image'),
    }
    // 缺 limit 时省略字段,让合并时的默认值生效
    if (typeof m.limit?.context === 'number' && m.limit.context > 0) e.context = m.limit.context
    if (typeof m.limit?.output === 'number' && m.limit.output > 0) e.output = m.limit.output
    if (m.cost && typeof m.cost.input === 'number' && typeof m.cost.output === 'number') e.cost = { input: m.cost.input, output: m.cost.output }
    if (m.status) e.status = m.status
    models[`${provider.id}/${m.id}`] = e
  }
}
const sorted = Object.fromEntries(Object.entries(models).sort(([a], [b]) => (a < b ? -1 : 1)))
// generatedAt 取自环境变量以便可复现,默认当前时间
const generatedAt = process.env.SNAPSHOT_GENERATED_AT ?? new Date().toISOString()
writeFileSync(output, JSON.stringify({ generatedAt, models: sorted }, null, 1) + '\n')

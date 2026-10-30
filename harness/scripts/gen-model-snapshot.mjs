// 从 models.dev api.json 生成精简模型快照。
// 重新生成:
//   curl -sS https://models.dev/api.json -o /tmp/api.json && node harness/scripts/gen-model-snapshot.mjs /tmp/api.json harness/src/lib/models/catalog/models.snapshot.json
// 当前提交的快照由 harness/test/fixtures/models-dev-api.json 生成(占位,待用真实数据覆盖)。
import { readFileSync, writeFileSync } from 'node:fs'

const [, , input, output] = process.argv
if (!input || !output) {
  console.error('usage: gen-model-snapshot.mjs <api.json> <out.json>')
  process.exit(2)
}

const api = JSON.parse(readFileSync(input, 'utf8'))
const models = {}
for (const provider of Object.values(api)) {
  for (const m of Object.values(provider.models ?? {})) {
    if (!m.modalities?.output?.includes('text')) continue // 丢弃非文本输出模型
    const e = {
      id: m.id,
      name: m.name ?? m.id,
      context: m.limit?.context ?? 0,
      output: m.limit?.output ?? 0,
      reasoning: !!m.reasoning,
      toolCall: !!m.tool_call,
      image: !!m.modalities?.input?.includes('image'),
    }
    if (m.cost && typeof m.cost.input === 'number' && typeof m.cost.output === 'number') e.cost = { input: m.cost.input, output: m.cost.output }
    if (m.status) e.status = m.status
    models[`${provider.id}/${m.id}`] = e
  }
}
const sorted = Object.fromEntries(Object.entries(models).sort(([a], [b]) => (a < b ? -1 : 1)))
// generatedAt 取自环境变量以便可复现,默认当前时间
const generatedAt = process.env.SNAPSHOT_GENERATED_AT ?? new Date().toISOString()
writeFileSync(output, JSON.stringify({ generatedAt, models: sorted }, null, 1) + '\n')

import { describe, it, expect } from 'vitest'
import { ProviderConfigSchema } from './schema'

// z.object 会剥掉没声明的字段 —— codex 模型的快速档信息要是没进 ModelSchema,存进 agents.json 的
// modelsCache 一读回来就没了,输入框上的「⚡ 快速」chip 永远不出现。
describe('ModelSchema 保留 codex 快速档字段', () => {
  it('modelsCache 读回来 fastTier / fastTierDescription 还在', () => {
    const pc = ProviderConfigSchema.parse({
      id: 'codex',
      modelsCache: [{ id: 'gpt-6-astra', label: 'GPT-6 Astra', fastTier: true, fastTierDescription: '2x speed, increased usage' }, { id: 'plain', label: 'Plain', fastTier: false }],
    })
    expect(pc.modelsCache[0]).toEqual({ id: 'gpt-6-astra', label: 'GPT-6 Astra', fastTier: true, fastTierDescription: '2x speed, increased usage' })
    expect(pc.modelsCache[1].fastTier).toBe(false)
  })
})

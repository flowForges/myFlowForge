import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CatalogViewSchema } from '../../../protocol/models'
import { mergeCatalog, type Snapshot } from './merge'
import { PRESETS, PresetSchema, type Preset } from './presets'
import snapshot from './models.snapshot.json'

const HARNESS = resolve(__dirname, '../../../..')
const snap = snapshot as Snapshot
const base = (over: Partial<Preset>): Preset => ({ ...PRESETS.find((p) => p.id === 'anthropic')!, ...over })

describe('PRESETS', () => {
  it('每条都通过 PresetSchema 且有 https docsUrl,id 唯一', () => {
    for (const p of PRESETS) {
      expect(PresetSchema.safeParse(p).success, p.id).toBe(true)
      expect(p.docsUrl.startsWith('https://'), p.id).toBe(true)
    }
    expect(new Set(PRESETS.map((p) => p.id)).size).toBe(PRESETS.length)
  })
  it('restriction 与简报表一致', () => {
    const r = (id: string) => PRESETS.find((p) => p.id === id)!.restriction
    for (const id of ['zhipu-cn', 'zai', 'bailian-coding', 'ark-coding']) expect(r(id)).toBe('coding-tools-only')
    for (const id of ['bailian-token-cn', 'qwen-token-intl', 'mimo-cn', 'mimo-sgp', 'mimo-ams', 'kimi-cn', 'kimi-global', 'minimax-cn', 'minimax-global', 'custom-openai', 'custom-anthropic'])
      expect(r(id)).toBe('unknown')
    for (const id of ['openai', 'anthropic', 'deepseek', 'openrouter', 'chatgpt']) expect(r(id)).toBe('none')
  })
  it('预设 id 集合完整', () => {
    expect(PRESETS.map((p) => p.id).sort()).toEqual(
      ['ark-coding', 'anthropic', 'bailian-coding', 'bailian-token-cn', 'chatgpt', 'custom-anthropic', 'custom-openai', 'deepseek', 'kimi-cn', 'kimi-global', 'mimo-ams', 'mimo-cn', 'mimo-sgp', 'minimax-cn', 'minimax-global', 'openai', 'openrouter', 'qwen-token-intl', 'zai', 'zhipu-cn'].sort(),
    )
  })
})

describe('mergeCatalog', () => {
  it('结果满足 CatalogViewSchema,list 预设为空数组,protocols 为字符串列表', () => {
    const c = mergeCatalog(PRESETS, snap)
    expect(CatalogViewSchema.safeParse(c).success).toBe(true)
    expect(c.models.openai).toEqual([])
    expect(c.presets.find((p) => p.id === 'deepseek')!.protocols).toEqual(['openai-chat', 'anthropic'])
  })
  it('缺元数据用保守默认值,name=id', () => {
    const c = mergeCatalog([base({ models: [{ id: 'unknown-x' }] })], snap)
    expect(c.models.anthropic[0]).toEqual({ id: 'unknown-x', name: 'unknown-x', context: 128000, output: 8000, image: false, reasoning: 'none', toolCall: true })
  })
  it('快照填充元数据', () => {
    const c = mergeCatalog([base({ models: [{ id: 'deepseek-v4-pro' }] })], snap)
    expect(c.models.anthropic[0]).toMatchObject({ name: 'DeepSeek V4 Pro', context: 256000, output: 64000, reasoning: 'toggle', toolCall: true })
  })
  it('优先级 预设 > 缓存 > 快照', () => {
    const cache: Snapshot = { generatedAt: 'x', models: { 'p/deepseek-v4-pro': { id: 'deepseek-v4-pro', name: 'Cached', context: 1, output: 2, reasoning: false, toolCall: false, image: true, cost: { input: 1, output: 2 } } } }
    const fromCache = mergeCatalog([base({ models: [{ id: 'deepseek-v4-pro' }] })], snap, cache).models.anthropic[0]
    expect(fromCache).toMatchObject({ name: 'Cached', context: 1, output: 2, image: true, toolCall: false, reasoning: 'none', cost: { input: 1, output: 2 } })
    const fromPreset = mergeCatalog([base({ models: [{ id: 'deepseek-v4-pro', context: 999, reasoning: 'effort' }] })], snap, cache).models.anthropic[0]
    expect(fromPreset).toMatchObject({ name: 'Cached', context: 999, output: 2, reasoning: 'effort' })
  })
  it('deprecated 排在后面且保持相对顺序', () => {
    const c = mergeCatalog([base({ models: [{ id: 'deepseek-chat' }, { id: 'a' }, { id: 'deepseek-v4-pro' }] })], snap)
    expect(c.models.anthropic.map((m) => m.id)).toEqual(['a', 'deepseek-v4-pro', 'deepseek-chat'])
    expect(c.models.anthropic[2].deprecated).toBe(true)
  })
})

describe('gen-model-snapshot.mjs', () => {
  it('在 fixture 上只保留文本输出模型并精简字段', () => {
    const out = join(mkdtempSync(join(tmpdir(), 'snap-')), 'out.json')
    execFileSync('node', [join(HARNESS, 'scripts/gen-model-snapshot.mjs'), join(HARNESS, 'test/fixtures/models-dev-api.json'), out])
    const s = JSON.parse(readFileSync(out, 'utf8')) as Snapshot
    expect(Object.keys(s.models)).toEqual(['deepseek/deepseek-chat', 'deepseek/deepseek-v4-pro', 'openai/gpt-5'])
    expect(s.models['openai/gpt-5']).toEqual({ id: 'gpt-5', name: 'GPT-5', context: 400000, output: 128000, reasoning: true, toolCall: true, image: true, cost: { input: 1.25, output: 10 } })
    expect(s.models['deepseek/deepseek-chat'].status).toBe('deprecated')
    expect(s.models['deepseek/deepseek-v4-pro'].cost).toBeUndefined()
    expect(typeof s.generatedAt).toBe('string')
  })
})

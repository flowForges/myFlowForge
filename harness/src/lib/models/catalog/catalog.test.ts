import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
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

// 测试自带的快照,与随包快照解耦
const LOCAL: Snapshot = {
  generatedAt: 't',
  models: {
    'prov/deepseek-v4-pro': { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', context: 256000, output: 64000, reasoning: true, toolCall: true, image: false },
    'prov/old': { id: 'old', name: 'Old', context: 8000, output: 1000, reasoning: false, toolCall: true, image: false, status: 'deprecated' },
    'other/shared': { id: 'shared', name: 'Other Shared', context: 5, output: 5, reasoning: false, toolCall: true, image: false },
    'prov/shared': { id: 'shared', name: 'Prov Shared', context: 7, output: 7, reasoning: false, toolCall: true, image: false },
    'prov/nolimit': { id: 'nolimit', name: 'No Limit', reasoning: false, toolCall: true, image: false },
  },
}

describe('mergeCatalog', () => {
  it('结果满足 CatalogViewSchema,list 预设为空数组,protocols 为字符串列表', () => {
    const c = mergeCatalog(PRESETS, snap)
    expect(CatalogViewSchema.safeParse(c).success).toBe(true)
    expect(c.models.openai).toEqual([])
    expect(c.presets.find((p) => p.id === 'deepseek')!.protocols).toEqual(['openai-chat', 'anthropic'])
  })
  it('缺元数据用保守默认值,name=id', () => {
    const c = mergeCatalog([base({ models: [{ id: 'unknown-x' }] })], LOCAL)
    expect(c.models.anthropic[0]).toEqual({ id: 'unknown-x', name: 'unknown-x', context: 128000, output: 8000, image: false, reasoning: 'none', toolCall: true })
  })
  it('快照缺 limit 时用默认值', () => {
    const c = mergeCatalog([base({ snapshotProvider: 'prov', models: [{ id: 'nolimit' }] })], LOCAL)
    expect(c.models.anthropic[0]).toMatchObject({ name: 'No Limit', context: 128000, output: 8000 })
  })
  it('快照填充元数据', () => {
    const c = mergeCatalog([base({ models: [{ id: 'deepseek-v4-pro' }] })], LOCAL)
    expect(c.models.anthropic[0]).toMatchObject({ name: 'DeepSeek V4 Pro', context: 256000, output: 64000, reasoning: 'toggle', toolCall: true })
  })
  it('按 snapshotProvider 精确查,缺失才退回任意 provider', () => {
    const get = (provider?: string) => mergeCatalog([base({ snapshotProvider: provider, models: [{ id: 'shared' }] })], LOCAL).models.anthropic[0]
    expect(get('prov').name).toBe('Prov Shared')
    expect(get('other').name).toBe('Other Shared')
    expect(get('nowhere').name).toBe('Other Shared') // 退回首个同 id
  })
  it('优先级 预设 > 缓存 > 快照', () => {
    const cache: Snapshot = { generatedAt: 'x', models: { 'p/deepseek-v4-pro': { id: 'deepseek-v4-pro', name: 'Cached', context: 1, output: 2, reasoning: false, toolCall: false, image: true, cost: { input: 1, output: 2 } } } }
    const fromCache = mergeCatalog([base({ models: [{ id: 'deepseek-v4-pro' }] })], LOCAL, cache).models.anthropic[0]
    expect(fromCache).toMatchObject({ name: 'Cached', context: 1, output: 2, image: true, toolCall: false, reasoning: 'none', cost: { input: 1, output: 2 } })
    const fromPreset = mergeCatalog([base({ models: [{ id: 'deepseek-v4-pro', context: 999, reasoning: 'effort' }] })], LOCAL, cache).models.anthropic[0]
    expect(fromPreset).toMatchObject({ name: 'Cached', context: 999, output: 2, reasoning: 'effort' })
  })
  it('deprecated 排在后面且保持相对顺序', () => {
    const c = mergeCatalog([base({ models: [{ id: 'old' }, { id: 'a' }, { id: 'deepseek-v4-pro' }] })], LOCAL)
    expect(c.models.anthropic.map((m) => m.id)).toEqual(['a', 'deepseek-v4-pro', 'old'])
    expect(c.models.anthropic[2].deprecated).toBe(true)
  })
})

describe('随包快照', () => {
  it('每个内置模型 id 由快照(经其 provider)解析,或在预设里显式覆盖 context/output', () => {
    for (const p of PRESETS) {
      if (p.models === 'list') continue
      for (const m of p.models) {
        const e = snap.models[`${p.snapshotProvider}/${m.id}`]
        const ok = (e?.context && e?.output) || (m.context && m.output)
        expect(ok, `${p.id}/${m.id}`).toBeTruthy()
      }
    }
  })
  it('快照只含预设声明的 provider,且与脚本默认列表一致', () => {
    const providers = new Set(PRESETS.flatMap((p) => (p.snapshotProvider ? [p.snapshotProvider] : [])))
    const inSnap = new Set(Object.keys(snap.models).map((k) => k.slice(0, k.indexOf('/'))))
    for (const k of inSnap) expect(providers.has(k), k).toBe(true)
    const src = readFileSync(join(HARNESS, 'scripts/gen-model-snapshot.mjs'), 'utf8')
    const listed = [...src.slice(src.indexOf('DEFAULT_PROVIDERS = ['), src.indexOf(']')).matchAll(/'([^']+)'/g)].map((m) => m[1])
    expect(new Set(listed)).toEqual(providers)
    expect(statSync(join(__dirname, 'models.snapshot.json')).size).toBeLessThan(200_000)
  })
})

// 简报表逐行核对:[id, protocols(chat, anthropic, responses, chatgpt), preferred, restriction, quotaProbe, quirks]
type Row = [string, Partial<Record<string, string>>, string, string, string | undefined, Preset['quirks']]
const dsq = { thinking: 'deepseek', replayReasoningContent: true, noDeveloperRole: true } as const
const qwq = { thinking: 'qwen', noDeveloperRole: true } as const
const zaq = { thinking: 'zai', noDeveloperRole: true } as const
const mimo = (r: string): Row => [`mimo-${r}`, { 'openai-chat': `https://token-plan-${r}.xiaomimimo.com/v1`, anthropic: `https://token-plan-${r}.xiaomimimo.com/anthropic` }, 'openai-chat', 'unknown', undefined, { chat: dsq }]
const TABLE: Row[] = [
  ['openai', { 'openai-responses': 'https://api.openai.com/v1', 'openai-chat': 'https://api.openai.com/v1' }, 'openai-responses', 'none', undefined, {}],
  ['anthropic', { anthropic: 'https://api.anthropic.com' }, 'anthropic', 'none', undefined, {}],
  ['deepseek', { 'openai-chat': 'https://api.deepseek.com', anthropic: 'https://api.deepseek.com/anthropic' }, 'openai-chat', 'none', undefined, { chat: dsq }],
  ['openrouter', { 'openai-chat': 'https://openrouter.ai/api/v1' }, 'openai-chat', 'none', undefined, {}],
  ['chatgpt', { chatgpt: 'https://api.openai.com/v1' }, 'chatgpt', 'none', 'link', {}],
  ['zhipu-cn', { 'openai-chat': 'https://open.bigmodel.cn/api/coding/paas/v4', anthropic: 'https://open.bigmodel.cn/api/anthropic' }, 'anthropic', 'coding-tools-only', 'zhipu', { chat: zaq }],
  ['zai', { 'openai-chat': 'https://api.z.ai/api/coding/paas/v4', anthropic: 'https://api.z.ai/api/anthropic' }, 'anthropic', 'coding-tools-only', 'zhipu', { chat: zaq }],
  ['bailian-coding', { 'openai-chat': 'https://coding.dashscope.aliyuncs.com/v1', anthropic: 'https://coding.dashscope.aliyuncs.com/apps/anthropic' }, 'anthropic', 'coding-tools-only', undefined, { chat: qwq }],
  ['bailian-token-cn', { 'openai-chat': 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', anthropic: 'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic' }, 'openai-chat', 'unknown', undefined, { chat: qwq }],
  ['qwen-token-intl', { 'openai-chat': 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1', anthropic: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic' }, 'openai-chat', 'unknown', undefined, { chat: qwq }],
  mimo('cn'), mimo('sgp'), mimo('ams'),
  ['kimi-cn', { 'openai-chat': 'https://api.kimi.com/coding/v1', anthropic: 'https://api.kimi.com/coding' }, 'anthropic', 'unknown', 'kimi', { anthropic: { forceAdaptiveThinking: true } }],
  ['kimi-global', { 'openai-chat': 'https://api.kimi.ai/coding/v1', anthropic: 'https://api.kimi.ai/coding' }, 'anthropic', 'unknown', 'kimi', { anthropic: { forceAdaptiveThinking: true } }],
  ['minimax-cn', { 'openai-chat': 'https://api.minimaxi.com/v1', anthropic: 'https://api.minimaxi.com/anthropic' }, 'anthropic', 'unknown', 'minimax', {}],
  ['minimax-global', { 'openai-chat': 'https://api.minimax.io/v1', anthropic: 'https://api.minimax.io/anthropic' }, 'anthropic', 'unknown', 'minimax', {}],
  ['ark-coding', { 'openai-chat': 'https://ark.cn-beijing.volces.com/api/coding/v3', anthropic: 'https://ark.cn-beijing.volces.com/api/coding' }, 'anthropic', 'coding-tools-only', undefined, { chat: { noDeveloperRole: true } }],
  ['custom-openai', {}, 'openai-chat', 'unknown', undefined, {}],
  ['custom-anthropic', {}, 'anthropic', 'unknown', undefined, {}],
]
describe('PRESETS 与简报表逐行一致', () => {
  it.each(TABLE)('%s', (id, protocols, preferred, restriction, quotaProbe, quirks) => {
    const p = PRESETS.find((x) => x.id === id)!
    expect(p.protocols).toEqual(protocols)
    expect(p.preferred).toBe(preferred)
    expect(p.restriction).toBe(restriction)
    expect(p.quotaProbe).toBe(quotaProbe)
    expect(p.quirks).toEqual(quirks)
  })
  it('表覆盖全部预设', () => {
    expect(TABLE.map((r) => r[0]).sort()).toEqual(PRESETS.map((p) => p.id).sort())
  })
})

describe('gen-model-snapshot.mjs', () => {
  it('在 fixture 上只保留文本输出模型并精简字段', () => {
    const out = join(mkdtempSync(join(tmpdir(), 'snap-')), 'out.json')
    execFileSync('node', [join(HARNESS, 'scripts/gen-model-snapshot.mjs'), join(HARNESS, 'test/fixtures/models-dev-api.json'), out, 'openai,deepseek,other-provider'])
    const s = JSON.parse(readFileSync(out, 'utf8')) as Snapshot
    expect(s.models['other-provider/nolimit']).toEqual({ id: 'nolimit', name: 'No Limit', reasoning: false, toolCall: true, image: false }) // 缺 limit 则省略
    delete s.models['other-provider/nolimit']
    expect(Object.keys(s.models)).toEqual(['deepseek/deepseek-chat', 'deepseek/deepseek-v4-pro', 'openai/gpt-5'])
    expect(s.models['openai/gpt-5']).toEqual({ id: 'gpt-5', name: 'GPT-5', context: 400000, output: 128000, reasoning: true, toolCall: true, image: true, cost: { input: 1.25, output: 10 } })
    expect(s.models['deepseek/deepseek-chat'].status).toBe('deprecated')
    expect(s.models['deepseek/deepseek-v4-pro'].cost).toBeUndefined()
    expect(typeof s.generatedAt).toBe('string')
  })
  it('provider 过滤:默认/显式列表之外的 provider 被丢弃', () => {
    const out = join(mkdtempSync(join(tmpdir(), 'snap-')), 'out.json')
    execFileSync('node', [join(HARNESS, 'scripts/gen-model-snapshot.mjs'), join(HARNESS, 'test/fixtures/models-dev-api.json'), out, 'openai'])
    expect(Object.keys((JSON.parse(readFileSync(out, 'utf8')) as Snapshot).models)).toEqual(['openai/gpt-5'])
  })
})

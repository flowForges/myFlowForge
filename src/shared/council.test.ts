import { describe, it, expect } from 'vitest'
import {
  COUNCIL_PROVIDERS, validateCouncilConfig, estimateCouncilMinutes, isCouncilProvider,
  type CouncilConfig, type CouncilSeat,
} from './council'

const seat = (provider: string, model: string): CouncilSeat => ({ id: `${provider}-${model}`, provider, model, label: `${provider} · ${model}` })
const cfg = (over: Partial<CouncilConfig> = {}): CouncilConfig => ({
  topic: '选哪个方案',
  attachments: [],
  seats: [seat('claude', 'opus'), seat('codex', '6.1')],
  leader: seat('gemini', 'pro'),
  mode: { kind: 'rounds', rounds: 2 },
  ...over,
})

describe('validateCouncilConfig', () => {
  it('合法配置返回 null', () => expect(validateCouncilConfig(cfg())).toBeNull())
  it('1 个席位 / 7 个席位不通过', () => {
    expect(validateCouncilConfig(cfg({ seats: [seat('claude', 'a')] }))).not.toBeNull()
    const seven = Array.from({ length: 7 }, (_, i) => seat(COUNCIL_PROVIDERS[i % COUNCIL_PROVIDERS.length], `m${i}`))
    expect(validateCouncilConfig(cfg({ seats: seven }))).not.toBeNull()
  })
  it('6 个席位通过', () => {
    const six = Array.from({ length: 6 }, (_, i) => seat(COUNCIL_PROVIDERS[i % COUNCIL_PROVIDERS.length], `m${i}`))
    expect(validateCouncilConfig(cfg({ seats: six }))).toBeNull()
  })
  it('席位 (provider, model) 重复不通过;同 provider 不同 model 通过', () => {
    expect(validateCouncilConfig(cfg({ seats: [seat('claude', 'a'), seat('claude', 'a')] }))).not.toBeNull()
    expect(validateCouncilConfig(cfg({ seats: [seat('claude', 'a'), seat('claude', 'b')] }))).toBeNull()
  })
  it('轮数 0 / 6 不通过', () => {
    expect(validateCouncilConfig(cfg({ mode: { kind: 'rounds', rounds: 0 } }))).not.toBeNull()
    expect(validateCouncilConfig(cfg({ mode: { kind: 'rounds', rounds: 6 } }))).not.toBeNull()
  })
  it('provider 为 cursor 不通过(席位与主持人)', () => {
    expect(validateCouncilConfig(cfg({ seats: [seat('cursor', 'x'), seat('codex', '6.1')] }))).not.toBeNull()
    expect(validateCouncilConfig(cfg({ leader: seat('cursor', 'x') }))).not.toBeNull()
  })
  it('议题为空白不通过', () => expect(validateCouncilConfig(cfg({ topic: '  \n ' }))).not.toBeNull())
  it('主持人可与席位同 provider+model', () => {
    expect(validateCouncilConfig(cfg({ leader: seat('claude', 'opus') }))).toBeNull()
  })
  it('共识模式:超过上限不通过', () => {
    expect(validateCouncilConfig(cfg({ mode: { kind: 'consensus', maxRounds: 5, maxMinutes: 30 } }))).toBeNull()
    expect(validateCouncilConfig(cfg({ mode: { kind: 'consensus', maxRounds: 6, maxMinutes: 30 } }))).not.toBeNull()
    expect(validateCouncilConfig(cfg({ mode: { kind: 'consensus', maxRounds: 5, maxMinutes: 31 } }))).not.toBeNull()
  })
})

describe('isCouncilProvider', () => {
  it('白名单', () => {
    expect(isCouncilProvider('codex')).toBe(true)
    // ★qoder / antigravity 探针未通过,暂不放进来(见 COUNCIL_PROVIDERS 的注释)
    for (const p of ['qoder', 'antigravity']) expect(isCouncilProvider(p)).toBe(false)
    expect(isCouncilProvider('cursor')).toBe(false)
  })
})

describe('estimateCouncilMinutes', () => {
  const three = (rounds: number) => cfg({
    seats: [seat('claude', 'a'), seat('codex', 'b'), seat('qwen', 'c')],
    mode: { kind: 'rounds', rounds },
  })
  it('lo < hi,轮数越多越久(第 1 轮并行只算一次)', () => {
    const [lo, hi] = estimateCouncilMinutes(three(2))
    expect(lo).toBeLessThan(hi)
    expect(estimateCouncilMinutes(three(1))[1]).toBeLessThan(hi)
  })
  it('共识模式以 maxMinutes 封顶', () => {
    const [lo, hi] = estimateCouncilMinutes(cfg({ mode: { kind: 'consensus', maxRounds: 5, maxMinutes: 10 } }))
    expect(hi).toBeLessThanOrEqual(10)
    expect(lo).toBeLessThanOrEqual(hi)
  })
})

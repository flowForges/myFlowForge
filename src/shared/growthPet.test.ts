import { describe, it, expect } from 'vitest'
import { parseGrowthManifest, isGrowthManifestRaw, DEFAULT_GROWTH_ACTIONS } from './growthPet'

// 一份合法的最小 manifest,各用例在它上面做局部破坏。
function base(): Record<string, unknown> {
  return {
    id: 'growth-tree',
    name: '成长树',
    kind: 'growth',
    signal: 'dailyTokens',
    atlas: { cols: 8, cellW: 192, cellH: 208 },
    actions: {
      idle: { row: 0, durations: [280, 110, 110, 140, 140, 320] },
      working: { row: 1, durations: [120, 120, 120, 120, 120, 220] },
      alert: { row: 2, durations: [150, 150, 150, 150, 150, 280] },
    },
    stages: [
      { at: 0, name: '种子', sheet: '0-seed.png' },
      { at: 0.4, name: '树干', sheet: '3-trunk.png' },
      { at: 0.9, name: '结果', sheet: '5-fruit.png' },
    ],
  }
}

describe('isGrowthManifestRaw', () => {
  it('只认 kind==="growth"', () => {
    expect(isGrowthManifestRaw(base())).toBe(true)
    expect(isGrowthManifestRaw({ ...base(), kind: undefined })).toBe(false)
    expect(isGrowthManifestRaw({ spriteVersionNumber: 2 })).toBe(false)
    expect(isGrowthManifestRaw(null)).toBe(false)
  })
})

describe('parseGrowthManifest', () => {
  it('接受合法 manifest', () => {
    const r = parseGrowthManifest(base())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.manifest.id).toBe('growth-tree')
    expect(r.manifest.stages).toHaveLength(3)
    expect(r.manifest.actions.working?.row).toBe(1)
  })

  it('整块 actions 缺失时填默认时长表', () => {
    const raw = base()
    delete raw.actions
    const r = parseGrowthManifest(raw)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.manifest.actions).toEqual(DEFAULT_GROWTH_ACTIONS)
  })

  it('只给 idle 一行也合法(working/alert 留空,由调用方回落)', () => {
    const raw = base()
    raw.actions = { idle: { row: 0, durations: [200, 200] } }
    const r = parseGrowthManifest(raw)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.manifest.actions.working).toBeUndefined()
    expect(r.manifest.actions.alert).toBeUndefined()
  })

  it.each([
    ['kind 不是 growth', { kind: 'codex' }],
    ['signal 不认识', { signal: 'weather' }],
    ['缺 id', { id: '' }],
    ['缺 name', { name: '' }],
  ])('拒绝:%s', (_label, patch) => {
    expect(parseGrowthManifest({ ...base(), ...patch }).ok).toBe(false)
  })

  it('拒绝 stages 为空', () => {
    expect(parseGrowthManifest({ ...base(), stages: [] }).ok).toBe(false)
  })

  it('拒绝首条 at 不为 0', () => {
    const raw = base()
    raw.stages = [{ at: 0.1, sheet: 'a.png' }, { at: 0.5, sheet: 'b.png' }]
    expect(parseGrowthManifest(raw).ok).toBe(false)
  })

  it('拒绝 at 乱序', () => {
    const raw = base()
    raw.stages = [{ at: 0, sheet: 'a.png' }, { at: 0.6, sheet: 'b.png' }, { at: 0.3, sheet: 'c.png' }]
    expect(parseGrowthManifest(raw).ok).toBe(false)
  })

  it('拒绝 at 越界', () => {
    const raw = base()
    raw.stages = [{ at: 0, sheet: 'a.png' }, { at: 1.4, sheet: 'b.png' }]
    expect(parseGrowthManifest(raw).ok).toBe(false)
  })

  it.each(['../evil.png', '/abs/evil.png', 'a/../../evil.png'])('拒绝越界路径:%s', (sheet) => {
    const raw = base()
    raw.stages = [{ at: 0, sheet }]
    expect(parseGrowthManifest(raw).ok).toBe(false)
  })

  it('拒绝 atlas 尺寸非正整数', () => {
    expect(parseGrowthManifest({ ...base(), atlas: { cols: 0, cellW: 192, cellH: 208 } }).ok).toBe(false)
    expect(parseGrowthManifest({ ...base(), atlas: { cols: 8.5, cellW: 192, cellH: 208 } }).ok).toBe(false)
  })

  it('拒绝 durations 长度超过 cols(画外的空格子会闪黑)', () => {
    const raw = base()
    raw.actions = { idle: { row: 0, durations: new Array(9).fill(100) } }
    expect(parseGrowthManifest(raw).ok).toBe(false)
  })

  it('拒绝空 durations 和非正数时长', () => {
    expect(parseGrowthManifest({ ...base(), actions: { idle: { row: 0, durations: [] } } }).ok).toBe(false)
    expect(parseGrowthManifest({ ...base(), actions: { idle: { row: 0, durations: [100, 0] } } }).ok).toBe(false)
  })

  it('拒绝 row 重复或为负', () => {
    const dup = { idle: { row: 0, durations: [100] }, working: { row: 0, durations: [100] } }
    expect(parseGrowthManifest({ ...base(), actions: dup }).ok).toBe(false)
    expect(parseGrowthManifest({ ...base(), actions: { idle: { row: -1, durations: [100] } } }).ok).toBe(false)
  })

  it('给了 actions 但缺 idle 时拒绝(idle 是所有回落的终点)', () => {
    const raw = base()
    raw.actions = { working: { row: 0, durations: [100] } }
    expect(parseGrowthManifest(raw).ok).toBe(false)
  })
})

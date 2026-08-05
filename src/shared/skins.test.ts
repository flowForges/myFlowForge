import { describe, it, expect } from 'vitest'
import { BUILTIN_SKINS, KNOWN_SKIN_IDS } from './skins'

describe('BUILTIN_SKINS', () => {
  it('每套字段完整、色卡为 4 个 hex、base 合法', () => {
    for (const s of BUILTIN_SKINS) {
      expect(s.id).toBeTruthy()
      expect(s.name).toBeTruthy()
      expect(s.en).toBeTruthy()
      expect(s.tag).toBeTruthy()
      expect(s.vibe).toBeTruthy()
      expect(['dark', 'light']).toContain(s.base)
      expect(s.swatches).toHaveLength(4)
      for (const hex of s.swatches) expect(hex).toMatch(/^#[0-9a-fA-F]{6}$/)
    }
  })
  it('id 唯一,且 KNOWN_SKIN_IDS 与之一致', () => {
    const ids = BUILTIN_SKINS.map(s => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(KNOWN_SKIN_IDS.size).toBe(ids.length)
    for (const id of ids) expect(KNOWN_SKIN_IDS.has(id)).toBe(true)
  })
})

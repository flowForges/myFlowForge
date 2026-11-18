import { describe, it, expect } from 'vitest'
import { COMPUTER_TOOLS, SEMANTIC_TOOLS } from '@shared/computerUse'
import { computerUseDirective, CU_OFF_HINT_ENV } from './computerUseDirective'

describe('computerUseDirective', () => {
  it('names all seventeen tools, the semantic tools before the coordinate ones', () => {
    const d = computerUseDirective({ FORGE_TOOLS: COMPUTER_TOOLS.join(',') })
    for (const t of COMPUTER_TOOLS) expect(d).toContain(`mcp__forge__${t}`)
    expect(d).toContain('mcp__forge__computer_snapshot')
    const lastSemantic = Math.max(...SEMANTIC_TOOLS.map((t) => d.indexOf(`mcp__forge__${t}`)))
    const firstCoord = d.indexOf('mcp__forge__computer_screenshot')
    expect(lastSemantic).toBeLessThan(firstCoord)
  })

  it('points the model at snapshot → act first and screenshots as a fallback', () => {
    const d = computerUseDirective({ FORGE_TOOLS: COMPUTER_TOOLS.join(',') })
    expect(d.indexOf('computer_snapshot')).toBeLessThan(d.indexOf('computer_screenshot'))
    expect(d).toContain('后备')
  })

  it('is empty when FORGE_TOOLS has no computer_ tool', () => {
    expect(computerUseDirective({})).toBe('')
    expect(computerUseDirective({ FORGE_TOOLS: 'forge_ask' })).toBe('')
  })

  it('falls back to the off-hint sentence when the mode is off', () => {
    const d = computerUseDirective({ [CU_OFF_HINT_ENV]: '1' })
    expect(d).toContain('电脑')
    expect(d).not.toContain('mcp__forge__computer_')
  })
})

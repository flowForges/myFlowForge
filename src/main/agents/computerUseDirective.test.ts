import { describe, it, expect } from 'vitest'
import { V1_TOOLS, SEMANTIC_TOOLS } from '@shared/computerUse'
import { computerUseDirective, CU_OFF_HINT_ENV } from './computerUseDirective'

// Fix round 1, finding 3 (controller ruling R7): the semantic tools' executor isn't wired up until Task 6/7,
// so the model-facing directive must only name the v1 coordinate tools, never computer_apps/launch/snapshot/act/
// focus/wait_for/windows — otherwise the model is told to use tools that currently 500 on invalid_args.
describe('computerUseDirective (R7: v1-only until Task 6/7)', () => {
  it('names only the v1 coordinate tools, never a semantic tool', () => {
    const d = computerUseDirective({ FORGE_TOOLS: V1_TOOLS.join(',') })
    for (const t of V1_TOOLS) expect(d).toContain(`mcp__forge__${t}`)
    for (const t of SEMANTIC_TOOLS) {
      if ((V1_TOOLS as readonly string[]).includes(t)) continue // computer_key is in both lists
      expect(d).not.toContain(`mcp__forge__${t}`)
    }
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

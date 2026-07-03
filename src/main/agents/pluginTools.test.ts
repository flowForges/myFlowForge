import { describe, it, expect } from 'vitest'
import { claudeAllowedTools, skillDirective } from './pluginTools'

describe('claudeAllowedTools', () => {
  it('maps chip ids to claude tool names', () => {
    expect(claudeAllowedTools(['read', 'edit'])).toEqual(['Read', 'Edit'])
  })
  it('grep → Grep + Glob; git → Bash; web → WebSearch + WebFetch', () => {
    expect(claudeAllowedTools(['grep'])).toEqual(['Grep', 'Glob'])
    expect(claudeAllowedTools(['git'])).toEqual(['Bash'])
    expect(claudeAllowedTools(['web'])).toEqual(['WebSearch', 'WebFetch'])
  })
  it('dedupes when bash and git both map to Bash', () => {
    expect(claudeAllowedTools(['bash', 'git'])).toEqual(['Bash'])
  })
  it('ignores unknown ids', () => {
    expect(claudeAllowedTools(['read', 'nope'])).toEqual(['Read'])
  })
})

describe('skillDirective', () => {
  it('returns empty string for no skills', () => { expect(skillDirective([])).toBe('') })
  it('lists skills as an authoritative directive', () => {
    const d = skillDirective(['code-review', 'analyze'])
    expect(d).toContain('code-review'); expect(d).toContain('analyze')
  })
})

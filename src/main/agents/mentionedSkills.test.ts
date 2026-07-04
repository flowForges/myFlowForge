import { describe, it, expect } from 'vitest'
import { mentionedSkills } from './contextMeta'

const installed = [
  { name: 'brainstorming', path: '/h/.claude/plugins/superpowers/skills/brainstorming/SKILL.md' },
  { name: 'critic', path: '/h/.codex/skills/critic/SKILL.md' },
  { name: 'systematic-debugging', path: '/h/.claude/skills/systematic-debugging/SKILL.md' },
]

describe('mentionedSkills', () => {
  it('matches a skill named next to "skill"/"技能" or quoted', () => {
    expect(mentionedSkills("I'll invoke the brainstorming skill.", installed).map(s => s.name)).toContain('brainstorming')
    expect(mentionedSkills('使用 brainstorming 技能来完成', installed).map(s => s.name)).toContain('brainstorming')
    expect(mentionedSkills('用「brainstorming」处理这个需求', installed).map(s => s.name)).toContain('brainstorming')
  })

  it('handles hyphenated skill names', () => {
    expect(mentionedSkills('run the systematic-debugging skill first', installed).map(s => s.name)).toContain('systematic-debugging')
  })

  it('does NOT false-match a bare common word without the skill keyword/quotes', () => {
    expect(mentionedSkills('the critic said the plan was risky', installed).map(s => s.name)).not.toContain('critic')
  })

  it('returns each matched skill once, with its installed path', () => {
    const r = mentionedSkills('brainstorming skill … 又用 brainstorming 技能', installed)
    expect(r).toHaveLength(1)
    expect(r[0].path).toBe(installed[0].path)
  })
})

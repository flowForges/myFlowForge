import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readInstalledSkills } from './installedSkills'

let home: string
beforeEach(() => { home = join(tmpdir(), 'skills-' + Math.random().toString(36).slice(2)); mkdirSync(home) })
afterEach(() => rmSync(home, { recursive: true, force: true }))

function writeSkill(dir: string, body: string) {
  mkdirSync(join(home, dir), { recursive: true })
  writeFileSync(join(home, dir, 'SKILL.md'), body)
}

describe('readInstalledSkills', () => {
  it('parses name/description from frontmatter and tags the source agent', () => {
    writeSkill('.claude/skills/code-review', '---\nname: code-review\ndescription: 审查 diff\n---\nbody')
    writeSkill('.codex/skills/security-review', '---\nname: security-review\ndescription: "扫描漏洞"\n---\n')
    const out = readInstalledSkills(home)
    expect(out).toEqual([
      { name: 'code-review', description: '审查 diff', source: 'Claude', path: join(home, '.claude/skills/code-review/SKILL.md') },
      { name: 'security-review', description: '扫描漏洞', source: 'Codex', path: join(home, '.codex/skills/security-review/SKILL.md') },
    ])
  })

  it('finds nested skills and falls back to the dir name when frontmatter is missing', () => {
    writeSkill('.claude/skills/pack/skills/corporate', '---\ndescription: nested\n---')
    writeSkill('.agents/skills/plain', 'no frontmatter here')
    const out = readInstalledSkills(home)
    expect(out.find(s => s.path.includes('corporate'))?.name).toBe('corporate') // dir-name fallback
    expect(out.find(s => s.source === 'Agents')?.name).toBe('plain')
  })

  it('returns empty when no skill dirs exist', () => {
    expect(readInstalledSkills(home)).toEqual([])
  })
})

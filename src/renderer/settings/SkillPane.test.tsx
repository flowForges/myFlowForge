import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { SkillPane } from './SkillPane'
import type { InstalledSkill } from '@shared/types'

const SKILLS: InstalledSkill[] = [
  { name: 'code-review', description: '审查 diff', source: 'Claude', path: '~/.claude/skills/code-review/SKILL.md' },
  { name: 'security-review', description: '', source: 'Codex', path: '~/.codex/skills/security-review/SKILL.md' },
]

beforeEach(() => {
  ;(window as any).forge = { listSkills: vi.fn(async () => SKILLS) }
})

describe('SkillPane', () => {
  it('lists real installed skills grouped by source, read-only (no toggle)', async () => {
    const { container } = render(<SkillPane />)
    expect(await screen.findByText('code-review')).toBeInTheDocument()
    expect(screen.getByText('security-review')).toBeInTheDocument()
    expect(screen.getByText('审查 diff')).toBeInTheDocument()
    // grouped headers with counts
    expect(screen.getByText('Claude · 1')).toBeInTheDocument()
    expect(screen.getByText('Codex · 1')).toBeInTheDocument()
    // no enable/disable toggles anymore
    expect(container.querySelector('.toggle')).toBeNull()
  })

  it('shows an empty state when nothing is installed', async () => {
    ;(window as any).forge = { listSkills: vi.fn(async () => []) }
    render(<SkillPane />)
    await waitFor(() => expect(screen.getByText(/未发现已安装的 skill/)).toBeInTheDocument())
  })
})

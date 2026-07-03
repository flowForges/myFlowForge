import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AgentContextMeta } from './AgentContextMeta'

describe('AgentContextMeta', () => {
  it('renders prototype context items for skills, rules and MCP servers', () => {
    const { container } = render(<AgentContextMeta context={{ skills: [{ name: 'forge-workflow', path: '.claude/skills/forge-workflow/SKILL.md' }], rules: [{ name: 'AGENTS.md', path: 'AGENTS.md' }], mcps: [{ name: 'forge', path: 'mcp://forge' }] }} />)

    expect(container.querySelector('.ctx-stack')).toBeTruthy()
    expect(screen.getByText('Skill')).toBeInTheDocument()
    expect(screen.getByText('forge-workflow')).toBeInTheDocument()
    expect(screen.getByText('Rule')).toBeInTheDocument()
    expect(screen.getAllByText('AGENTS.md')).toHaveLength(1)
    expect(screen.getByText('MCP')).toBeInTheDocument()
    expect(screen.getByText('forge')).toBeInTheDocument()
    expect(screen.getAllByText('已加载')).toHaveLength(3)
    expect(screen.getByText('.claude/skills/forge-workflow/SKILL.md')).toBeInTheDocument()
  })

  it('supports the compact agent-log variant', () => {
    const { container } = render(<AgentContextMeta mini context={{ skills: [{ name: 'planner', path: 'x' }], rules: [] }} />)
    expect(container.querySelector('.ctx-mini')).toBeTruthy()
  })
})

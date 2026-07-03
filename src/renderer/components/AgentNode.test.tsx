import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { AgentNode } from './AgentNode'

describe('AgentNode', () => {
  it('shows name/state and toggles the execution log on click', () => {
    render(<AgentNode agent={{ id: 'a1', name: 'Explorer', role: '扫描引用', provider: 'claude', model: 'haiku-4.5', state: 'ok', logs: [{ ts: '09:42:01', text: '生成引用图谱', level: 'ok' }] }} />)
    expect(screen.getByText('Explorer')).toBeInTheDocument()
    expect(screen.queryByText('生成引用图谱')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Explorer/ }))
    expect(screen.getByText('生成引用图谱')).toBeInTheDocument()
  })

  it('wraps the log lines in a fixed-height scroll container so parallel cards stay compact', () => {
    const { container } = render(
      <AgentNode agent={{ id: 'a1', name: 'Explorer', role: 'r', provider: 'claude', model: 'haiku-4.5', state: 'ok', logs: [{ ts: '09:42:01', text: '一行输出', level: 'ok' }] }} open onToggle={() => {}} />,
    )
    const scroll = container.querySelector('.agent-log-lines')
    expect(scroll).toBeTruthy()
    expect(scroll?.querySelector('.log-line')?.textContent).toContain('一行输出')
  })

  it('renders a 在日志台查看 button that calls onViewLog (opens the bottom drawer for this agent)', () => {
    const onViewLog = vi.fn()
    render(
      <AgentNode agent={{ id: 'a1', name: 'Explorer', role: 'r', provider: 'claude', model: 'haiku-4.5', state: 'run', logs: [] }} open onToggle={() => {}} onViewLog={onViewLog} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /日志台/ }))
    expect(onViewLog).toHaveBeenCalledTimes(1)
  })

  it('omits the 在日志台查看 button when onViewLog is not provided', () => {
    render(<AgentNode agent={{ id: 'a1', name: 'Explorer', role: 'r', provider: 'claude', model: 'haiku-4.5', state: 'run', logs: [] }} open onToggle={() => {}} />)
    expect(screen.queryByRole('button', { name: /日志台/ })).not.toBeInTheDocument()
  })

  it('shows agent skills, rules and MCP metadata', () => {
    render(<AgentNode agent={{ id: 'a1', name: 'Explorer', role: '扫描引用', provider: 'claude', model: 'haiku-4.5', state: 'run', logs: [], context: { skills: [{ name: 'planner', path: '.codex/skills/planner/SKILL.md' }], rules: [{ name: 'AGENTS.md', path: 'AGENTS.md' }], mcps: [{ name: 'forge', path: 'mcp://forge' }] } } as any} />)
    expect(screen.getByText('3 项上下文')).toBeInTheDocument()
    expect(screen.getByText('已加载 Skill / Rule / MCP')).toBeInTheDocument()
    expect(screen.getByText('Skill')).toBeInTheDocument()
    expect(screen.getByText('planner')).toBeInTheDocument()
    expect(screen.getByText('Rule')).toBeInTheDocument()
    expect(screen.getByText('MCP')).toBeInTheDocument()
    expect(screen.getByText('forge')).toBeInTheDocument()
    expect(screen.getAllByText('AGENTS.md')).toHaveLength(1)
  })
})

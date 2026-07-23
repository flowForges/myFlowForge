import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SubagentCards } from './SubagentCards'
import type { SubagentCard } from '@shared/types'

describe('SubagentCards', () => {
  it('renders one collapsed card per sub-agent with a state pill (live turn shows 运行中)', () => {
    const subs: SubagentCard[] = [
      { id: 'a', state: 'running', subagentType: 'Explore', description: '探查鉴权' },
      { id: 'b', state: 'done', subagentType: 'Explore', result: '结果 X' },
    ]
    render(<SubagentCards subagents={subs} live />)
    expect(screen.getByText(/探查鉴权/)).toBeInTheDocument()
    expect(screen.getByText('运行中')).toBeInTheDocument()
    expect(screen.getByText('已完成')).toBeInTheDocument()
    // collapsed by default: result not shown until expanded
    expect(screen.queryByText('结果 X')).toBeNull()
  })

  it('on a settled (non-live) message a stale running card renders as 已完成, never 运行中', () => {
    // A persisted/reloaded message can never have a genuinely-running sub-agent: the turn is over, so
    // the sub-agent is too. A 'running' state there is a lost terminal event — show it ended.
    const subs: SubagentCard[] = [{ id: 'a', state: 'running', subagentType: 'Explore', description: '探查鉴权' }]
    render(<SubagentCards subagents={subs} />)
    expect(screen.queryByText('运行中')).toBeNull()
    expect(screen.getByText('已完成')).toBeInTheDocument()
  })

  it('expands to reveal the task prompt and result on click', () => {
    const subs: SubagentCard[] = [{ id: 'a', state: 'done', subagentType: 'Explore', prompt: '摸清现状', result: '鉴权走 src/auth' }]
    render(<SubagentCards subagents={subs} />)
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('摸清现状')).toBeInTheDocument()
    expect(screen.getByText('鉴权走 src/auth')).toBeInTheDocument()
  })

  it('renders nothing for an empty list', () => {
    const { container } = render(<SubagentCards subagents={[]} />)
    expect(container.firstChild).toBeNull()
  })
})

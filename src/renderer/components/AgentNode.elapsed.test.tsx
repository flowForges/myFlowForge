// Improvement ⑥: per-lane (per-project) execution timing chip on the agent card. Mirrors
// AgentNode.heartbeat.test.tsx's structure/fixture (`mk`) for the sibling `.agent-elapsed` chip.
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AgentNode } from './AgentNode'
import type { AgentRuntime } from '@shared/types'

const mk = (state: AgentRuntime['state']): AgentRuntime => ({
  id: 'a1',
  name: '开发代理',
  role: '开发',
  provider: 'claude',
  model: 'opus-4.8',
  state,
  logs: [],
})

describe('AgentNode per-lane elapsed timing', () => {
  it('renders no elapsed chip when the lane has not started yet (no laneStartedAt)', () => {
    const { container } = render(<AgentNode agent={mk('wait')} />)
    expect(container.querySelector('.agent-elapsed')).toBeNull()
  })

  it('shows a frozen total for a settled (done) lane: endedAt - startedAt, not time-since-now', () => {
    const agent: AgentRuntime = { ...mk('ok'), laneStartedAt: 1_000, laneEndedAt: 73_000 } // 72s = 1m 12s
    const { container } = render(<AgentNode agent={agent} />)
    expect(container.querySelector('.agent-elapsed')).toHaveTextContent('1m 12s')
  })

  it('shows elapsed-so-far for a still-running lane (no laneEndedAt) computed against now', () => {
    const agent: AgentRuntime = { ...mk('run'), laneStartedAt: Date.now() - 45_000 }
    const { container } = render(<AgentNode agent={agent} />)
    expect(container.querySelector('.agent-elapsed')).toHaveTextContent('45s')
  })

  it('renders both the elapsed chip and the heartbeat chip together when both are present', () => {
    const agent: AgentRuntime = { ...mk('run'), laneStartedAt: Date.now() - 5_000, lastBeat: Date.now() - 8_000 }
    render(<AgentNode agent={agent} />)
    expect(screen.getByText('5s')).toBeTruthy()
    expect(screen.getByText('心跳 8s 前')).toBeTruthy()
  })
})

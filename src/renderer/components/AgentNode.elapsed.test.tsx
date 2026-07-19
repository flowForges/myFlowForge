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

  // Important fix: a lane with no laneEndedAt persisted from a hard-killed run (app crash mid-lane)
  // is non-terminal and re-surfaces in read-only run-history replay. There, ticking against
  // Date.now() would render a nonsense "minutes since the crash" duration. `live={false}` (the
  // signal RunExecPanel threads down for its staticState/readOnly replay path) must show a plain
  // 未完成 marker instead, never a bogus computed duration.
  it('read-only (live=false) with no laneEndedAt shows 未完成, not a time-since-now duration', () => {
    const longAgo = Date.now() - 18_732 * 60_000 // simulate an app crash a long time ago
    const agent: AgentRuntime = { ...mk('run'), laneStartedAt: longAgo }
    const { container } = render(<AgentNode agent={agent} live={false} />)
    expect(container.querySelector('.agent-elapsed')).toHaveTextContent('未完成')
    expect(container.querySelector('.agent-elapsed')?.textContent).not.toMatch(/\d+m/)
  })

  it('live (default) with no laneEndedAt still ticks elapsed-so-far against now', () => {
    const agent: AgentRuntime = { ...mk('run'), laneStartedAt: Date.now() - 45_000 }
    const { container } = render(<AgentNode agent={agent} live />)
    expect(container.querySelector('.agent-elapsed')).toHaveTextContent('45s')
  })

  it('a settled (done) lane shows its frozen total regardless of live/read-only', () => {
    const agent: AgentRuntime = { ...mk('ok'), laneStartedAt: 1_000, laneEndedAt: 73_000 }
    const { container } = render(<AgentNode agent={agent} live={false} />)
    expect(container.querySelector('.agent-elapsed')).toHaveTextContent('1m 12s')
  })
})

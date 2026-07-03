import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { AgentNode } from './AgentNode'
import type { AgentRuntime } from '@shared/types'

const base: Omit<AgentRuntime, 'ctxPct' | 'ctxMax'> = {
  id: 'a1', name: 'Coder', role: '写代码', provider: 'claude', model: 'sonnet',
  state: 'run', logs: [],
}

// The context-usage bar is TEMPORARILY HIDDEN: the computed占用 (input+cache_read peak ÷ flat 200K)
// saturated to 100%/接近上限 on every agent and misled users. Until a faithful real-context reading
// lands, AgentNode must never render `.agent-ctx` — regardless of ctxPct/ctxMax.
describe('AgentNode context-usage bar (hidden)', () => {
  it('does not render the bar even when ctxPct/ctxMax are set (danger range)', () => {
    const { container } = render(<AgentNode open onToggle={() => {}} agent={{ ...base, ctxPct: 92, ctxMax: 200 }} />)
    expect(container.querySelector('.agent-ctx')).toBeNull()
  })

  it('does not render the bar at a mid-range percentage', () => {
    const { container } = render(<AgentNode open onToggle={() => {}} agent={{ ...base, ctxPct: 50, ctxMax: 200 }} />)
    expect(container.querySelector('.agent-ctx')).toBeNull()
  })

  it('does not render the bar when ctxPct is undefined', () => {
    const { container } = render(<AgentNode open onToggle={() => {}} agent={{ ...base }} />)
    expect(container.querySelector('.agent-ctx')).toBeNull()
  })
})

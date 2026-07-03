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

describe('AgentNode stalled/awaiting', () => {
  it('renders 疑似卡住 label + st-stalled class for stalled', () => {
    const { container } = render(<AgentNode agent={mk('stalled')} />)
    expect(screen.getByText('疑似卡住')).toBeTruthy()
    expect(container.querySelector('.st-stalled')).toBeTruthy()
  })

  it('renders 等待确认 label + st-awaiting class for awaiting', () => {
    const { container } = render(<AgentNode agent={mk('awaiting')} />)
    expect(screen.getByText('等待确认')).toBeTruthy()
    expect(container.querySelector('.st-awaiting')).toBeTruthy()
  })

  it('renders the latest heartbeat age for a running agent', () => {
    const { container } = render(<AgentNode agent={{ ...mk('run'), lastBeat: Date.now() - 8_000 }} />)

    expect(container).toHaveTextContent('心跳 8s 前')
  })
})

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SetupProgress } from './SetupProgress'
import type { SetupProgressState } from './SetupProgress'

describe('SetupProgress', () => {
  it('renders basic hooks, provisioned projects, proj hooks, and done indicator from accumulated state', () => {
    const state: SetupProgressState = {
      started: true,
      done: true,
      basicHooks: [
        {
          id: 'plugin-a',
          name: 'Plugin A',
          phase: '__basic',
          state: 'ok',
          logs: [{ ts: '10:00:00', text: 'basic hook ran', level: 'ok' }],
          skills: [],
          tools: [],
        },
      ],
      projHooks: [
        {
          id: 'plugin-b',
          name: 'Plugin B',
          phase: '__proj',
          state: 'wait',
          logs: [],
          skills: [],
          tools: [],
        },
      ],
      provisionedProjects: [{ name: 'proj-x', index: 0, total: 1 }],
    }

    render(<SetupProgress state={state} />)

    // Both hook names visible
    expect(screen.getByText('Plugin A')).toBeInTheDocument()
    expect(screen.getByText('Plugin B')).toBeInTheDocument()

    // Provisioned project name visible
    expect(screen.getByText(/proj-x/)).toBeInTheDocument()

    // Done indicator visible (unique text from the setup-done div)
    expect(screen.getByText(/全部完成/)).toBeInTheDocument()
  })

  it('renders in-progress state without done indicator', () => {
    const state: SetupProgressState = {
      started: true,
      done: false,
      basicHooks: [
        {
          id: 'plugin-a',
          name: 'Plugin A',
          phase: '__basic',
          state: 'run',
          logs: [{ ts: '10:00:00', text: 'running…', level: 'info' }],
          skills: [],
          tools: [],
        },
      ],
      projHooks: [],
      provisionedProjects: [],
    }

    render(<SetupProgress state={state} />)

    expect(screen.getByText('Plugin A')).toBeInTheDocument()
    expect(screen.queryByText(/全部完成/)).not.toBeInTheDocument()
  })
})

import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { SessionIdsPanel } from './SessionIdsPanel'

it('lists agent session ids and copies one', async () => {
  ;(window as any).forge = { agentSessionIds: vi.fn(async () => ([
    { provider: 'claude', providerLabel: 'Claude Code', agentName: '主 Agent', sessionId: 'claude-abc', status: 'ok', lastActiveAt: '—' },
  ])) }
  const writeText = vi.fn()
  Object.assign(navigator, { clipboard: { writeText } })
  render(<SessionIdsPanel workspacePath="/w" sessionId="s1" archived={false} />)
  await waitFor(() => screen.getByText('claude-abc'))
  fireEvent.click(screen.getByText('复制'))
  expect(writeText).toHaveBeenCalledWith('claude-abc')
})

it('shows empty state when no agent sessions', async () => {
  ;(window as any).forge = { agentSessionIds: async () => [] }
  render(<SessionIdsPanel workspacePath="/w" sessionId="s1" archived={false} />)
  await waitFor(() => screen.getByText('当前会话还没有外部 Agent session。'))
})

it('shows the session context usage on the main Agent row for the matching provider', async () => {
  ;(window as any).forge = { agentSessionIds: async () => ([
    { provider: 'claude', providerLabel: 'Claude Code', agentName: '主 Agent', sessionId: 'claude-abc', status: 'ok', lastActiveAt: '—' },
    { provider: 'codex', providerLabel: 'Codex', agentName: '主 Agent', sessionId: 'codex-xyz', status: 'ok', lastActiveAt: '—' },
  ]) }
  render(<SessionIdsPanel workspacePath="/w" sessionId="s1" archived={false} usageByProvider={{ claude: { used: 128000, window: 200000 } }} />)
  await waitFor(() => screen.getByText('claude-abc'))
  // claude row shows its usage; codex (no reported usage) shows none.
  expect(screen.getByText('128,000')).toBeInTheDocument()
  expect(screen.getAllByText(/上下文/).length).toBe(1)
})

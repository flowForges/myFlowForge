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

// ★刹车:上下文用量**已经从界面上整个撤掉了**(2026-09-16,用户:「我用 opus,你显示 200k,
//  太不准了 —— 干脆都去掉吧」)。原始 token 数仍然记在 `ChatMessage.usage` 上,所以想把它
//  画回来随时办得到 —— 这条测试就是拦住那个「随手加回来」的。要再上,先跟用户对齐口径。
it('never shows context usage — it was removed for being misleading', async () => {
  ;(window as any).forge = { agentSessionIds: async () => ([
    { provider: 'claude', providerLabel: 'Claude Code', agentName: '主 Agent', sessionId: 'claude-abc', status: 'ok', lastActiveAt: '—' },
  ]) }
  render(<SessionIdsPanel workspacePath="/w" sessionId="s1" archived={false} />)
  await waitFor(() => screen.getByText('claude-abc'))
  expect(screen.queryByText(/上下文/)).toBeNull()
})

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

// ★★这一行**留着**,而输入框里那枚圆环撤掉了(2026-09-16)。两处不是同一件事,别再一起删:
//  · 圆环回答「还装得下吗」—— 要百分比,而百分比要除以窗口大小,各家 CLI 口径不一,算出来不可信
//    (用户原话:「我用 opus,你显示 200k,太不准了」);
//  · 这一行回答「这个 agent 在这条会话里烧了多少」—— **只报原始 token 数**,那是 CLI 自己报的,
//    没有任何推算成分。用户明确要求保留:「ids 面板里的不能去掉呀」。
//  ★所以加百分比 / 加进度条 = 把这一行变成圆环,那正是被否掉的东西。
it('shows the session context usage on the main Agent row for the matching provider', async () => {
  ;(window as any).forge = { agentSessionIds: async () => ([
    { provider: 'claude', providerLabel: 'Claude Code', agentName: '主 Agent', sessionId: 'claude-abc', status: 'ok', lastActiveAt: '—' },
    { provider: 'codex', providerLabel: 'Codex', agentName: '主 Agent', sessionId: 'codex-xyz', status: 'ok', lastActiveAt: '—' },
  ]) }
  render(<SessionIdsPanel workspacePath="/w" sessionId="s1" archived={false} usageByProvider={{ claude: { used: 128000, window: 200000 } }} />)
  await waitFor(() => screen.getByText('claude-abc'))
  // claude 那行有用量;codex 没上报过,就什么都不显示 —— 不是显示 0。
  expect(screen.getByText('128,000')).toBeInTheDocument()
  expect(screen.getAllByText(/上下文/).length).toBe(1)
})

it('★只报原始 token 数,不出现百分比 —— 出现百分比就等于把被否掉的圆环搬了回来', async () => {
  ;(window as any).forge = { agentSessionIds: async () => ([
    { provider: 'claude', providerLabel: 'Claude Code', agentName: '主 Agent', sessionId: 'claude-abc', status: 'ok', lastActiveAt: '—' },
  ]) }
  render(<SessionIdsPanel workspacePath="/w" sessionId="s1" archived={false} usageByProvider={{ claude: { used: 128000, window: 200000 } }} />)
  await waitFor(() => screen.getByText('claude-abc'))
  expect(document.body.textContent).not.toMatch(/\d+\s*%/)
})

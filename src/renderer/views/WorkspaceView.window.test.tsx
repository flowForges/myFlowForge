import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { WorkspaceView } from './WorkspaceView'
import { LIVE_WINDOW, LIVE_WINDOW_STEP } from './chat/timelineWindow'
import type { EngineApi } from '../state/useEngine'
import type { ProviderInfo, SessionsFile, ChatMessage } from '@shared/types'

// 2026-10-03「点开会话都要加载一下」:当前这条对话原来是**整条时间线一次性渲染**。
// 这里证明窗口真的接上了 —— 不是只在 timelineWindow 的单测里对,界面上没用上。
const providers: ProviderInfo[] = [{ id: 'claude', displayName: 'Claude Code', installed: true, models: [{ id: 'opus-4.8', label: 'opus-4.8' }] }]
const engine: EngineApi = { run: undefined, pending: [], resolve: vi.fn(), cancel: vi.fn() } as any
const TOTAL = LIVE_WINDOW + 25
const longHistory: ChatMessage[] = Array.from({ length: TOTAL }, (_, i) => ({
  id: `m${i}`, who: i % 2 === 0 ? 'user' : 'ai', text: `第${i}条`,
  ts: new Date(1_700_000_000_000 + i * 1000).toISOString(),
})) as ChatMessage[]
const file: SessionsFile = { sessions: [{ id: 's1', title: '长会话', mode: 'chat', createdAt: 0 }], activeSessionId: 's1' }

beforeEach(() => {
  ;(window as any).forge = {
    sessionList: vi.fn(async () => file),
    sessionSwitch: vi.fn(async () => file),
    sessionNew: vi.fn(async () => file),
    sessionClose: vi.fn(async () => file),
    sessionRename: vi.fn(async () => file),
    chatHistory: vi.fn(async () => longHistory),
    chatToolOutput: vi.fn(async () => ({ output: '' })),
    sendChat: vi.fn(async () => ({})),
    onChatEvent: () => () => {},
    onChatQueueEvent: () => () => {},
    chatCancelQueued: vi.fn(async () => ({})),
    chatClearQueue: vi.fn(async () => ({})),
    lastRun: vi.fn(async () => null),
    getWorkspace: vi.fn(async () => ({ projects: [{ branch: 'main' }], stages: [{ key: 'develop', provider: 'claude', model: 'opus-4.8' }] })),
    changesMulti: vi.fn(async () => ({ total: 0, add: 0, del: 0, byProject: [] })),
    watchChanges: vi.fn(async () => []),
    watchStop: vi.fn(async () => undefined),
    fsTree: vi.fn(async () => []),
    onChangesEvent: vi.fn(() => () => {}),
    savePaste: vi.fn(async () => ({})),
  }
})

// ★只在对话正文里找:左侧跳转轨道(ChatJumpRail)会给每条用户消息渲染一份**预览文字**,
//   直接用 screen 找会同时命中那一份,报「找到多个」。
const chat = (c: HTMLElement) => within(c.querySelector('.chat-inner') as HTMLElement)

describe('WorkspaceView — 当前对话只渲染最近 N 条', () => {
  it('★长会话:最早的那些不渲染,按钮说清楚还藏着几条', async () => {
    const { container } = render(<WorkspaceView engine={engine} providers={providers} workspacePath="/ws" />)
    await waitFor(() => expect(chat(container).getByText(`第${TOTAL - 1}条`)).toBeTruthy(), { timeout: 15_000 })
    expect(chat(container).queryByText('第0条')).toBeNull()                       // 修前:这条也会被渲染出来
    expect(chat(container).getByText(`第${TOTAL - LIVE_WINDOW}条`)).toBeTruthy()  // 窗口里最早的那条在
    expect(chat(container).queryByText(`第${TOTAL - LIVE_WINDOW - 1}条`)).toBeNull()
    expect(screen.getByRole('button', { name: `加载更早 ${TOTAL - LIVE_WINDOW} 条` })).toBeTruthy()
  }, 60_000)

  it('点「加载更早」把更早的放出来;放完之后按钮消失', async () => {
    const { container } = render(<WorkspaceView engine={engine} providers={providers} workspacePath="/ws" />)
    const btn = await screen.findByRole('button', { name: `加载更早 ${TOTAL - LIVE_WINDOW} 条` }, { timeout: 15_000 })
    fireEvent.click(btn)
    // 一步放出 LIVE_WINDOW_STEP 条,这里一步就够把 25 条全放出来
    expect(TOTAL - LIVE_WINDOW).toBeLessThanOrEqual(LIVE_WINDOW_STEP)
    await waitFor(() => expect(chat(container).getByText('第0条')).toBeTruthy(), { timeout: 15_000 })
    expect(screen.queryByRole('button', { name: /加载更早/ })).toBeNull()
  }, 60_000)

  it('不长的会话不出按钮,一条不少(日常对话一个像素都不变)', async () => {
    const short = longHistory.slice(0, LIVE_WINDOW)
    ;(window as any).forge.chatHistory = vi.fn(async () => short)
    const { container } = render(<WorkspaceView engine={engine} providers={providers} workspacePath="/ws" />)
    await waitFor(() => expect(chat(container).getByText('第0条')).toBeTruthy(), { timeout: 15_000 })
    expect(screen.queryByRole('button', { name: /加载更早/ })).toBeNull()
  }, 60_000)
})

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { SessionTabs } from './SessionTabs'
import type { ChatSession } from '@shared/types'

const sessions: ChatSession[] = [
  { id: 's1', title: '绑定的会话', mode: 'chat', createdAt: 0 },
  { id: 's2', title: '另一个', mode: 'chat', createdAt: 1 },
]
const flush = async () => { for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve() }) }

describe('SessionTabs · 在 App 中继续', () => {
  let targets: ReturnType<typeof vi.fn>
  let handoff: ReturnType<typeof vi.fn>
  beforeEach(() => {
    targets = vi.fn(async () => [{ agent: 'codex', app: 'Codex', disabled: false }, { agent: 'claude', app: 'Claude', disabled: true }])
    handoff = vi.fn(async () => ({ ok: true, id: 'th-1', app: 'Codex' }))
    ;(window as any).forge = { sessionHandoffTargets: targets, sessionHandoff: handoff }
  })
  afterEach(() => { vi.useRealTimers(); delete (window as any).forge })

  const renderTabs = (over: object = {}) => render(
    <SessionTabs sessions={sessions} activeSessionId="s1" onSwitch={() => {}} onClose={() => {}} onRename={() => {}} onNew={() => {}} workspacePath="/ws/a" {...over} />,
  )

  it('right-click a tab: one item per available app, disabled while our turn runs', async () => {
    renderTabs()
    fireEvent.contextMenu(screen.getByText('另一个'))
    await flush()
    expect(targets).toHaveBeenCalledWith({ workspacePath: '/ws/a', sessionId: 's2' })
    const codex = screen.getByRole('menuitem', { name: '在 Codex 中继续' })
    const claude = screen.getByRole('menuitem', { name: '在 Claude 中继续' })
    expect((codex as HTMLButtonElement).disabled).toBe(false)
    expect((claude as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByText(/Qoder/)).toBeNull()
  })

  it('picking an app hands the session over and shows 已复制会话 ID for 2 s', async () => {
    renderTabs()
    fireEvent.contextMenu(screen.getByText('绑定的会话'))
    await flush()
    vi.useFakeTimers()
    fireEvent.click(screen.getByRole('menuitem', { name: '在 Codex 中继续' }))
    await flush()
    expect(handoff).toHaveBeenCalledWith({ workspacePath: '/ws/a', sessionId: 's1', agent: 'codex' })
    expect(screen.queryByRole('menuitem')).toBeNull()
    expect(screen.getByText('已复制会话 ID')).toBeTruthy()
    await act(async () => { vi.advanceTimersByTime(2000) })
    expect(screen.queryByText('已复制会话 ID')).toBeNull()
  })

  it('a failed hand-off shows no chip', async () => {
    handoff.mockResolvedValueOnce({ ok: false, code: 'open_failed' })
    renderTabs()
    fireEvent.contextMenu(screen.getByText('绑定的会话'))
    await flush()
    fireEvent.click(screen.getByRole('menuitem', { name: '在 Codex 中继续' }))
    await flush()
    expect(screen.queryByText('已复制会话 ID')).toBeNull()
  })

  it('no bound app (or app missing): no menu at all', async () => {
    targets.mockResolvedValueOnce([])
    renderTabs()
    fireEvent.contextMenu(screen.getByText('绑定的会话'))
    await flush()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('archived workspace: no hand-off lookup', async () => {
    renderTabs({ archived: true })
    fireEvent.contextMenu(screen.getByText('绑定的会话'))
    await flush()
    expect(targets).not.toHaveBeenCalled()
  })
})

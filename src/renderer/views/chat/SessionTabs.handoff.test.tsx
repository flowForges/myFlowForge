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

  it('keyboard: ContextMenu / Shift+F10 on a focused tab opens the menu; arrows move, Escape closes back to the tab', async () => {
    targets.mockImplementation(async () => [{ agent: 'codex', app: 'Codex', disabled: false }, { agent: 'claude', app: 'Claude', disabled: false }])
    renderTabs()
    const tab = screen.getByText('另一个').closest('button')!
    expect(tab.getAttribute('aria-haspopup')).toBe('menu')
    tab.focus()
    fireEvent.keyDown(tab, { key: 'F10', shiftKey: true })
    await flush()
    expect(targets).toHaveBeenCalledWith({ workspacePath: '/ws/a', sessionId: 's2' })
    const [codex, claude] = screen.getAllByRole('menuitem')
    expect(document.activeElement).toBe(codex)
    fireEvent.keyDown(codex, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(claude)
    fireEvent.keyDown(claude, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(codex)
    fireEvent.keyDown(codex, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(claude)
    fireEvent.keyDown(claude, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(tab)
    fireEvent.keyDown(tab, { key: 'ContextMenu' })
    await flush()
    expect(screen.getByRole('menu')).toBeTruthy()
  })

  it('arrow keys skip disabled items', async () => {
    targets.mockResolvedValueOnce([{ agent: 'codex', app: 'Codex', disabled: true }, { agent: 'claude', app: 'Claude', disabled: false }, { agent: 'qoder', app: 'Qoder', disabled: false }])
    renderTabs()
    fireEvent.keyDown(screen.getByText('绑定的会话').closest('button')!, { key: 'ContextMenu' })
    await flush()
    const items = screen.getAllByRole('menuitem')
    expect(document.activeElement).toBe(items[1])
    fireEvent.keyDown(items[1], { key: 'ArrowDown' })
    fireEvent.keyDown(items[2], { key: 'ArrowDown' })
    expect(document.activeElement).toBe(items[1])
  })

  it('a stale targets answer (a later right-click superseded it) is ignored', async () => {
    let first!: (v: any) => void
    targets.mockImplementationOnce(() => new Promise(r => { first = r }))
    targets.mockImplementationOnce(async () => [{ agent: 'claude', app: 'Claude', disabled: false }])
    renderTabs()
    fireEvent.contextMenu(screen.getByText('绑定的会话'))
    fireEvent.contextMenu(screen.getByText('另一个'))
    await flush()
    first([{ agent: 'codex', app: 'Codex', disabled: false }])
    await flush()
    expect(screen.queryByRole('menuitem', { name: '在 Codex 中继续' })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: '在 Claude 中继续' }))
    await flush()
    expect(handoff).toHaveBeenCalledWith({ workspacePath: '/ws/a', sessionId: 's2', agent: 'claude' })
  })

  it('every item disabled: the menu itself takes focus, so Escape / Tab still close it back to the tab', async () => {
    targets.mockResolvedValue([{ agent: 'codex', app: 'Codex', disabled: true }])
    renderTabs()
    const tab = screen.getByText('另一个').closest('button')!
    tab.focus()
    fireEvent.keyDown(tab, { key: 'ContextMenu' })
    await flush()
    const menu = screen.getByRole('menu')
    expect(document.activeElement).toBe(menu)
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(tab)
    fireEvent.keyDown(tab, { key: 'ContextMenu' })
    await flush()
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('re-opening the menu for another tab focuses that menu\'s first item; a keyboard pick returns focus to the tab', async () => {
    targets.mockImplementation(async ({ sessionId }: any) => sessionId === 's1'
      ? [{ agent: 'codex', app: 'Codex', disabled: false }]
      : [{ agent: 'claude', app: 'Claude', disabled: false }])
    renderTabs()
    const t1 = screen.getByText('绑定的会话').closest('button')!
    const t2 = screen.getByText('另一个').closest('button')!
    fireEvent.keyDown(t1, { key: 'ContextMenu' })
    await flush()
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: '在 Codex 中继续' }))
    t2.focus()
    fireEvent.keyDown(t2, { key: 'ContextMenu' })
    await flush()
    const claude = screen.getByRole('menuitem', { name: '在 Claude 中继续' })
    expect(document.activeElement).toBe(claude)
    fireEvent.click(claude)
    await flush()
    expect(handoff).toHaveBeenCalledWith({ workspacePath: '/ws/a', sessionId: 's2', agent: 'claude' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(t2)
  })
})

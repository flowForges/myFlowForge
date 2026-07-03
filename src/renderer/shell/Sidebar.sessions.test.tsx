import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Sidebar } from './Sidebar'
import type { ChatSession } from '@shared/types'

const sessions: ChatSession[] = [
  { id: 's1', title: 'OKLch 迁移', mode: 'workflow', createdAt: 0 },
  { id: 's2', title: '新会话', mode: 'chat', createdAt: 1 },
]

describe('Sidebar session list', () => {
  it('renders current workspace sessions and routes switch/close/new actions', () => {
    const onSwitchSession = vi.fn()
    const onCloseSession = vi.fn()
    const onRenameSession = vi.fn()
    const onNewSession = vi.fn()
    const wsId = '/ws'
    render(
      <Sidebar
        groups={[{ key: 'g', label: '最近', items: [{ id: wsId, name: '工作区', sub: '2 projects', status: 'wait' }] }]}
        activeId={wsId}
        onSelect={() => {}}
        onNew={() => {}}
        collapsed={false}
        sessions={sessions}
        activeSessionId="s1"
        onSwitchSession={onSwitchSession}
        onCloseSession={onCloseSession}
        onRenameSession={onRenameSession}
        onNewSession={onNewSession}
        expandedIds={new Set([wsId])}
        sessionsByWs={{ [wsId]: sessions }}
      />
    )

    expect(screen.getByText('OKLch 迁移')).toBeTruthy()
    expect(screen.getByText('新会话')).toBeTruthy()
    expect(document.querySelectorAll('.ws-sess')).toHaveLength(2)
    expect(screen.getByText('新建会话')).toBeTruthy()

    fireEvent.click(screen.getByText('新会话'))
    expect(onSwitchSession).toHaveBeenCalledWith(wsId, 's2')
    fireEvent.click(screen.getAllByTitle('关闭会话')[1])
    expect(onCloseSession).toHaveBeenCalledWith('s2')
    fireEvent.click(screen.getByText('新建会话'))
    expect(onNewSession).toHaveBeenCalled()

    fireEvent.doubleClick(screen.getByText('新会话'))
    const input = screen.getByDisplayValue('新会话')
    fireEvent.change(input, { target: { value: '方案讨论' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onRenameSession).toHaveBeenCalledWith('s2', '方案讨论')
  })
})

describe('Sidebar cross-workspace session switch', () => {
  it('passes the owning workspace id when clicking a session in a non-active workspace', () => {
    const onSwitchSession = vi.fn()
    const wsA = '/ws/a'
    const wsB = '/ws/b'
    const sessB: ChatSession[] = [{ id: 'b1', title: 'B 会话', mode: 'chat', createdAt: 0 }]
    render(
      <Sidebar
        groups={[{ key: 'g', label: '全部', items: [
          { id: wsA, name: 'A', sub: '', status: 'wait' },
          { id: wsB, name: 'B', sub: '', status: 'wait' },
        ] }]}
        activeId={wsA}
        onSelect={() => {}}
        onNew={() => {}}
        collapsed={false}
        sessions={[]}
        activeSessionId="a1"
        onSwitchSession={onSwitchSession}
        // both workspaces expanded; clicking B's session must route to wsB, not the active wsA
        expandedIds={new Set([wsA, wsB])}
        sessionsByWs={{ [wsA]: [{ id: 'a1', title: 'A 会话', mode: 'chat', createdAt: 0 }], [wsB]: sessB }}
      />
    )
    fireEvent.click(screen.getByText('B 会话'))
    expect(onSwitchSession).toHaveBeenCalledWith(wsB, 'b1')
  })
})

describe('Sidebar imported marker', () => {
  it('renders an import icon (not a text badge) for imported workspaces', () => {
    const { container } = render(
      <Sidebar
        groups={[{ key: 'recent', label: '最近', items: [
          { id: '/x', name: 'X', sub: '本机导入', status: 'wait', imported: true },
        ] }]}
        activeId="/x"
        onSelect={() => {}}
        onNew={() => {}}
        collapsed={false}
        sessions={[]}
      />
    )
    // 突兀的「导入」文字徽章已移除，改为名字旁的小图标
    expect(screen.queryByText('导入')).toBeNull()
    expect(container.querySelector('.ws-imp-ico')).toBeTruthy()
  })
})

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SessionTabs } from './SessionTabs'
import type { ChatSession } from '@shared/types'

const sessions: ChatSession[] = [
  { id: 's1', title: 'OKLch 迁移', mode: 'workflow', createdAt: 0 },
  { id: 's2', title: '新会话', mode: 'chat', createdAt: 1 },
]

describe('SessionTabs', () => {
  it('renders a tab per session, marks active, shows close only when >1', () => {
    render(<SessionTabs sessions={sessions} activeSessionId="s1" onSwitch={() => {}} onClose={() => {}} onRename={() => {}} onNew={() => {}} />)
    expect(screen.getByText('OKLch 迁移')).toBeTruthy()
    expect(screen.getByText('新会话')).toBeTruthy()
    expect(screen.getAllByTitle('关闭会话')).toHaveLength(2)
  })
  it('single session hides close buttons', () => {
    render(<SessionTabs sessions={[sessions[0]]} activeSessionId="s1" onSwitch={() => {}} onClose={() => {}} onRename={() => {}} onNew={() => {}} />)
    expect(screen.queryByTitle('关闭会话')).toBeNull()
  })
  it('fires onSwitch / onClose / onNew', () => {
    const onSwitch = vi.fn(), onClose = vi.fn(), onNew = vi.fn()
    render(<SessionTabs sessions={sessions} activeSessionId="s1" onSwitch={onSwitch} onClose={onClose} onRename={() => {}} onNew={onNew} />)
    fireEvent.click(screen.getByText('新会话')); expect(onSwitch).toHaveBeenCalledWith('s2')
    fireEvent.click(screen.getAllByTitle('关闭会话')[1]); expect(onClose).toHaveBeenCalledWith('s2')
    fireEvent.click(screen.getByTitle('新建会话')); expect(onNew).toHaveBeenCalled()
  })

  it('renames a session from its tab', () => {
    const onRename = vi.fn()
    render(<SessionTabs sessions={sessions} activeSessionId="s1" onSwitch={() => {}} onClose={() => {}} onRename={onRename} onNew={() => {}} />)
    fireEvent.doubleClick(screen.getByText('新会话'))
    const input = screen.getByDisplayValue('新会话')
    fireEvent.change(input, { target: { value: '接口联调' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onRename).toHaveBeenCalledWith('s2', '接口联调')
  })
})

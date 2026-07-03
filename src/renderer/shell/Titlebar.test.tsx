import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Titlebar } from './Titlebar'

const base = {
  collapsed: false, onToggleSidebar: () => {}, onView: () => {}, crumb: 'ws-a',
  notifs: [], updateAvailable: false, notifOpen: false, onToggleNotif: () => {},
  onOpenUpgrade: () => {}, onMarkAllRead: () => {},
}

describe('Titlebar – edit workspace button', () => {
  it('shows the edit button only in ws view when editable', () => {
    const { rerender } = render(<Titlebar {...base} view="home" canEditWorkspace onEditWorkspace={() => {}} />)
    expect(screen.queryByTitle(/编辑工作区/)).toBeNull()
    rerender(<Titlebar {...base} view="ws" canEditWorkspace onEditWorkspace={() => {}} />)
    expect(screen.getByTitle(/编辑工作区/)).toBeInTheDocument()
  })

  it('does not show the edit button in ws view when not editable', () => {
    render(<Titlebar {...base} view="ws" canEditWorkspace={false} onEditWorkspace={() => {}} />)
    expect(screen.queryByTitle(/编辑工作区/)).toBeNull()
  })

  it('calls onEditWorkspace when clicked', () => {
    const onEditWorkspace = vi.fn()
    render(<Titlebar {...base} view="ws" canEditWorkspace onEditWorkspace={onEditWorkspace} />)
    fireEvent.click(screen.getByTitle(/编辑工作区/))
    expect(onEditWorkspace).toHaveBeenCalledTimes(1)
  })
})

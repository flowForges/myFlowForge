import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Titlebar } from './Titlebar'

const base = {
  collapsed: false, onToggleSidebar: () => {}, onView: () => {}, crumb: 'ws-a',
  notifs: [], updateAvailable: false, notifOpen: false, onToggleNotif: () => {},
  onOpenUpgrade: () => {}, onMarkAllRead: () => {}, onClearAllNotif: () => {},
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

// ── Window controls ────────────────────────────────────────────────────────────────────────────
// The window is frameless on every platform, so we draw the controls ourselves. Where they sit and
// what they look like is not cosmetic: macOS puts them top-LEFT as coloured dots, Windows top-RIGHT
// as square glyphs. Drawing macOS' dots on Windows reads as a broken app.
function withPlatform(platform: string, fn: () => void) {
  const prev = (window as any).forge
  ;(window as any).forge = { ...(prev ?? {}), platform }
  try { fn() } finally { (window as any).forge = prev }
}

describe('Titlebar – window controls', () => {
  it('macOS: traffic-light dots, at the very start of the titlebar', () => {
    withPlatform('darwin', () => {
      const { container } = render(<Titlebar {...base} view="ws" />)
      const bar = container.querySelector('.titlebar')!
      expect(bar.querySelector('.traffic')).not.toBeNull()
      expect(bar.querySelector('.win-controls')).toBeNull()
      expect(bar.firstElementChild).toHaveClass('traffic')
    })
  })

  it('Windows: square controls, at the very end of the titlebar', () => {
    withPlatform('win32', () => {
      const { container } = render(<Titlebar {...base} view="ws" />)
      const bar = container.querySelector('.titlebar')!
      expect(bar.querySelector('.traffic')).toBeNull()
      expect(bar.querySelector('.win-controls')).not.toBeNull()
      expect(bar.lastElementChild).toHaveClass('win-controls')
    })
  })

  it('Windows: minimise / maximise / close in that left-to-right order', () => {
    withPlatform('win32', () => {
      const { container } = render(<Titlebar {...base} view="ws" />)
      const labels = [...container.querySelectorAll('.win-controls button')].map(b => b.getAttribute('aria-label'))
      expect(labels).toEqual(['最小化', '最大化', '关闭'])
    })
  })

  it('Windows: each control drives the matching window action', () => {
    const windowMinimize = vi.fn(), windowToggleMaximize = vi.fn(), windowClose = vi.fn()
    const prev = (window as any).forge
    ;(window as any).forge = { platform: 'win32', windowMinimize, windowToggleMaximize, windowClose }
    try {
      render(<Titlebar {...base} view="ws" />)
      fireEvent.click(screen.getByLabelText('最小化'))
      fireEvent.click(screen.getByLabelText('最大化'))
      fireEvent.click(screen.getByLabelText('关闭'))
      expect(windowMinimize).toHaveBeenCalledTimes(1)
      expect(windowToggleMaximize).toHaveBeenCalledTimes(1)
      expect(windowClose).toHaveBeenCalledTimes(1)
    } finally { (window as any).forge = prev }
  })

  it('macOS dots drive the same window actions', () => {
    const windowMinimize = vi.fn(), windowToggleMaximize = vi.fn(), windowClose = vi.fn()
    const prev = (window as any).forge
    ;(window as any).forge = { platform: 'darwin', windowMinimize, windowToggleMaximize, windowClose }
    try {
      render(<Titlebar {...base} view="ws" />)
      fireEvent.click(screen.getByLabelText('关闭'))
      fireEvent.click(screen.getByLabelText('最小化'))
      fireEvent.click(screen.getByLabelText('最大化'))
      expect(windowClose).toHaveBeenCalledTimes(1)
      expect(windowMinimize).toHaveBeenCalledTimes(1)
      expect(windowToggleMaximize).toHaveBeenCalledTimes(1)
    } finally { (window as any).forge = prev }
  })

  it('falls back to the macOS layout when the platform is unknown (tests, preload not injected)', () => {
    const prev = (window as any).forge
    ;(window as any).forge = undefined
    try {
      const { container } = render(<Titlebar {...base} view="ws" />)
      expect(container.querySelector('.traffic')).not.toBeNull()
    } finally { (window as any).forge = prev }
  })

  it('Windows: the maximise control reflects the restored/maximised state', () => {
    withPlatform('win32', () => {
      const { rerender, container } = render(<Titlebar {...base} view="ws" maximized={false} />)
      expect(container.querySelector('.win-controls button[aria-label="最大化"]')).not.toBeNull()
      rerender(<Titlebar {...base} view="ws" maximized />)
      expect(container.querySelector('.win-controls button[aria-label="向下还原"]')).not.toBeNull()
    })
  })
})

import { describe, it, expect, vi } from 'vitest'
import { parkWindowInDock, resolveCloseAction, resolveDockActivationAction } from './closeBehavior'

describe('resolveCloseAction', () => {
  it('quitting 时恒放行(不管设置是什么)', () => {
    expect(resolveCloseAction('ask', true)).toBe('pass')
    expect(resolveCloseAction('hide', true)).toBe('pass')
    expect(resolveCloseAction('quit', true)).toBe('pass')
  })
  it('hide → hide', () => {
    expect(resolveCloseAction('hide', false)).toBe('hide')
  })
  it('quit → pass(放行走既有 closed→app.quit)', () => {
    expect(resolveCloseAction('quit', false)).toBe('pass')
  })
  it('ask → ask', () => {
    expect(resolveCloseAction('ask', false)).toBe('ask')
  })
  it('垃圾值/缺省回落 ask', () => {
    expect(resolveCloseAction('banana' as never, false)).toBe('ask')
    expect(resolveCloseAction(undefined as never, false)).toBe('ask')
  })
})

describe('parkWindowInDock', () => {
  it('uses native minimize on macOS so the Dock icon can restore the window', () => {
    const win = { minimize: vi.fn(), hide: vi.fn(), isMinimizable: vi.fn(() => true) }
    parkWindowInDock(win, 'darwin')
    expect(win.minimize).toHaveBeenCalledTimes(1)
    expect(win.hide).not.toHaveBeenCalled()
  })

  it('falls back to hide when the window cannot be minimized', () => {
    const win = { minimize: vi.fn(), hide: vi.fn(), isMinimizable: vi.fn(() => false) }
    parkWindowInDock(win, 'darwin')
    expect(win.minimize).not.toHaveBeenCalled()
    expect(win.hide).toHaveBeenCalledTimes(1)
  })

  it('keeps the existing hide behavior off macOS', () => {
    const win = { minimize: vi.fn(), hide: vi.fn(), isMinimizable: vi.fn(() => true) }
    parkWindowInDock(win, 'win32')
    expect(win.minimize).not.toHaveBeenCalled()
    expect(win.hide).toHaveBeenCalledTimes(1)
  })
})

describe('resolveDockActivationAction', () => {
  it('creates when the main window is missing or destroyed', () => {
    expect(resolveDockActivationAction({ platform: 'darwin', hasWindow: false, destroyed: false, minimized: false, visible: false, focused: false })).toBe('create')
    expect(resolveDockActivationAction({ platform: 'darwin', hasWindow: true, destroyed: true, minimized: false, visible: false, focused: false })).toBe('create')
  })

  it('restores a minimized window', () => {
    expect(resolveDockActivationAction({ platform: 'darwin', hasWindow: true, destroyed: false, minimized: true, visible: true, focused: false })).toBe('restore')
  })

  it('shows a hidden or background window', () => {
    expect(resolveDockActivationAction({ platform: 'darwin', hasWindow: true, destroyed: false, minimized: false, visible: false, focused: false })).toBe('show')
    expect(resolveDockActivationAction({ platform: 'darwin', hasWindow: true, destroyed: false, minimized: false, visible: true, focused: false })).toBe('show')
  })

  it('toggles a visible focused macOS window back into the Dock', () => {
    expect(resolveDockActivationAction({ platform: 'darwin', hasWindow: true, destroyed: false, minimized: false, visible: true, focused: true })).toBe('minimize')
  })

  it('does not toggle-to-minimize off macOS', () => {
    expect(resolveDockActivationAction({ platform: 'win32', hasWindow: true, destroyed: false, minimized: false, visible: true, focused: true })).toBe('show')
  })
})

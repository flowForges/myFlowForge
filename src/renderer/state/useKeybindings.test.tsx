import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { useKeybindings } from './useKeybindings'

// Force a deterministic platform ('other' → CommandOrControl = Ctrl).
beforeEach(() => {
  cleanup()
  Object.defineProperty(navigator, 'platform', { value: 'Win32', configurable: true })
})

function Harness({ handlers, overrides = {} }: { handlers: Record<string, () => void>; overrides?: Record<string, string> }) {
  useKeybindings(overrides, handlers)
  return <input data-testid="field" />
}

const key = (init: KeyboardEventInit, target?: Element) => {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  ;(target ?? window).dispatchEvent(e)
  return e
}

describe('useKeybindings', () => {
  it('fires the handler for a matching app binding and preventDefaults', () => {
    const onNew = vi.fn()
    render(<Harness handlers={{ 'new-workspace': onNew }} />)
    const e = key({ key: 'n', ctrlKey: true }) // CommandOrControl+N on non-mac
    expect(onNew).toHaveBeenCalledTimes(1)
    expect(e.defaultPrevented).toBe(true)
  })

  it('ignores a non-matching combo', () => {
    const onNew = vi.fn()
    render(<Harness handlers={{ 'new-workspace': onNew }} />)
    key({ key: 'n' }) // no modifier
    expect(onNew).not.toHaveBeenCalled()
  })

  it('respects a user override', () => {
    const onNew = vi.fn()
    render(<Harness handlers={{ 'new-workspace': onNew }} overrides={{ 'new-workspace': 'Control+Alt+W' }} />)
    key({ key: 'n', ctrlKey: true }) // old default no longer bound
    expect(onNew).not.toHaveBeenCalled()
    key({ key: 'w', ctrlKey: true, altKey: true })
    expect(onNew).toHaveBeenCalledTimes(1)
  })

  it('does not fire an unbound (empty override) action', () => {
    const onTerm = vi.fn()
    render(<Harness handlers={{ 'toggle-terminal': onTerm }} overrides={{ 'toggle-terminal': '' }} />)
    key({ key: '`', ctrlKey: true })
    expect(onTerm).not.toHaveBeenCalled()
  })

  it('skips no-modifier bindings while a text field is focused, but fires modifier ones', () => {
    const bare = vi.fn()
    const withMod = vi.fn()
    const { getByTestId } = render(
      <Harness handlers={{ 'new-workspace': withMod, 'toggle-terminal': bare }} overrides={{ 'toggle-terminal': 'G' }} />,
    )
    const field = getByTestId('field')
    key({ key: 'g' }, field) // bare binding, focus in input → skipped
    expect(bare).not.toHaveBeenCalled()
    key({ key: 'n', ctrlKey: true }, field) // has modifier → still fires
    expect(withMod).toHaveBeenCalledTimes(1)
  })
})

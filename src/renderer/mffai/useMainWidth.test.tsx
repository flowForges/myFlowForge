import { describe, it, expect, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MainWidthProvider, useMainWidth } from './useMainWidth'
import { installResize } from './test/resize'

function Probe() {
  const w = useMainWidth()
  return <span data-testid="w">{w === undefined ? 'none' : String(w)}</span>
}

describe('useMainWidth', () => {
  let uninstall: (() => void) | undefined
  afterEach(() => { uninstall?.(); uninstall = undefined })

  it('renders div.mffai-main around its children', () => {
    render(<MainWidthProvider><Probe /></MainWidthProvider>)
    const main = screen.getByTestId('w').parentElement!
    expect(main.tagName).toBe('DIV')
    expect(main.className).toBe('mffai-main')
  })

  it('without ResizeObserver (jsdom) the width is undefined', () => {
    expect('ResizeObserver' in globalThis).toBe(false)
    render(<MainWidthProvider><Probe /></MainWidthProvider>)
    expect(screen.getByTestId('w').textContent).toBe('none')
  })

  it('outside a provider the width is undefined', () => {
    render(<Probe />)
    expect(screen.getByTestId('w').textContent).toBe('none')
  })

  it('follows setMainWidth; width 0 or undefined → undefined', () => {
    const r = installResize()
    uninstall = r.uninstall
    render(<MainWidthProvider><Probe /></MainWidthProvider>)
    expect(screen.getByTestId('w').textContent).toBe('none')
    r.setMainWidth(1440)
    expect(screen.getByTestId('w').textContent).toBe('1440')
    r.setMainWidth(1199)
    expect(screen.getByTestId('w').textContent).toBe('1199')
    r.setMainWidth(0)
    expect(screen.getByTestId('w').textContent).toBe('none')
    r.setMainWidth(1300)
    expect(screen.getByTestId('w').textContent).toBe('1300')
    r.setMainWidth(undefined)
    expect(screen.getByTestId('w').textContent).toBe('none')
  })

  it('a width set before mount is picked up on observe; unmount disconnects', () => {
    const r = installResize()
    uninstall = r.uninstall
    r.setMainWidth(1250)
    const { unmount } = render(<MainWidthProvider><Probe /></MainWidthProvider>)
    expect(screen.getByTestId('w').textContent).toBe('1250')
    unmount()
    expect(() => r.setMainWidth(900)).not.toThrow()
  })
})

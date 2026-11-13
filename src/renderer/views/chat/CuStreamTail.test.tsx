import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { CuStreamTail } from './CuStreamTail'

const key = { workspacePath: '/w', sessionId: 's' }
const gate = { id: 'g1', key, kind: 'action' as const, ts: 1, action: { kind: 'click' as const, at: { x: 1, y: 2 } } }
const entry = { ts: 1, turn: 1, op: 'click' as const, result: 'allowed' as const }

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date', 'performance'] }); vi.setSystemTime(1_000_000) })
afterEach(() => { vi.useRealTimers() })

describe('CuStreamTail', () => {
  it('local view: log block then the pending cards; 拒绝 resolves through the hook, 允许 needs an OS-trusted press (I-2)', () => {
    const resolve = vi.fn()
    const { container } = render(<CuStreamTail remote={false} gates={[gate]} gateErrors={{}} log={[entry]} resolve={resolve} thumb={async () => null} />)
    expect(container.querySelector('.cu-log')).toBeTruthy()
    vi.setSystemTime(Date.now() + 700)
    fireEvent.mouseDown(screen.getByRole('button', { name: '允许' }))
    fireEvent.click(screen.getByRole('button', { name: '允许' }), { detail: 1 })   // jsdom events are isTrusted:false
    expect(resolve).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '拒绝' }))
    expect(resolve).toHaveBeenCalledWith('g1', 'deny')
  })
  it('remote view: no inline cards and no log (the overlay is the only surface)', () => {
    const { container } = render(<CuStreamTail remote gates={[gate]} gateErrors={{}} log={[entry]} resolve={vi.fn()} thumb={async () => null} />)
    expect(container.firstChild).toBeNull()
  })
  it('nothing to show renders nothing', () => {
    const { container } = render(<CuStreamTail remote={false} gates={[]} gateErrors={{}} log={[]} resolve={vi.fn()} thumb={async () => null} />)
    expect(container.firstChild).toBeNull()
  })
})

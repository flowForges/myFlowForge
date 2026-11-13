import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { CuStreamTail } from './CuStreamTail'

const key = { workspacePath: '/w', sessionId: 's' }
const gate = { id: 'g1', key, kind: 'action' as const, ts: 1, action: { kind: 'click' as const, at: { x: 1, y: 2 } } }
const entry = { ts: 1, turn: 1, op: 'click' as const, result: 'allowed' as const }

describe('CuStreamTail', () => {
  it('local view: log block then the pending cards, and 允许 resolves through the hook', () => {
    const resolve = vi.fn()
    const { container } = render(<CuStreamTail remote={false} gates={[gate]} log={[entry]} resolve={resolve} thumb={async () => null} />)
    expect(container.querySelector('.cu-log')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '允许' }))
    expect(resolve).toHaveBeenCalledWith('g1', 'allow')
  })
  it('remote view: no inline cards and no log (the overlay is the only surface)', () => {
    const { container } = render(<CuStreamTail remote gates={[gate]} log={[entry]} resolve={vi.fn()} thumb={async () => null} />)
    expect(container.firstChild).toBeNull()
  })
  it('nothing to show renders nothing', () => {
    const { container } = render(<CuStreamTail remote={false} gates={[]} log={[]} resolve={vi.fn()} thumb={async () => null} />)
    expect(container.firstChild).toBeNull()
  })
})

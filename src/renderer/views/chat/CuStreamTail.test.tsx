import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CuStreamTail } from './CuStreamTail'

const key = { workspacePath: '/w', sessionId: 's' }
const gate = { id: 'g1', key, kind: 'action' as const, ts: 1, action: { kind: 'click' as const, at: { x: 1, y: 2 } } }
const entry = { ts: 1, turn: 1, op: 'click' as const, result: 'allowed' as const }

describe('CuStreamTail', () => {
  it('local view: log block then the pending cards, chip 待批准 and no button (spec §9.2: the overlay is the only answer surface)', () => {
    const { container } = render(<CuStreamTail remote={false} gates={[gate]} gateErrors={{}} log={[entry]} resolve={vi.fn()} thumb={async () => null} />)
    expect(container.querySelector('.cu-log')).toBeTruthy()
    expect(screen.getByText('待批准')).toBeTruthy()
    expect(screen.queryAllByRole('button')).toHaveLength(0)
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

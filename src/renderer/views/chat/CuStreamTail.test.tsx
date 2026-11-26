import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CuStreamTail } from './CuStreamTail'

const key = { workspacePath: '/w', sessionId: 's' }
const gate = { id: 'g1', key, kind: 'action' as const, ts: 1, action: { kind: 'click' as const, at: { x: 1, y: 2 } } }

describe('CuStreamTail', () => {
  it('local view: only the pending cards, chip 待批准 and no button (spec §9.2); the log blocks live in the stream (rc3)', () => {
    const { container } = render(<CuStreamTail remote={false} gates={[gate]} gateErrors={{}} />)
    expect(container.querySelector('.cu-log')).toBeNull()
    expect(screen.getByText('待批准')).toBeTruthy()
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })
  it('remote view: no inline cards and no log (the overlay is the only surface)', () => {
    const { container } = render(<CuStreamTail remote gates={[gate]} gateErrors={{}} />)
    expect(container.firstChild).toBeNull()
  })
  it('nothing to show renders nothing', () => {
    const { container } = render(<CuStreamTail remote={false} gates={[]} gateErrors={{}} />)
    expect(container.firstChild).toBeNull()
  })
})

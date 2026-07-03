import { describe, it, expect } from 'vitest'
import { petBounds, PET_COLLAPSED, PET_EXPANDED, snapCorner, posBottomFromBounds, MARGIN } from './petWindow'

const workArea = { x: 0, y: 0, width: 1440, height: 900 }

describe('petBounds', () => {
  it('anchors collapsed and expanded to the SAME bottom-right screen corner', () => {
    const collapsed = petBounds(workArea, 'right', PET_COLLAPSED, 24)
    const expanded = petBounds(workArea, 'right', PET_EXPANDED, 24)
    expect(collapsed.x + collapsed.width).toBe(expanded.x + expanded.width)
    expect(collapsed.y + collapsed.height).toBe(expanded.y + expanded.height)
    expect(collapsed).toEqual({ x: 1440 - 140 - 24, y: 900 - 120 - 24, width: 140, height: 120 })
    expect(expanded).toEqual({ x: 1440 - 360 - 24, y: 900 - 560 - 24, width: 360, height: 560 })
  })

  it('anchors to the bottom-left corner with margin', () => {
    const expanded = petBounds(workArea, 'left', PET_EXPANDED, 24)
    expect(expanded).toEqual({ x: 24, y: 900 - 560 - 24, width: 360, height: 560 })
  })
})

describe('petBounds with posBottom', () => {
  it('uses posBottom for the bottom offset instead of margin', () => {
    const b = petBounds({ x: 0, y: 0, width: 1440, height: 900 }, 'right', PET_COLLAPSED, 24, 120)
    expect(b).toEqual({ x: 1440 - 140 - 24, y: 900 - 120 - 120, width: 140, height: 120 })
  })
  it('falls back to margin when posBottom is undefined', () => {
    const b = petBounds({ x: 0, y: 0, width: 1440, height: 900 }, 'right', PET_COLLAPSED, 24)
    expect(b.y).toBe(900 - 120 - 24)
  })
})

describe('snapCorner', () => {
  const wa = { x: 0, y: 0, width: 1440, height: 900 }
  it('snaps to left when the window center is in the left half', () => {
    expect(snapCorner(100, 140, wa)).toBe('left')   // center 170 < 720
  })
  it('snaps to right when the window center is in the right half', () => {
    expect(snapCorner(1200, 140, wa)).toBe('right')  // center 1270 > 720
  })
})

describe('posBottomFromBounds', () => {
  it('computes the bottom offset and clamps to >= 0', () => {
    expect(posBottomFromBounds(620, 160, { x: 0, y: 0, width: 1440, height: 900 })).toBe(120) // 900 - (620+160)
    expect(posBottomFromBounds(900, 160, { x: 0, y: 0, width: 1440, height: 900 })).toBe(0)   // clamped
  })
})

// MARGIN is the desktop-edge collision gap; 0 lets the pet hug the screen edge (no forced whitespace).
describe('MARGIN export', () => {
  it('is a non-negative number', () => { expect(typeof MARGIN).toBe('number'); expect(MARGIN).toBeGreaterThanOrEqual(0) })
})

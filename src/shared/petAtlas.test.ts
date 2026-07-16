import { describe, it, expect } from 'vitest'
import { ATLAS, ROW_OF, FRAME_DURATIONS, PET_ACTIONS, cellBackgroundPosition, lookCellForAngle, resolveAction, SPRITE_VERSION } from './petAtlas'

describe('petAtlas contract', () => {
  it('locks the v2 atlas dimensions and version', () => {
    expect(SPRITE_VERSION).toBe(2)
    expect(ATLAS).toMatchObject({ cols: 8, rows: 11, cellW: 192, cellH: 208, width: 1536, height: 2288 })
  })

  it('maps every action to its documented row 0-8', () => {
    expect(ROW_OF).toEqual({
      idle: 0, 'running-right': 1, 'running-left': 2, waving: 3, jumping: 4,
      failed: 5, waiting: 6, running: 7, review: 8,
    })
    expect(PET_ACTIONS).toHaveLength(9)
  })

  it('has per-frame durations matching the contract (idle + running)', () => {
    expect(FRAME_DURATIONS.idle).toEqual([280, 110, 110, 140, 140, 320])
    expect(FRAME_DURATIONS.running).toEqual([120, 120, 120, 120, 120, 220])
    expect(FRAME_DURATIONS['running-right']).toHaveLength(8)
    expect(FRAME_DURATIONS['running-right'].at(-1)).toBe(220)
  })
})

describe('cellBackgroundPosition (8x11 grid, background-size 800% 1100%)', () => {
  it('cell (0,0) is top-left 0% 0%', () => {
    expect(cellBackgroundPosition(0, 0)).toEqual({ x: '0%', y: '0%' })
  })
  it('cell (7,10) is bottom-right 100% 100%', () => {
    expect(cellBackgroundPosition(7, 10)).toEqual({ x: '100%', y: '100%' })
  })
  it('row 6 (waiting) col 0 → y = 60%', () => {
    expect(cellBackgroundPosition(0, 6)).toEqual({ x: '0%', y: '60%' })
  })
})

describe('lookCellForAngle (16 poses, 000=up, clockwise, rows 9-10)', () => {
  it('0° → row 9 col 0', () => expect(lookCellForAngle(0)).toEqual({ col: 0, row: 9 }))
  it('90° → row 9 col 4', () => expect(lookCellForAngle(90)).toEqual({ col: 4, row: 9 }))
  it('180° → row 10 col 0', () => expect(lookCellForAngle(180)).toEqual({ col: 0, row: 10 }))
  it('337.5° → row 10 col 7', () => expect(lookCellForAngle(337.5)).toEqual({ col: 7, row: 10 }))
  it('wraps: 360° → row 9 col 0', () => expect(lookCellForAngle(360)).toEqual({ col: 0, row: 9 }))
  it('rounds to nearest 22.5° pose: 100° → col 4 (090)', () => expect(lookCellForAngle(100)).toEqual({ col: 4, row: 9 }))
})

describe('resolveAction fallback chain', () => {
  const all = new Set(PET_ACTIONS)
  it('returns the desired action when available', () => {
    expect(resolveAction('review', all)).toBe('review')
  })
  it('waving → idle when missing', () => {
    expect(resolveAction('waving', new Set(['idle'] as const))).toBe('idle')
  })
  it('review → running → idle', () => {
    expect(resolveAction('review', new Set(['running', 'idle'] as const))).toBe('running')
    expect(resolveAction('review', new Set(['idle'] as const))).toBe('idle')
  })
  it('failed → idle when missing', () => {
    expect(resolveAction('failed', new Set(['idle'] as const))).toBe('idle')
  })
})

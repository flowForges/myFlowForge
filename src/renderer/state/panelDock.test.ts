import { describe, it, expect } from 'vitest'
import { clampPanel, fitStack, moveBoundary, clampRatio } from './panelDock'

describe('clampPanel', () => {
  it('clamps above max down to max', () => {
    expect(clampPanel(900, 160, 600)).toBe(600)
  })
  it('clamps below min up to min', () => {
    expect(clampPanel(50, 160, 600)).toBe(160)
  })
  it('rounds an in-range value', () => {
    expect(clampPanel(312.6, 160, 600)).toBe(313)
  })
  it('when max is below min, max wins (panel can shrink below its preferred min to fit)', () => {
    expect(clampPanel(300, 160, 120)).toBe(120)
  })
})

describe('fitStack', () => {
  it('leaves heights untouched when they already fit', () => {
    expect(fitStack(312, 360, 800, 160, 160)).toEqual({ logH: 312, termH: 360 })
  })
  it('shrinks both to fit when the stack would overflow the available height', () => {
    const r = fitStack(500, 500, 700, 160, 160)
    expect(r.logH + r.termH).toBeLessThanOrEqual(700)
    expect(r.logH).toBeGreaterThanOrEqual(110)
    expect(r.termH).toBeGreaterThanOrEqual(110)
  })
  it('never returns a stack taller than available (the anti-overflow guarantee)', () => {
    const r = fitStack(9999, 9999, 500, 160, 160)
    expect(r.logH + r.termH).toBeLessThanOrEqual(500)
  })
})

describe('moveBoundary (stack divider: term grows, log shrinks, sum preserved)', () => {
  it('dragging up grows the terminal and shrinks the log by the same amount', () => {
    expect(moveBoundary(360, 80, 700, 190, 180)).toEqual({ termH: 440, logH: 260 })
  })
  it('clamps so the log keeps its minimum (terminal cannot eat it entirely)', () => {
    const r = moveBoundary(360, 9999, 700, 190, 180)
    expect(r.logH).toBe(180)
    expect(r.termH).toBe(520)
    expect(r.termH + r.logH).toBe(700)
  })
  it('clamps so the terminal keeps its minimum when dragging down hard', () => {
    const r = moveBoundary(360, -9999, 700, 190, 180)
    expect(r.termH).toBe(190)
    expect(r.logH).toBe(510)
  })
})

describe('clampRatio', () => {
  it('keeps a mid ratio', () => { expect(clampRatio(0.5)).toBe(0.5) })
  it('clamps a tiny ratio up to 0.2', () => { expect(clampRatio(0.05)).toBe(0.2) })
  it('clamps a huge ratio down to 0.8', () => { expect(clampRatio(0.95)).toBe(0.8) })
})

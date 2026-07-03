import { describe, it, expect } from 'vitest'
import { Heartbeater } from './heartbeat'

const CFG = { stallMs: 90_000, killGraceMs: 60_000, pingMs: 15_000 }

function makeClock(start = 0) {
  let t = start
  return { now: () => t, advance: (ms: number) => { t += ms } }
}

describe('Heartbeater', () => {
  it('add records first beat at now; tick is quiet while fresh', () => {
    const clk = makeClock(1000)
    const hb = new Heartbeater(CFG, clk.now)
    hb.add('a1')
    expect(hb.lastBeat('a1')).toBe(1000)
    clk.advance(10_000)
    expect(hb.tick()).toEqual([])
  })

  it('emits a stall effect once after stallMs of silence', () => {
    const clk = makeClock(0)
    const hb = new Heartbeater(CFG, clk.now)
    hb.add('a1')
    clk.advance(90_001)
    expect(hb.tick()).toEqual([{ agentId: 'a1', kind: 'stall', silentMs: 90_001 }])
    clk.advance(1000)
    expect(hb.tick()).toEqual([])
  })

  it('any activity resets lastBeat and clears a prior stall', () => {
    const clk = makeClock(0)
    const hb = new Heartbeater(CFG, clk.now)
    hb.add('a1')
    clk.advance(90_001)
    expect(hb.tick()).toEqual([{ agentId: 'a1', kind: 'stall', silentMs: 90_001 }])
    clk.advance(5000)
    hb.beat('a1')
    expect(hb.lastBeat('a1')).toBe(95_001)
    clk.advance(10_000)
    expect(hb.tick()).toEqual([])
  })

  it('escalates to kill after killGraceMs of continued silence past stall', () => {
    const clk = makeClock(0)
    const hb = new Heartbeater(CFG, clk.now)
    hb.add('a1')
    clk.advance(90_001)
    expect(hb.tick()).toEqual([{ agentId: 'a1', kind: 'stall', silentMs: 90_001 }])
    clk.advance(60_000)
    expect(hb.tick()).toEqual([{ agentId: 'a1', kind: 'kill', silentMs: 150_001 }])
    clk.advance(1000)
    expect(hb.tick()).toEqual([])
  })

  it('awaiting agents never stall or kill (waiting on the user is normal)', () => {
    const clk = makeClock(0)
    const hb = new Heartbeater(CFG, clk.now)
    hb.add('a1')
    hb.setAwaiting('a1', true)
    clk.advance(1_000_000)
    expect(hb.tick()).toEqual([])
    hb.setAwaiting('a1', false)
    expect(hb.lastBeat('a1')).toBe(1_000_000)
    clk.advance(10_000)
    expect(hb.tick()).toEqual([])
  })

  it('remove stops tracking (a finished agent never stalls)', () => {
    const clk = makeClock(0)
    const hb = new Heartbeater(CFG, clk.now)
    hb.add('a1')
    hb.remove('a1')
    clk.advance(90_001)
    expect(hb.tick()).toEqual([])
    expect(hb.lastBeat('a1')).toBeUndefined()
  })

  it('tracks multiple agents independently', () => {
    const clk = makeClock(0)
    const hb = new Heartbeater(CFG, clk.now)
    hb.add('a1'); hb.add('a2')
    clk.advance(50_000)
    hb.beat('a2')
    clk.advance(40_001)
    expect(hb.tick()).toEqual([{ agentId: 'a1', kind: 'stall', silentMs: 90_001 }])
  })
})

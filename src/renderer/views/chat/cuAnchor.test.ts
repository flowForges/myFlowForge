import { describe, it, expect } from 'vitest'
import type { ChatMessage } from '@shared/types'
import type { CuLogEntry } from '../../../main/computerUse/types'
import type { TimelineEntry } from './timeline'
import { groupCuTurns, weaveCuTurns } from './cuAnchor'

const msg = (id: string, who: 'user' | 'ai', ts: number, index: number): TimelineEntry =>
  ({ kind: 'message', ts, index, msg: { id, who, text: id, ts: ts === -Infinity ? '' : new Date(ts).toISOString() } as ChatMessage })
const en = (turn: number, ts: number): CuLogEntry => ({ ts, turn, op: 'click', result: 'auto' })
const shape = (items: ReturnType<typeof weaveCuTurns>['items']) =>
  items.map((x) => (x.kind === 'cu-turn' ? `cu${x.turn.turn}` : x.kind === 'message' ? x.msg.id : x.kind))

describe('groupCuTurns', () => {
  it('consecutive entries of one turn form one group, keyed by turn + first ts', () => {
    const g = groupCuTurns([en(3, 10), en(3, 11), en(5, 20), en(3, 30)])
    expect(g.map((t) => [t.turn, t.rows.length, t.key])).toEqual([[3, 2, '3-10'], [5, 1, '5-20'], [3, 1, '3-30']])
  })
})

describe('groupCuTurns — turn numbers repeat across app restarts (review 2026-11)', () => {
  // the turn number is an in-memory ++seq that restarts at 1 every launch, while the log persists
  const enR = (run: string | undefined, turn: number, ts: number): CuLogEntry => ({ ...en(turn, ts), ...(run ? { run } : {}) })
  it('same turn number from two runs → two groups (the per-run id differs)', () => {
    const g = groupCuTurns([enR('r1', 1, 10), enR('r1', 1, 11), enR('r2', 1, 20)])
    expect(g.map((t) => t.rows.length)).toEqual([2, 1])
    expect(new Set(g.map((t) => t.key)).size).toBe(2)
  })
  it('old entries without a run id: a group splits where the row\'s anchor (last user message ts <= row.ts) changes', () => {
    const g = groupCuTurns([en(1, 150), en(1, 300), en(1, 600)], [100, 500])
    expect(g.map((t) => t.rows.map((r) => r.ts))).toEqual([[150, 300], [600]])
  })
  it('restart scenario end to end: run 2\'s turn 1 lands under its own reply, not run 1\'s', () => {
    const tl = [msg('u1', 'user', 100, 0), msg('a1', 'ai', 400, 1), msg('u2', 'user', 500, 2), msg('a2', 'ai', 900, 3)]
    const users = [100, 500]
    const r = weaveCuTurns(tl, groupCuTurns([en(1, 150), en(1, 600)], users), 0)
    expect(shape(r.items)).toEqual(['u1', 'a1', 'cu1', 'u2', 'a2', 'cu1'])
  })
  it('rows before any user message share the "no anchor" group', () => {
    expect(groupCuTurns([en(1, 10), en(1, 20)], [100]).length).toBe(1)
  })
})

describe('weaveCuTurns', () => {
  it('each turn block lands after the last message of the turn it ran in (the assistant reply), not at the tail', () => {
    const tl = [msg('u1', 'user', 100, 0), msg('a1', 'ai', 400, 1), msg('u2', 'user', 500, 2), msg('a2', 'ai', 900, 3)]
    // the assistant reply is stamped when it finishes, i.e. after its actions: anchoring on the user message is what keeps it right
    const r = weaveCuTurns(tl, groupCuTurns([en(7, 150), en(7, 300), en(9, 600)]), 0)
    expect(shape(r.items)).toEqual(['u1', 'a1', 'cu7', 'u2', 'a2', 'cu9'])
  })

  it('cards inside a turn stay where they are; the block follows the turn\'s last message', () => {
    const plan: TimelineEntry = { kind: 'launch-gate', id: 'g', ts: 200 }
    const tl = [msg('u1', 'user', 100, 0), plan, msg('a1', 'ai', 400, 1), msg('u2', 'user', 500, 2)]
    expect(shape(weaveCuTurns(tl, groupCuTurns([en(1, 150)]), 0).items)).toEqual(['u1', 'launch-gate', 'a1', 'cu1', 'u2'])
  })

  it('a streaming reply (ts carried forward) still precedes the running turn\'s block; that block is the latest', () => {
    const tl = [msg('u1', 'user', 100, 0), msg('a1', 'ai', 100, 1)]
    const r = weaveCuTurns(tl, groupCuTurns([en(2, 150)]), 0)
    expect(shape(r.items)).toEqual(['u1', 'a1', 'cu2'])
    expect(r.items.find((x) => x.kind === 'cu-turn')).toMatchObject({ latest: true })
  })

  it('only blocks of the last user turn are latest', () => {
    const tl = [msg('u1', 'user', 100, 0), msg('a1', 'ai', 400, 1), msg('u2', 'user', 500, 2)]
    const r = weaveCuTurns(tl, groupCuTurns([en(1, 150), en(2, 600)]), 0)
    expect(r.items.filter((x) => x.kind === 'cu-turn').map((x) => x.kind === 'cu-turn' && [x.turn.turn, x.latest])).toEqual([[1, false], [2, true]])
  })

  it('a turn older than every visible user message is dropped while history is windowed out, kept at the top otherwise', () => {
    const tl = [msg('u2', 'user', 500, 0), msg('a2', 'ai', 900, 1)]
    expect(shape(weaveCuTurns(tl, groupCuTurns([en(1, 150)]), 3).items)).toEqual(['u2', 'a2'])
    expect(shape(weaveCuTurns(tl, groupCuTurns([en(1, 150)]), 0).items)).toEqual(['cu1', 'u2', 'a2'])
  })

  it('no log: the timeline is returned as is', () => {
    const tl = [msg('u1', 'user', 100, 0)]
    expect(weaveCuTurns(tl, [], 0).items).toEqual(tl)
  })
})

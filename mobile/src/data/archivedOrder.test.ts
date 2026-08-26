import { describe, expect, it } from 'vitest'
import { orderArchived } from './archivedOrder'

type W = { path: string; archived: boolean; archivedAt: number | null }

describe('orderArchived', () => {
  it('drops non-archived workspaces', () => {
    const live: W = { path: '/a', archived: false, archivedAt: null }
    const dead: W = { path: '/b', archived: true, archivedAt: 100 }
    expect(orderArchived([live, dead])).toEqual([dead])
  })

  it('sorts archived-at descending: most recently archived first', () => {
    const old: W = { path: '/old', archived: true, archivedAt: 100 }
    const mid: W = { path: '/mid', archived: true, archivedAt: 500 }
    const recent: W = { path: '/recent', archived: true, archivedAt: 900 }
    expect(orderArchived([old, recent, mid]).map((w) => w.path)).toEqual(['/recent', '/mid', '/old'])
  })

  it('treats a missing archivedAt as 0, so it sorts last, not into NaN chaos', () => {
    const unknown: W = { path: '/unknown', archived: true, archivedAt: null }
    const known: W = { path: '/known', archived: true, archivedAt: 1 }
    expect(orderArchived([unknown, known]).map((w) => w.path)).toEqual(['/known', '/unknown'])
  })

  it('does not mutate the input array', () => {
    const a: W = { path: '/a', archived: true, archivedAt: 1 }
    const b: W = { path: '/b', archived: true, archivedAt: 2 }
    const input = [a, b]
    orderArchived(input)
    expect(input).toEqual([a, b])
  })
})

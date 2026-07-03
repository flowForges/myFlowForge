import { describe, it, expect } from 'vitest'
import { groupByCwd } from './group'
import type { DiscoveredSession } from '@shared/types'

const s = (cwd: string, lastTs: number, id: string): DiscoveredSession =>
  ({ source: 'claude', externalId: id, cwd, title: id, startedAt: lastTs, lastTs, messageCount: 1, filePaths: [], hasBody: true })

describe('groupByCwd', () => {
  it('matches only the cwd exactly equal to a workspace path — not children nested under it', () => {
    // A broad parent workspace (e.g. /ws/a) must NOT claim every child session as imported:
    // those children never get their own entry in the workspace list, so "已在工作区" would lie.
    const groups = groupByCwd([s('/ws/a', 10, 'x'), s('/ws/a/sub', 20, 'y')], ['/ws/a'])
    expect(groups).toHaveLength(2)
    const exact = groups.find(g => g.cwd === '/ws/a')!
    const child = groups.find(g => g.cwd === '/ws/a/sub')!
    expect(exact.matched).toBe(true)
    expect(exact.wsPath).toBe('/ws/a')
    expect(child.matched).toBe(false)
    expect(child.wsPath).toBe('/ws/a/sub')
  })
  it('unmatched cwd becomes its own candidate workspace', () => {
    const [g] = groupByCwd([s('/other/proj', 5, 'z')], ['/ws/a'])
    expect(g.matched).toBe(false)
    expect(g.wsPath).toBe('/other/proj')
  })
  it('sorts sessions within group by lastTs desc', () => {
    const [g] = groupByCwd([s('/p', 1, 'old'), s('/p', 9, 'new')], [])
    expect(g.sessions.map(x => x.externalId)).toEqual(['new', 'old'])
  })
})

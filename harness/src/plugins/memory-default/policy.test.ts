import { describe, expect, it } from 'vitest'
import { Sessions } from '../../kernel/sessions'
import type { KernelEvent } from '../../protocol/events'
import { scopeOf, type Scope } from './policy'

/** 走真的 session.created 推算:旧日志、不认识的值,都是这条路 */
function sessionFrom(payload: Record<string, unknown>) {
  const sessions = new Sessions('/tmp/unused')
  sessions.observe({ seq: 1, ts: 1, type: 'session.created', sessionId: 's1', payload } as KernelEvent)
  return sessions.get('s1')
}

const OWNER: Scope = { read: ['owner'], write: 'diary', source: 'model', injectCore: true, canPropose: true, extractable: true, countsForHabits: true }
const SCHEDULE: Scope = { read: ['owner'], write: 'diary', source: 'schedule', injectCore: true, canPropose: false, extractable: false, countsForHabits: false }
const GROUP: Scope = { read: ['session:s1'], write: 'session', source: 'group', injectCore: false, canPropose: false, extractable: false, countsForHabits: false }

describe('scopeOf: spec §9', () => {
  const rows: [string, Record<string, unknown>, Scope][] = [
    ['app, nothing written (a v2 session)', {}, OWNER],
    ['app', { origin: 'app' }, OWNER],
    ['app + owner', { origin: 'app', audience: 'owner' }, OWNER],
    ['paired private chat: im + owner', { origin: 'im', audience: 'owner' }, OWNER],
    ['schedule', { origin: 'schedule' }, SCHEDULE],
    ['schedule + owner', { origin: 'schedule', audience: 'owner' }, SCHEDULE],
    ['im, no audience', { origin: 'im' }, GROUP],
    ['im + group', { origin: 'im', audience: 'group' }, GROUP],
    ['old log: im with an unknown audience', { origin: 'im', audience: 'everyone' }, GROUP],
    ['old log: unknown origin, no audience', { origin: 'slack' }, GROUP],
    ['old log: app with an unknown audience', { origin: 'app', audience: 'public' }, GROUP],
    ['schedule marked group', { origin: 'schedule', audience: 'group' }, GROUP],
    ['app marked group', { origin: 'app', audience: 'group' }, GROUP],
  ]
  it.each(rows)('%s', (_name, payload, expected) => {
    expect(scopeOf(sessionFrom(payload))).toEqual(expected)
  })

  it('an unknown session can read nothing and can do nothing', () => {
    expect(scopeOf(undefined)).toEqual({ read: [], write: 'session', source: 'group', injectCore: false, canPropose: false, extractable: false, countsForHabits: false })
  })

  it('an explicit owner on an unknown origin is not a person in the room: it behaves like schedule', () => {
    expect(scopeOf(sessionFrom({ origin: 'slack', audience: 'owner' }))).toEqual(SCHEDULE)
  })

  it('two groups never share a read scope', () => {
    const sessions = new Sessions('/tmp/unused')
    for (const id of ['g1', 'g2']) sessions.observe({ seq: 1, ts: 1, type: 'session.created', sessionId: id, payload: { origin: 'im' } } as KernelEvent)
    expect(scopeOf(sessions.get('g1')).read).toEqual(['session:g1'])
    expect(scopeOf(sessions.get('g2')).read).toEqual(['session:g2'])
  })
})

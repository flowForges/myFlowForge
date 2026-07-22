import { describe, it, expect } from 'vitest'
import { addEvent, removeEvent, findEvent, type RunEvent, type GateEvent } from './events'

const gate: GateEvent = { id: 'g1', kind: 'gate', stageKey: 'design', stageName: '技术方案设计', body: 'the design doc' }
const auth: RunEvent = { id: 'a1', kind: 'auth', laneId: 'develop:x', stageKey: 'develop', title: '覆盖 config' }

describe('events inbox', () => {
  it('addEvent appends without mutating input', () => {
    const inbox: RunEvent[] = [gate]
    const next = addEvent(inbox, auth)
    expect(next.map((e) => e.id)).toEqual(['g1', 'a1'])
    expect(inbox.map((e) => e.id)).toEqual(['g1']) // unchanged
  })
  it('findEvent returns the matching event or undefined', () => {
    const inbox = addEvent([gate], auth)
    expect(findEvent(inbox, 'a1')?.kind).toBe('auth')
    expect(findEvent(inbox, 'nope')).toBeUndefined()
  })
  it('removeEvent drops by id without mutating input', () => {
    const inbox = addEvent([gate], auth)
    const next = removeEvent(inbox, 'g1')
    expect(next.map((e) => e.id)).toEqual(['a1'])
    expect(inbox.map((e) => e.id)).toEqual(['g1', 'a1'])
  })
})

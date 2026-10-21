import { describe, it, expect } from 'vitest'
import { Transcript, type Utterance } from './transcript'

const u = (seat: string, round: number, stage: Utterance['stage'], text: string): Utterance =>
  ({ seat, label: seat.toUpperCase(), round, stage, text })

describe('Transcript', () => {
  it('unseenFor returns only new items and is idempotent', () => {
    const t = new Transcript()
    t.add(u('a', 1, 'answer', 'A1'))
    t.add(u('b', 1, 'answer', 'B1'))
    expect(t.unseenFor('c').map(x => x.text)).toEqual(['A1', 'B1'])
    expect(t.unseenFor('c')).toEqual([])
    t.add(u('a', 2, 'critique', 'A2'))
    expect(t.unseenFor('c').map(x => x.text)).toEqual(['A2'])
    // 每个席位各记各的
    expect(t.unseenFor('d')).toHaveLength(3)
  })

  it('latestSummary and round', () => {
    const t = new Transcript()
    expect(t.latestSummary()).toBeUndefined()
    t.add(u('a', 1, 'answer', 'A1'))
    t.add(u('lead', 1, 'summary', 'S1'))
    t.add(u('a', 2, 'critique', 'A2'))
    t.add(u('lead', 2, 'summary', 'S2'))
    expect(t.latestSummary()?.text).toBe('S2')
    expect(t.round(1).map(x => x.text)).toEqual(['A1', 'S1'])
    expect(t.round(3)).toEqual([])
  })

  it('round-trips through JSON with seen marks', () => {
    const t = new Transcript()
    t.add(u('a', 1, 'answer', 'A1'))
    t.unseenFor('c')
    t.add(u('b', 1, 'answer', 'B1'))
    const t2 = Transcript.fromJSON(JSON.parse(JSON.stringify(t.toJSON())))
    expect(t2.unseenFor('c').map(x => x.text)).toEqual(['B1'])
    expect(t2.unseenFor('d').map(x => x.text)).toEqual(['A1', 'B1'])
  })
})

describe('Transcript own items', () => {
  it('unseenFor never returns the seat own items but advances past them', () => {
    const t = new Transcript()
    t.add(u('a', 1, 'answer', 'A1'))
    t.add(u('b', 1, 'answer', 'B1'))
    expect(t.unseenFor('a').map(x => x.text)).toEqual(['B1'])
    expect(t.unseenFor('a')).toEqual([])
  })
})

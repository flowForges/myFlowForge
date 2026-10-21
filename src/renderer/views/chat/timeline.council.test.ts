import { describe, it, expect } from 'vitest'
import { buildTimeline, type TimelineEntry } from './timeline'
import type { ChatMessage } from '@shared/types'
import type { CouncilStage } from '@shared/council'

const ts = (s: number) => new Date(Date.UTC(2026, 9, 21, 9, 0, s)).toISOString()
const ai = (id: string, s: number, provider?: string): ChatMessage => ({ id, who: 'ai', text: id, ts: ts(s), provider })
const user = (id: string, s: number): ChatMessage => ({ id, who: 'user', text: id, ts: ts(s) })
const cm = (cid: string, id: string, s: number, stage: CouncilStage, who: 'ai' | 'user' = 'ai', provider = 'codex'): ChatMessage => ({
  id, who, text: id, ts: ts(s), ...(who === 'ai' ? { provider } : {}), council: { id: cid, stage, ...(who === 'ai' ? { seat: id, round: 1 } : {}) },
})

const label = (e: TimelineEntry): string =>
  e.kind === 'message' ? e.msg.id
    : e.kind === 'council' ? `council:${e.id}[${e.messages.map(m => m.id).join(',')}]`
      : e.kind === 'provider-switch' ? `switch:${e.from}->${e.to}`
        : e.kind

describe('buildTimeline council grouping', () => {
  it('normal / council / normal → 3 entries, the council in the middle holding all its messages', () => {
    const messages = [
      user('u1', 0), ai('a1', 1, 'claude'),
      cm('c1', 'topic', 2, 'topic', 'user'), cm('c1', 'A', 3, 'answer'), cm('c1', 'B', 4, 'answer', 'ai', 'gemini'), cm('c1', 'L', 5, 'final', 'ai', 'claude'),
      ai('a2', 6, 'claude'),
    ]
    const tl = buildTimeline(messages, [], [], [])
    expect(tl.map(label)).toEqual(['u1', 'a1', 'council:c1[topic,A,B,L]', 'a2'])
    const c = tl.find(e => e.kind === 'council')!
    expect(c.ts).toBe(Date.parse(ts(2)))
  })

  it('two councils → two separate entries', () => {
    const messages = [
      cm('c1', 't1', 0, 'topic', 'user'), cm('c1', 'A1', 1, 'answer'),
      user('u1', 2), ai('a1', 3, 'claude'),
      cm('c2', 't2', 4, 'topic', 'user'), cm('c2', 'A2', 5, 'answer'),
    ]
    expect(buildTimeline(messages, [], [], []).map(label))
      .toEqual(['council:c1[t1,A1]', 'u1', 'a1', 'council:c2[t2,A2]'])
  })

  it('a followup appended later still lands in its council block, at the block position', () => {
    const messages = [
      cm('c1', 't1', 0, 'topic', 'user'), cm('c1', 'L', 1, 'final'),
      user('u1', 2), ai('a1', 3, 'claude'),
      cm('c1', 'F', 4, 'followup'),
    ]
    expect(buildTimeline(messages, [], [], []).map(label)).toEqual(['council:c1[t1,L,F]', 'u1', 'a1'])
  })

  it('no provider-switch divider after a council when the normal provider is unchanged', () => {
    const messages = [
      user('u1', 0), ai('a1', 1, 'claude'),
      cm('c1', 't', 2, 'topic', 'user'), cm('c1', 'A', 3, 'answer', 'ai', 'codex'), cm('c1', 'B', 4, 'answer', 'ai', 'gemini'),
      user('u2', 5), ai('a2', 6, 'claude'),
    ]
    const tl = buildTimeline(messages, [], [], [])
    expect(tl.some(e => e.kind === 'provider-switch')).toBe(false)
  })

  it('a real provider switch across a council is still compared against the last normal ai message', () => {
    const messages = [
      ai('a1', 0, 'claude'),
      cm('c1', 't', 1, 'topic', 'user'), cm('c1', 'A', 2, 'answer', 'ai', 'codex'),
      ai('a2', 3, 'gemini'),
    ]
    expect(buildTimeline(messages, [], [], []).map(label)).toEqual(['a1', 'council:c1[t,A]', 'switch:claude->gemini', 'a2'])
  })

  it('a council utterance still streaming (ts empty) is grouped into its block', () => {
    const messages = [
      cm('c1', 't', 0, 'topic', 'user'),
      { id: 'S', who: 'ai', text: '', ts: '', council: { id: 'c1', seat: 'A', round: 1, stage: 'answer' } } as ChatMessage,
    ]
    expect(buildTimeline(messages, [], [], []).map(label)).toEqual(['council:c1[t,S]'])
  })
})

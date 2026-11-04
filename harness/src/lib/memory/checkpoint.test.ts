import { describe, expect, it } from 'vitest'
import type { KernelEvent } from '../../protocol/index'
import { activeRebuild, checkpointValid, clipOpening, isCovered, safeBoundaries, selectCheckpoint } from './checkpoint'

let seq = 0
const ev = (type: KernelEvent['type'], payload: object): KernelEvent => ({ seq: ++seq, ts: seq, type, sessionId: 's', payload })
const user = (turnId: string, text = 'q', extra: object = {}) => ev('message.user', { turnId, text, ...extra })
const assistant = (turnId: string, text = 'a') => ev('message.assistant', { turnId, text, parts: [{ type: 'text', text }] })
const ended = (turnId: string, callId = 'c') => ev('tool.ended', { turnId, callId, name: 'read', ok: true, ms: 1, content: 'x' })
const rolled = (turnId: string) => ev('turn.rolledBack', { turnId, files: 0 })
const checkpoint = (throughSeq: number, asOfSeq: number, text = 'CP', extra: object = {}) => ev('memory.checkpoint', { throughSeq, asOfSeq, text, model: 'm', tokens: 1, covers: 1, ...extra })
const marker = (checkpointSeq: number, throughSeq: number, turnId = 'tx') => ev('context.rebuilt', { turnId, step: 1, checkpointSeq, throughSeq, before: 100, after: 50 })

describe('isCovered', () => {
  it('a turn whose first message is at or below throughSeq', () => {
    expect(isCovered(5, 5)).toBe(true)
    expect(isCovered(4, 5)).toBe(true)
    expect(isCovered(6, 5)).toBe(false)
  })
})

describe('safeBoundaries', () => {
  it('each value is the seq just before a message.user or message.assistant; a tool.ended never starts the tail', () => {
    const created = ev('session.created', {})
    const u = user('t1')
    const a1 = assistant('t1')
    const t = ended('t1')
    const a2 = assistant('t1')
    const done = ev('turn.ended', { turnId: 't1' })
    const u2 = user('t2')
    expect(safeBoundaries([created, u, a1, t, a2, done, u2], new Set())).toEqual([created.seq, u.seq, t.seq, done.seq])
  })

  it('rolled-back turns give no boundary, and a stray second message.user is not one', () => {
    const events = [ev('session.created', {}), user('gone'), rolled('gone'), user('t1'), user('t1', 'stray'), ended('t1')]
    expect(safeBoundaries(events, new Set(['gone']))).toEqual([events[2].seq])
  })

  it('a follow-up is a boundary, between a notice and that follow-up', () => {
    const u = user('t1')
    const n = ev('executor.notice', { turnId: 't1', runId: 'r', text: 'N' })
    const f = user('t1', 'more', { followUp: true })
    expect(safeBoundaries([u, n, f], new Set())).toEqual([n.seq])
  })

  it('an empty log has none', () => {
    expect(safeBoundaries([], new Set())).toEqual([])
  })
})

describe('Review Focus 5: the rollback table, on asOfSeq', () => {
  const base = () => {
    const u1 = user('t1')
    const a1 = assistant('t1')
    const u2 = user('t2')
    const a2 = assistant('t2')
    const u3 = user('t3')
    return { u1, a1, u2, a2, u3 }
  }

  it('a rollback after asOfSeq of a covered turn voids the checkpoint and the previous valid one applies', () => {
    const { u1, a1, u2, a2 } = base()
    const old = checkpoint(a1.seq, a1.seq, 'OLD')
    const fresh = checkpoint(a2.seq, a2.seq, 'NEW')
    const events = [u1, a1, u2, a2, old, fresh, marker(old.seq, a1.seq), marker(fresh.seq, a2.seq)]
    expect(activeRebuild(events)?.text).toBe('NEW')
    events.push(rolled('t2'))
    expect(selectCheckpoint(events)?.text).toBe('OLD')
    expect(activeRebuild(events)?.text).toBe('OLD')
    expect(u2.seq).toBeLessThanOrEqual(a2.seq)
  })

  it('the only checkpoint voided: no marker applies', () => {
    const { u1, a1 } = base()
    const cp = checkpoint(a1.seq, a1.seq)
    const events = [u1, a1, cp, marker(cp.seq, a1.seq), rolled('t1')]
    expect(activeRebuild(events)).toBeUndefined()
    expect(selectCheckpoint(events)).toBeUndefined()
  })

  it('a rollback of a later turn leaves the marker, even one written inside that turn', () => {
    const { u1, a1, u2 } = base()
    const cp = checkpoint(a1.seq, a1.seq)
    const events = [u1, a1, cp, u2, marker(cp.seq, a1.seq, 't2'), rolled('t2')]
    expect(activeRebuild(events)).toEqual({ throughSeq: a1.seq, text: 'CP' })
    expect(selectCheckpoint(events)?.seq).toBe(cp.seq)
  })

  it('a rollback before asOfSeq does not void it, so an early rollback cannot disable later checkpoints', () => {
    const { u1, a1, u2, a2 } = base()
    const back = rolled('t1')
    const asOf = a2.seq + 1000
    const cp = ev('memory.checkpoint', { throughSeq: a2.seq, asOfSeq: asOf, text: 'CP', model: 'm', tokens: 1, covers: 1 })
    // 回滚的 seq 比 asOfSeq 小:写手开始时已经知道这次回滚
    const events = [u1, a1, u2, a2, back, cp]
    expect(back.seq).toBeLessThan(asOf)
    expect(selectCheckpoint(events)?.seq).toBe(cp.seq)
  })

  it('a rollback while the writer was blocked is after asOfSeq: the result is never used', () => {
    const { u1, a1 } = base()
    const asOf = a1.seq
    const back = rolled('t1')
    const cp = checkpoint(a1.seq, asOf)
    expect(selectCheckpoint([u1, a1, back, cp])).toBeUndefined()
  })

  it('two rollbacks in a row walk back', () => {
    const { u1, a1, u2, a2, u3 } = base()
    const a3 = assistant('t3')
    const c1 = checkpoint(a1.seq, a1.seq, 'C1')
    const c2 = checkpoint(a2.seq, a2.seq, 'C2')
    const c3 = checkpoint(a3.seq, a3.seq, 'C3')
    const events = [u1, a1, u2, a2, u3, a3, c1, c2, c3, marker(c1.seq, a1.seq), marker(c2.seq, a2.seq), marker(c3.seq, a3.seq)]
    expect(activeRebuild(events)?.text).toBe('C3')
    events.push(rolled('t3'))
    expect(activeRebuild(events)?.text).toBe('C2')
    events.push(rolled('t2'))
    expect(activeRebuild(events)?.text).toBe('C1')
    events.push(rolled('t1'))
    expect(activeRebuild(events)).toBeUndefined()
  })
})

describe('bad checkpoints and markers', () => {
  it('a redacted checkpoint falls back to the previous marker or none', () => {
    const u = user('t1')
    const a = assistant('t1')
    const prior = checkpoint(u.seq, u.seq, 'PRIOR')
    const voided = checkpoint(a.seq, a.seq, '[已删除]', { redacted: true })
    const withPrior = [u, a, prior, voided, marker(prior.seq, u.seq), marker(voided.seq, a.seq)]
    expect(activeRebuild(withPrior)?.text).toBe('PRIOR')
    expect(selectCheckpoint(withPrior)?.text).toBe('PRIOR')
    expect(activeRebuild([u, a, voided, marker(voided.seq, a.seq)])).toBeUndefined()
  })

  it.each([
    ['no text', { throughSeq: 1, asOfSeq: 1 }],
    ['empty text', { throughSeq: 1, asOfSeq: 1, text: '' }],
    ['no asOfSeq', { throughSeq: 1, text: 'x' }],
    ['throughSeq a string', { throughSeq: '1', asOfSeq: 1, text: 'x' }],
    ['throughSeq past what the writer had seen', { throughSeq: 9, asOfSeq: 1, text: 'x' }],
    ['negative throughSeq', { throughSeq: -1, asOfSeq: 1, text: 'x' }],
    ['fractional throughSeq', { throughSeq: 0.5, asOfSeq: 1, text: 'x' }],
  ])('malformed checkpoint: %s', (_name, payload) => {
    const cp = ev('memory.checkpoint', payload)
    expect(selectCheckpoint([cp])).toBeUndefined()
    expect(activeRebuild([cp, marker(cp.seq, 1)])).toBeUndefined()
  })

  it('a null payload does not throw', () => {
    const cp = ev('memory.checkpoint', null as unknown as object)
    const m = ev('context.rebuilt', null as unknown as object)
    expect(selectCheckpoint([cp, m])).toBeUndefined()
    expect(activeRebuild([cp, m])).toBeUndefined()
  })

  it('a marker pointing at nothing, or at an event of another type, applies nothing', () => {
    const u = user('t1')
    expect(activeRebuild([u, marker(9999, 1)])).toBeUndefined()
    expect(activeRebuild([u, marker(u.seq, 1)])).toBeUndefined()
  })

  it('no checkpoint and no marker', () => {
    expect(selectCheckpoint([])).toBeUndefined()
    expect(activeRebuild([])).toBeUndefined()
  })

  it('checkpointValid reads the same rule directly', () => {
    const u = user('t1')
    expect(checkpointValid({ throughSeq: u.seq, asOfSeq: u.seq, text: 'x' }, [u])).toBe(true)
    expect(checkpointValid({ throughSeq: u.seq, asOfSeq: u.seq, text: 'x', redacted: true }, [u])).toBe(false)
  })

  it('selectCheckpoint takes the newest valid one', () => {
    const u = user('t1')
    const a = checkpoint(u.seq, u.seq, 'A')
    const b = checkpoint(u.seq, u.seq, 'B')
    expect(selectCheckpoint([u, a, b])).toEqual({ seq: b.seq, throughSeq: u.seq, text: 'B' })
  })
})

describe('clipOpening', () => {
  it('leaves 4000 chars alone, and never exceeds 4000', () => {
    const exact = 'x'.repeat(4000)
    expect(clipOpening(exact)).toBe(exact)
    const clipped = clipOpening('x'.repeat(4001))
    expect(clipped.length).toBeLessThanOrEqual(4000)
    expect(clipped.startsWith('xxx')).toBe(true)
    expect(clipped).toContain('事件日志里还在')
  })

  it('does not cut a surrogate pair, wherever the cut lands', () => {
    for (let pad = 0; pad < 4; pad++) {
      const clipped = clipOpening('x'.repeat(pad) + '😀'.repeat(3000))
      expect(clipped.length).toBeLessThanOrEqual(4000)
      expect(clipped).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
    }
  })
})

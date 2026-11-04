import { describe, expect, it } from 'vitest'
import type { KernelEvent } from '../../protocol/index'
import { blocksOf, injectMemory } from './inject'
import type { ContextBlock, MemoryService } from './types'

let seq = 0
const ev = (type: KernelEvent['type'], payload: object): KernelEvent => ({ seq: ++seq, ts: seq, type, sessionId: 's', payload })
const injected = (turnId: string, kind: string, text: string) => ev('memory.injected', { turnId, kind, text, items: [] })

const serving = (fn: () => ContextBlock[]): MemoryService => ({ contextFor: fn, noteContext() {} })
const REQ = { sessionId: 's', turnId: 't1', text: 'hello there', events: [], contextTokens: 1000 }

describe('blocksOf', () => {
  it('session is the first session block in the log, rolled back or not', () => {
    const events = [injected('t1', 'session', 'first'), ev('turn.rolledBack', { turnId: 't1' }), injected('t2', 'session', 'second')]
    expect(blocksOf(events).session).toBe('first')
  })

  it('turns holds each turn its own block and leaves session blocks out', () => {
    const { turns, session } = blocksOf([injected('t1', 'session', 's'), injected('t1', 'turn', 'a'), injected('t2', 'turn', 'b')])
    expect(session).toBe('s')
    expect([...turns]).toEqual([['t1', 'a'], ['t2', 'b']])
  })

  it('a second turn block never replaces the one already sent', () => {
    expect(blocksOf([injected('t1', 'turn', 'a'), injected('t1', 'turn', 'b')]).turns.get('t1')).toBe('a')
  })

  it('malformed payloads and other events are ignored', () => {
    const events = [
      ev('memory.injected', { kind: 'turn', text: 'no turn id' }),
      ev('memory.injected', { turnId: 't1', kind: 'turn', text: 7 }),
      ev('memory.injected', { turnId: 't1', kind: 'other', text: 'x' }),
      ev('message.user', { turnId: 't1', kind: 'session', text: 'not a block' }),
    ]
    const { session, turns } = blocksOf(events)
    expect(session).toBeUndefined()
    expect(turns.size).toBe(0)
  })
})

describe('injectMemory', () => {
  it('writes one event per block with everything the block has', () => {
    const written: object[] = []
    const memory = serving(() => [
      { kind: 'session', text: 'S', items: ['a'], coreVersion: 'v1' },
      { kind: 'turn', text: 'T', items: ['b', 'c'] },
    ])
    injectMemory(memory, REQ, p => written.push(p), { warn() {} })
    expect(written).toEqual([
      { turnId: 't1', kind: 'session', text: 'S', items: ['a'], coreVersion: 'v1' },
      { turnId: 't1', kind: 'turn', text: 'T', items: ['b', 'c'] },
    ])
  })

  it('no blocks: no event, no warning', () => {
    const written: object[] = []
    const warnings: string[] = []
    injectMemory(serving(() => []), REQ, p => written.push(p), { warn: m => warnings.push(m) })
    expect(written).toEqual([])
    expect(warnings).toEqual([])
  })

  it('contextFor throwing: no event, one warning that does not carry the error text, and no throw', () => {
    const written: object[] = []
    const warnings: { msg: string; data?: object }[] = []
    const memory = serving(() => {
      throw new TypeError('boom with private note text')
    })
    expect(() => injectMemory(memory, REQ, p => written.push(p), { warn: (msg, data) => warnings.push({ msg, data }) })).not.toThrow()
    expect(written).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(JSON.stringify(warnings)).not.toContain('private note')
  })

  it('a failing append is swallowed and logged too', () => {
    const warnings: string[] = []
    const memory = serving(() => [{ kind: 'turn', text: 'T', items: [] }])
    expect(() => injectMemory(memory, REQ, () => { throw new Error('db closed') }, { warn: m => warnings.push(m) })).not.toThrow()
    expect(warnings).toHaveLength(1)
  })
})

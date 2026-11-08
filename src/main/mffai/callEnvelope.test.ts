import { describe, it, expect } from 'vitest'
import { unwrapCall } from './callEnvelope'

describe('unwrapCall (preload side of mffai:call)', () => {
  it('ok → the result', () => {
    expect(unwrapCall({ ok: true, result: { a: 1 } })).toEqual({ a: 1 })
    expect(unwrapCall({ ok: true, result: null })).toBeNull()
  })

  it('error → throws a plain MffaiCallError object with the same code, message and data (survives contextBridge cloning)', () => {
    const data = [{ index: 0, reason: 'busy' }]
    let thrown: unknown
    try { unwrapCall({ ok: false, error: { code: -32003, message: 'busy', data } }) } catch (e) { thrown = e }
    expect(thrown).toEqual({ name: 'MffaiCallError', code: -32003, message: 'busy', data })
    // a plain object: every field is an own enumerable property, so structured cloning keeps it
    expect(Object.getPrototypeOf(thrown)).toBe(Object.prototype)
    expect(structuredClone(thrown)).toEqual(thrown)
  })

  it('no data → no data key', () => {
    let thrown: unknown
    try { unwrapCall({ ok: false, error: { code: -32010, message: 'timeout' } }) } catch (e) { thrown = e }
    expect(thrown).toEqual({ name: 'MffaiCallError', code: -32010, message: 'timeout' })
    expect('data' in (thrown as object)).toBe(false)
  })

  it('a malformed envelope is -32603', () => {
    for (const bad of [undefined, null, 3, {}, { ok: false }, { ok: false, error: { code: 'x' } }]) {
      let thrown: unknown
      try { unwrapCall(bad as never) } catch (e) { thrown = e }
      expect(thrown, JSON.stringify(bad)).toMatchObject({ name: 'MffaiCallError', code: -32603 })
    }
  })
})

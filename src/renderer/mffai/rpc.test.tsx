import { describe, it, expect, vi, beforeEach } from 'vitest'
import { call, cmd, isUnsupported, MffaiCallError } from './rpc'

let callFn: ReturnType<typeof vi.fn>

beforeEach(() => {
  callFn = vi.fn()
  ;(window as any).forge = { mffai: { call: callFn } }
})

describe('rpc', () => {
  it('passes method and params through and returns the result', async () => {
    callFn.mockResolvedValue({ sessions: [] })
    await expect(call('session.list', {})).resolves.toEqual({ sessions: [] })
    expect(callFn).toHaveBeenCalledWith('session.list', {})
  })

  it('maps the preload plain-object rejection to MffaiCallError with code and data', async () => {
    // contextBridge 丢掉 Error 的自定义属性,preload 抛的是普通对象
    callFn.mockRejectedValue({ name: 'MffaiCallError', code: -32003, message: 'busy', data: [{ index: 0, rule: 'x' }] })
    const e = await call('session.cancel', { commandId: 'c', sessionId: 's' }).catch((x) => x)
    expect(e).toBeInstanceOf(MffaiCallError)
    expect(e).toBeInstanceOf(Error)
    expect(e.code).toBe(-32003)
    expect(e.message).toBe('busy')
    expect(e.data).toEqual([{ index: 0, rule: 'x' }])
  })

  it('a rejection without a numeric code is -32603 and keeps the message', async () => {
    callFn.mockRejectedValue(new Error('boom'))
    const e = await call('status').catch((x) => x)
    expect(e).toBeInstanceOf(MffaiCallError)
    expect(e.code).toBe(-32603)
    expect(e.message).toBe('boom')
    expect(e.data).toBeUndefined()
  })

  it('an Error carrying code (jsdom fakes) maps the same', async () => {
    callFn.mockRejectedValue(Object.assign(new Error('nope'), { code: -32601 }))
    const e = await call('memory.health').catch((x) => x)
    expect(e.code).toBe(-32601)
    expect(isUnsupported(e)).toBe(true)
  })

  it('a missing preload method rejects as MffaiCallError, never throws synchronously', async () => {
    ;(window as any).forge = { mffai: {} }
    const p = call('status')
    await expect(p).rejects.toBeInstanceOf(MffaiCallError)
  })

  it('isUnsupported is -32601 only', () => {
    expect(isUnsupported(new MffaiCallError(-32601, 'x'))).toBe(true)
    expect(isUnsupported(new MffaiCallError(-32602, 'x'))).toBe(false)
    expect(isUnsupported({ code: -32601 })).toBe(true)
    expect(isUnsupported(new Error('x'))).toBe(false)
    expect(isUnsupported(null)).toBe(false)
  })

  it('cmd gives a fresh uuid each time', () => {
    const a = cmd(), b = cmd()
    expect(a).toMatch(/^[0-9a-f-]{36}$/)
    expect(a).not.toBe(b)
  })
})

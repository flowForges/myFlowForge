import { describe, expect, it } from 'vitest'
import { ControlMethods, FrameDecoder, MAX_FRAME_BYTES, PROTOCOL_VERSION, WorkerMethods, encodeFrame } from './index'

describe('framing', () => {
  it('round-trips', () => {
    const m = { jsonrpc: '2.0', id: 1, method: 'status' }
    expect(new FrameDecoder().push(encodeFrame(m))).toEqual([m])
  })
  it('U+2028/2029 in payload stays one message', () => {
    const m = { text: 'a\u2028b\u2029c' }
    const frame = encodeFrame(m)
    expect(frame.endsWith('\n')).toBe(true)
    expect(frame.indexOf('\n')).toBe(frame.length - 1)
    expect(new FrameDecoder().push(frame)).toEqual([m])
    // 原始 U+2028 出现在流里也不分帧
    expect(new FrameDecoder().push('{"t":"a\u2028b"}\n')).toEqual([{ t: 'a\u2028b' }])
  })
  it('handles chunk split mid-line', () => {
    const d = new FrameDecoder()
    const f = encodeFrame({ a: 1 })
    expect(d.push(f.slice(0, 4))).toEqual([])
    expect(d.push(f.slice(4))).toEqual([{ a: 1 }])
  })
  it('skips malformed line and reports it', () => {
    const errs: string[] = []
    const d = new FrameDecoder((line) => errs.push(line))
    expect(d.push('{bad\n' + encodeFrame({ ok: 1 }))).toEqual([{ ok: 1 }])
    expect(errs).toEqual(['{bad'])
  })
  it('multiple messages in one chunk', () => {
    expect(new FrameDecoder().push(encodeFrame({ a: 1 }) + encodeFrame({ b: 2 }))).toEqual([{ a: 1 }, { b: 2 }])
  })
})

describe('schemas', () => {
  it('version', () => expect(PROTOCOL_VERSION).toBe(1))
  const required: [typeof WorkerMethods | typeof ControlMethods, string, object][] = [
    [WorkerMethods, 'auth', {}],
    [WorkerMethods, 'hello', { clientVersion: '1' }],
    [WorkerMethods, 'events.subscribe', {}],
    [WorkerMethods, 'events.tail', {}],
    [WorkerMethods, 'session.create', {}],
    [WorkerMethods, 'session.prompt', { sessionId: 's', text: 't' }],
    [WorkerMethods, 'session.cancel', { sessionId: 's' }],
    [ControlMethods, 'auth', {}],
    [ControlMethods, 'autostart', { on: true }],
  ]
  it.each(required)('rejects missing required field: %#', (table, name, bad) => {
    const schema = (table as Record<string, { params: { safeParse(v: unknown): { success: boolean } } }>)[name].params
    expect(schema.safeParse(bad).success).toBe(false)
  })
  it('events.subscribe result accepts both shapes', () => {
    const r = WorkerMethods['events.subscribe'].result
    expect(r.safeParse({ ok: true }).success).toBe(true)
    expect(r.safeParse({ reset: true, lastSeq: 3 }).success).toBe(true)
    expect(r.safeParse({}).success).toBe(false)
  })
})

describe('FrameDecoder hardening', () => {
  it('rejects top-level arrays via onError', () => {
    const errs: string[] = []
    const d = new FrameDecoder((l) => errs.push(l))
    expect(d.push('[1,2]\n' + encodeFrame({ a: 1 }))).toEqual([{ a: 1 }])
    expect(errs).toEqual(['[1,2]'])
  })
  it('drops buffer and reports when a line exceeds MAX_FRAME_BYTES', () => {
    const errs: unknown[] = []
    const d = new FrameDecoder((_l, e) => errs.push(e))
    d.push('x'.repeat(MAX_FRAME_BYTES + 1))
    expect(errs).toHaveLength(1)
    expect(d.push(encodeFrame({ ok: 1 }))).toEqual([{ ok: 1 }])
  })
})

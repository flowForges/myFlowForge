// 按行传输:服务发来的每个字节都是敌意输入。这里只用 PassThrough 喂精确的字节
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { LineTransport } from './stdio'

function make(maxLine = 1000) {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const t = new LineTransport({ stdin, stdout, stderr }, { maxLine })
  const got: unknown[] = []
  const closed: string[] = []
  t.onMessage(m => got.push(m))
  t.onClose(why => closed.push(why))
  const written: string[] = []
  stdin.on('data', d => written.push(d.toString()))
  const tick = () => new Promise<void>(r => setImmediate(r))
  return { t, stdin, stdout, stderr, got, closed, written, tick }
}

describe('LineTransport', () => {
  it('reassembles a line split across chunks and handles several lines in one chunk', async () => {
    const r = make()
    r.stdout.write('{"a":')
    await r.tick()
    expect(r.got).toEqual([])
    r.stdout.write('1}\n{"b":2}\n{"c"')
    r.stdout.write(':3}\n')
    await r.tick()
    expect(r.got).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }])
  })

  it('accepts CRLF and skips blank lines', async () => {
    const r = make()
    r.stdout.write('{"a":1}\r\n\r\n\n   \n{"b":2}\r\n')
    await r.tick()
    expect(r.got).toEqual([{ a: 1 }, { b: 2 }])
  })

  it('decodes a multi-byte character split between chunks', async () => {
    const r = make()
    const bytes = Buffer.from('{"t":"héllo 世界"}\n')
    const cut = bytes.indexOf(0xe4) + 1 // 世 的第一个字节之后
    r.stdout.write(bytes.subarray(0, cut))
    await r.tick()
    r.stdout.write(bytes.subarray(cut))
    await r.tick()
    expect(r.got).toEqual([{ t: 'héllo 世界' }])
  })

  it('invalid UTF-8 does not throw or close; it becomes replacement characters', async () => {
    const r = make()
    r.stdout.write(Buffer.concat([Buffer.from('{"t":"a'), Buffer.from([0xff, 0xfe, 0xc3]), Buffer.from('b"}\n{"ok":true}\n')]))
    await r.tick()
    expect(r.closed).toEqual([])
    expect(r.got).toHaveLength(2)
    expect((r.got[0] as { t: string }).t).toMatch(/^a�+b$/)
    expect(r.got[1]).toEqual({ ok: true })
  })

  it('ignores non-JSON lines and JSON that is not an object', async () => {
    const r = make()
    r.stdout.write('hello\n123\n"str"\nnull\n[1,2]\n[{"a":1}]\n{broken\n{"ok":1}\n')
    await r.tick()
    expect(r.got).toEqual([{ ok: 1 }])
    expect(r.closed).toEqual([])
  })

  it('a line of exactly maxLine bytes passes; one more byte overflows once and later bytes are dropped', async () => {
    const r = make(50)
    const pad = (n: number) => `{"p":"${'x'.repeat(n - 8)}"}`
    expect(pad(50).length).toBe(50)
    r.stdout.write(`${pad(50)}\n`)
    await r.tick()
    expect(r.got).toHaveLength(1)
    r.stdout.write(`${pad(51)}\n{"after":1}\n`)
    await r.tick()
    expect(r.closed).toEqual(['overflow'])
    r.stdout.write('{"later":1}\n')
    await r.tick()
    expect(r.got).toHaveLength(1)
    expect(r.closed).toEqual(['overflow'])
  })

  it('an unterminated line past maxLine overflows without waiting for a newline', async () => {
    const r = make(100)
    r.stdout.write('x'.repeat(60))
    await r.tick()
    expect(r.closed).toEqual([])
    r.stdout.write('x'.repeat(60))
    await r.tick()
    expect(r.closed).toEqual(['overflow'])
  })

  it('counts bytes, not characters', async () => {
    const r = make(20)
    r.stdout.write(`{"t":"${'世'.repeat(6)}"}\n`) // 8 个字符,24 字节
    await r.tick()
    expect(r.closed).toEqual(['overflow'])
  })

  it('the end of stdout closes once with exit, and a partial last line is not delivered', async () => {
    const r = make()
    r.stdout.write('{"a":1}\n{"half":')
    r.stdout.end()
    await r.tick()
    await r.tick()
    expect(r.got).toEqual([{ a: 1 }])
    expect(r.closed).toEqual(['exit'])
  })

  it('send writes one JSON line; a string with a newline stays on one line', async () => {
    const r = make()
    r.t.send({ jsonrpc: '2.0', id: 1, method: 'x', params: { s: 'a\nb\r\nc d' } })
    await r.tick()
    const out = r.written.join('')
    expect(out.endsWith('\n')).toBe(true)
    expect(out.slice(0, -1)).not.toContain('\n')
    expect(JSON.parse(out).params.s).toBe('a\nb\r\nc d')
  })

  it('send after close writes nothing and does not throw; an EPIPE on stdin does not crash', async () => {
    const r = make()
    r.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
    r.stdout.end()
    await r.tick()
    await r.tick()
    expect(r.closed).toEqual(['exit'])
    expect(() => r.t.send({ a: 1 })).not.toThrow()
    await r.tick()
    expect(r.written.join('')).toBe('')
  })

  it('stderr keeps only the last 64 KB, is never delivered as a message, and survives close', async () => {
    const r = make()
    r.stderr.write('{"fake":"message"}\n')
    r.stderr.write('a'.repeat(100_000))
    r.stderr.write('END-MARK')
    await r.tick()
    const tail = r.t.stderrTail()
    expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(64 * 1024)
    expect(Buffer.byteLength(tail)).toBeGreaterThan(60 * 1024)
    expect(tail.endsWith('END-MARK')).toBe(true)
    expect(tail).not.toContain('fake')
    expect(r.got).toEqual([])
    r.stdout.end()
    await r.tick()
    expect(r.t.stderrTail().endsWith('END-MARK')).toBe(true)
  })

  it('close() ends the streams, does not call onClose (the caller asked), and is idempotent', async () => {
    const r = make()
    r.t.close()
    r.t.close()
    await r.tick()
    expect(r.stdin.writableEnded).toBe(true)
    expect(r.closed).toEqual([])
  })
})

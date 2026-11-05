// 按行传输:服务发来的每个字节都是敌意输入。这里只用 PassThrough 喂精确的字节
import { PassThrough, Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { LineTransport, MAX_LINE } from './stdio'

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
    expect(r.stdin.destroyed).toBe(true)
    expect(r.stdout.destroyed).toBe(true)
    expect(r.stderr.destroyed).toBe(true)
    expect(r.closed).toEqual([])
  })

  it('exports the 4 MB line limit', () => {
    expect(MAX_LINE).toBe(4 * 1024 * 1024)
  })

  it('U+2028 and U+2029 are escaped on the wire', async () => {
    const r = make()
    r.t.send({ s: 'a b c' })
    await r.tick()
    const out = r.written.join('')
    expect(out).not.toContain(' ')
    expect(out).not.toContain(' ')
    expect(out).toContain('\\u2028')
    expect(JSON.parse(out).s).toBe('a b c')
  })

  it('an unterminated line of exactly maxLine bytes waits for its newline instead of overflowing', async () => {
    const r = make(50)
    r.stdout.write(`{"p":"${'x'.repeat(42)}"}`)
    await r.tick()
    expect(r.closed).toEqual([])
    r.stdout.write('\n')
    await r.tick()
    expect(r.got).toHaveLength(1)
    expect(r.closed).toEqual([])
  })

  it('an error event on stderr or stdin does not throw; one on stdout closes with exit', async () => {
    const r = make()
    expect(() => r.stderr.emit('error', new Error('boom'))).not.toThrow()
    expect(() => r.stdin.emit('error', new Error('boom'))).not.toThrow()
    expect(r.closed).toEqual([])
    r.stdout.emit('error', new Error('boom'))
    await r.tick()
    expect(r.closed).toEqual(['exit'])
  })

  it('overflow destroys all three streams so nothing stays queued', async () => {
    const r = make(50)
    r.stdout.write('x'.repeat(80))
    await r.tick()
    expect(r.closed).toEqual(['overflow'])
    expect(r.stdout.destroyed).toBe(true)
    expect(r.stdin.destroyed).toBe(true)
  })

  it('a line delivered in a million one-byte writes does not hold a million buffers', async () => {
    const r = make(4 * 1024 * 1024)
    const before = process.memoryUsage().rss
    const started = Date.now()
    for (let i = 0; i < 1_000_000; i++) r.stdout.emit('data', Buffer.from([120]))
    r.stdout.emit('data', Buffer.from('\n{"after":1}\n'))
    expect(process.memoryUsage().rss - before).toBeLessThan(150 * 1024 * 1024)
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(r.got).toEqual([{ after: 1 }])
  })

  it('writes queued past four times maxLine close with overflow; below that they do not', async () => {
    const stdin = new Writable({ write() {} }) // 永远不消费
    const t = new LineTransport({ stdin, stdout: new PassThrough(), stderr: new PassThrough() }, { maxLine: 1000 })
    const closed: string[] = []
    t.onClose(w => closed.push(w))
    t.send({ s: 'x'.repeat(2900) })
    expect(closed).toEqual([])
    t.send({ s: 'y'.repeat(1200) })
    expect(closed).toEqual(['overflow'])
    expect(stdin.destroyed).toBe(true)
  })

  it('congested says when stdin needs draining', () => {
    const stdin = new Writable({ highWaterMark: 10, write() {} })
    const t = new LineTransport({ stdin, stdout: new PassThrough(), stderr: new PassThrough() }, { maxLine: 1000 })
    expect(t.congested).toBe(false)
    t.send({ s: 'x'.repeat(30) })
    expect(t.congested).toBe(true)
  })

  it('messages carry their byte size; junk and blank lines are reported through onJunk', async () => {
    const r = make()
    const sizes: number[] = []
    const junk: number[] = []
    r.t.onMessage((_m, bytes) => sizes.push(bytes))
    r.t.onJunk(bytes => junk.push(bytes))
    r.stdout.write('{"a":1}\nhello\n\n[1]\n')
    await r.tick()
    expect(sizes).toEqual([8])
    expect(junk).toEqual([6, 1, 4])
  })

  it('overflow() ends the stream with overflow once', async () => {
    const r = make()
    r.t.overflow()
    r.t.overflow()
    await r.tick()
    expect(r.closed).toEqual(['overflow'])
    expect(r.stdout.destroyed).toBe(true)
  })
})

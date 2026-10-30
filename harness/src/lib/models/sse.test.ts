import { describe, expect, it } from 'vitest'
import { parseSSE, type SSEEvent } from './sse'

const enc = new TextEncoder()
const streamOf = (chunks: (string | Uint8Array)[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const x of chunks) c.enqueue(typeof x === 'string' ? enc.encode(x) : x)
      c.close()
    },
  })
const collect = async (chunks: (string | Uint8Array)[]) => {
  const out: SSEEvent[] = []
  for await (const e of parseSSE(streamOf(chunks))) out.push(e)
  return out
}

describe('parseSSE', () => {
  it('single data frames, event names, comments', async () => {
    expect(await collect([': keep-alive\n\nevent: response.created\ndata: {"a":1}\n\ndata: [DONE]\n\n'])).toEqual([
      { event: 'response.created', data: '{"a":1}' },
      { data: '[DONE]' },
    ])
  })

  it('multi-line data joins with \\n; value without space after colon; id/retry ignored', async () => {
    expect(await collect(['id: 7\nretry: 100\ndata: line1\ndata:line2\ndata\n\n'])).toEqual([{ data: 'line1\nline2\n' }])
  })

  it('CRLF and bare CR line endings, including CR/LF split across chunks', async () => {
    expect(await collect(['event: x\r\ndata: 1\r', '\n\r\n', 'data: 2\r\rdata: 3\n\n'])).toEqual([
      { event: 'x', data: '1' },
      { data: '2' },
      { data: '3' },
    ])
  })

  it('blank frame with no data is not dispatched; event name resets per frame', async () => {
    expect(await collect(['event: ping\n\ndata: a\n\n'])).toEqual([{ data: 'a' }])
  })

  it('a frame and a 3-byte UTF-8 char split across chunks decode exactly once', async () => {
    const bytes = enc.encode('event: delta\ndata: {"t":"中文"}\n\n')
    const zhong = bytes.indexOf(0xe4) // "中" = E4 B8 AD
    expect(bytes[zhong + 1]).toBe(0xb8)
    // 1 + 2 字节切开,同时帧本身也跨了三块
    const parts = [bytes.slice(0, 5), bytes.slice(5, zhong + 1), bytes.slice(zhong + 1, bytes.length - 1), bytes.slice(bytes.length - 1)]
    expect(await collect(parts)).toEqual([{ event: 'delta', data: '{"t":"中文"}' }])
  })

  it('byte-by-byte delivery', async () => {
    const bytes = enc.encode('data: 你好\n\ndata: 🌏\n\n')
    expect(await collect([...bytes].map(b => new Uint8Array([b])))).toEqual([{ data: '你好' }, { data: '🌏' }])
  })

  it('EOF: complete lines without trailing blank line are dispatched, a partial line is dropped', async () => {
    expect(await collect(['data: a\n\ndata: b\n'])).toEqual([{ data: 'a' }, { data: 'b' }])
    expect(await collect(['data: a\n\ndata: {"trunc'])).toEqual([{ data: 'a' }])
  })

  it('stream error propagates after earlier frames', async () => {
    let n = 0
    const s = new ReadableStream<Uint8Array>({
      pull(c) {
        if (n++ === 0) c.enqueue(enc.encode('data: a\n\ndata: partial'))
        else c.error(new Error('socket reset'))
      },
    })
    const out: SSEEvent[] = []
    await expect((async () => { for await (const e of parseSSE(s)) out.push(e) })()).rejects.toThrow('socket reset')
    expect(out).toEqual([{ data: 'a' }])
  })

  it('consumer break cancels the underlying stream', async () => {
    let cancelled = false
    const s = new ReadableStream<Uint8Array>({
      pull(c) { c.enqueue(enc.encode('data: x\n\n')) },
      cancel() { cancelled = true },
    })
    for await (const _ of parseSSE(s)) break
    expect(cancelled).toBe(true)
  })
})

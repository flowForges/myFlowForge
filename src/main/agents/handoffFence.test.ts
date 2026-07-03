import { describe, it, expect, vi } from 'vitest'
import { createFenceScanner } from './handoffFence'
import type { HandoffPayload } from './types'

function makeScanner() {
  const calls: HandoffPayload[] = []
  const onHandoff = vi.fn((p: HandoffPayload) => { calls.push(p) })
  const scanner = createFenceScanner(onHandoff)
  return { scanner, onHandoff, calls }
}

describe('handoffFence – complete fence', () => {
  it('calls onHandoff, swallows all fence lines, passes surrounding lines through in order', () => {
    const { scanner, onHandoff, calls } = makeScanner()

    const out: string[] = []
    out.push(...scanner.feedLine('before'))
    out.push(...scanner.feedLine('```forge:handoff'))
    out.push(...scanner.feedLine('{"summary":"done","artifacts":[{"path":"out.md","kind":"md"}]}'))
    out.push(...scanner.feedLine('```'))
    out.push(...scanner.feedLine('after'))

    expect(out).toEqual(['before', 'after'])
    expect(onHandoff).toHaveBeenCalledOnce()
    expect(calls[0]).toEqual({ summary: 'done', artifacts: [{ path: 'out.md', kind: 'md' }] })
  })
})

describe('handoffFence – bad JSON body', () => {
  it('does NOT call onHandoff; all lines (including fence markers) returned verbatim from closing feedLine', () => {
    const { scanner, onHandoff } = makeScanner()

    const out: string[] = []
    out.push(...scanner.feedLine('```forge:handoff'))
    out.push(...scanner.feedLine('NOT JSON'))
    const closing = scanner.feedLine('```')
    out.push(...closing)

    expect(onHandoff).not.toHaveBeenCalled()
    expect(out).toEqual(['```forge:handoff', 'NOT JSON', '```'])
  })
})

describe('handoffFence – summary missing or empty', () => {
  it('fails open when summary key is absent', () => {
    const { scanner, onHandoff } = makeScanner()

    const out: string[] = []
    out.push(...scanner.feedLine('```forge:handoff'))
    out.push(...scanner.feedLine('{"artifacts":[]}'))
    out.push(...scanner.feedLine('```'))

    expect(onHandoff).not.toHaveBeenCalled()
    expect(out).toEqual(['```forge:handoff', '{"artifacts":[]}', '```'])
  })

  it('fails open when summary is empty string', () => {
    const { scanner, onHandoff } = makeScanner()

    const out: string[] = []
    out.push(...scanner.feedLine('```forge:handoff'))
    out.push(...scanner.feedLine('{"summary":""}'))
    out.push(...scanner.feedLine('```'))

    expect(onHandoff).not.toHaveBeenCalled()
    expect(out).toEqual(['```forge:handoff', '{"summary":""}', '```'])
  })
})

describe('handoffFence – unclosed fence', () => {
  it('feedLine swallows buffered lines; flush() returns open line + buffer', () => {
    const { scanner, onHandoff } = makeScanner()

    const out: string[] = []
    out.push(...scanner.feedLine('```forge:handoff'))
    out.push(...scanner.feedLine('{"summary":"work in progress"'))
    // no closing fence

    expect(out).toEqual([])
    expect(onHandoff).not.toHaveBeenCalled()

    const flushed = scanner.flush()
    expect(flushed).toEqual(['```forge:handoff', '{"summary":"work in progress"'])

    // flush again: no-op
    expect(scanner.flush()).toEqual([])
  })
})

describe('handoffFence – runaway unclosed fence (bounded buffer)', () => {
  it('fails open after exceeding the line cap instead of swallowing the rest of the stream', () => {
    const { scanner, onHandoff } = makeScanner()

    const out: string[] = []
    out.push(...scanner.feedLine('```forge:handoff'))
    // A stray fence opener that never closes must not buffer the whole stream forever.
    for (let i = 0; i < 200; i++) out.push(...scanner.feedLine(`body ${i}`))
    out.push(...scanner.feedLine('normal again'))

    expect(onHandoff).not.toHaveBeenCalled()
    expect(out).toContain('```forge:handoff')   // open line drained on fail-open
    expect(out).toContain('body 0')
    expect(out).toContain('normal again')        // post-abandon line passes through, not swallowed
  })
})

describe('handoffFence – two fences in one stream', () => {
  it('calls onHandoff twice with separate payloads', () => {
    const { scanner, onHandoff, calls } = makeScanner()

    const out: string[] = []
    out.push(...scanner.feedLine('line1'))
    out.push(...scanner.feedLine('```forge:handoff'))
    out.push(...scanner.feedLine('{"summary":"first"}'))
    out.push(...scanner.feedLine('```'))
    out.push(...scanner.feedLine('between'))
    out.push(...scanner.feedLine('```forge:handoff'))
    out.push(...scanner.feedLine('{"summary":"second","artifacts":[{"path":"a.ts","kind":"ts"}]}'))
    out.push(...scanner.feedLine('```'))
    out.push(...scanner.feedLine('line2'))

    expect(out).toEqual(['line1', 'between', 'line2'])
    expect(onHandoff).toHaveBeenCalledTimes(2)
    expect(calls[0].summary).toBe('first')
    expect(calls[1].summary).toBe('second')
    expect(calls[1].artifacts).toEqual([{ path: 'a.ts', kind: 'ts' }])
  })
})

describe('handoffFence – artifacts filtering', () => {
  it('drops artifacts field entirely when not an array', () => {
    const { scanner, calls } = makeScanner()

    scanner.feedLine('```forge:handoff')
    scanner.feedLine('{"summary":"s","artifacts":"oops"}')
    scanner.feedLine('```')

    expect(calls[0]).toEqual({ summary: 's' })
    expect('artifacts' in calls[0]).toBe(false)
  })

  it('keeps only items where both path and kind are strings', () => {
    const { scanner, calls } = makeScanner()

    const body = JSON.stringify({
      summary: 's',
      artifacts: [
        { path: 'good.md', kind: 'md' },
        { path: 'bad.md' },               // missing kind
        { kind: 'ts' },                    // missing path
        { path: 42, kind: 'ts' },          // path not string
        null,
        'string-item',
      ],
    })

    scanner.feedLine('```forge:handoff')
    scanner.feedLine(body)
    scanner.feedLine('```')

    expect(calls[0].artifacts).toEqual([{ path: 'good.md', kind: 'md' }])
  })

  it('produces an empty artifacts array when all items are invalid', () => {
    const { scanner, calls } = makeScanner()

    scanner.feedLine('```forge:handoff')
    scanner.feedLine('{"summary":"s","artifacts":[null,1,{"path":1,"kind":2}]}')
    scanner.feedLine('```')

    expect(calls[0].artifacts).toEqual([])
  })
})

describe('handoffFence – indented fence markers', () => {
  it('recognises fence open/close with leading spaces (trim-based)', () => {
    const { scanner, onHandoff, calls } = makeScanner()

    const out: string[] = []
    out.push(...scanner.feedLine('   ```forge:handoff'))
    out.push(...scanner.feedLine('{"summary":"indented"}'))
    out.push(...scanner.feedLine('   ```'))

    expect(out).toEqual([])
    expect(onHandoff).toHaveBeenCalledOnce()
    expect(calls[0].summary).toBe('indented')
  })
})

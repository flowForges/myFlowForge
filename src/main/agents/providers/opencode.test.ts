import { describe, it, expect } from 'vitest'
import { parseOpencodeEvent, opencodeErrorMessage, opencodeUsage, parseOpencodeModels, opencodeDelta } from './opencode'

describe('opencodeDelta (cumulative part.text → incremental delta)', () => {
  it('emits only the growth for cumulative snapshots (the real opencode --format json shape)', () => {
    // opencode streams the FULL text of a part on every update; feeding those as deltas must yield
    // the original text once, not a quadratic pile-up.
    const snaps = ['分', '分析', '分析仓', '分析仓库']
    let prev = ''
    let assembled = ''
    for (const s of snaps) { assembled += opencodeDelta(prev, s); prev = s }
    expect(assembled).toBe('分析仓库')   // NOT '分分析分析仓分析仓库'
  })
  it('passes genuine incremental deltas through unchanged (prefix check auto-detects)', () => {
    const deltas = ['Hello', ' world', ' foo']
    let prev = ''
    let assembled = ''
    for (const d of deltas) { assembled += opencodeDelta(prev, d); prev = d }
    expect(assembled).toBe('Hello world foo')
  })
  it('resets cleanly when a new part starts (text no longer extends the previous)', () => {
    expect(opencodeDelta('Hello world', 'OK')).toBe('OK')
  })
})

describe('parseOpencodeEvent', () => {
  it('reasoning → think', () => {
    expect(parseOpencodeEvent({ type: 'reasoning', part: { type: 'reasoning', text: 'thinking…' } }))
      .toEqual([{ kind: 'think', text: 'thinking…' }])
  })
  it('text → assistant', () => {
    expect(parseOpencodeEvent({ type: 'text', part: { type: 'text', text: 'hi' } }))
      .toEqual([{ kind: 'assistant', text: 'hi' }])
  })
  it('step_start → session id', () => {
    expect(parseOpencodeEvent({ type: 'step_start', sessionID: 'ses_1', part: {} }))
      .toEqual([{ kind: 'session', id: 'ses_1' }])
  })
  it('empty text is ignored; non-object → []', () => {
    expect(parseOpencodeEvent({ type: 'text', part: { text: '' } })).toEqual([])
    expect(parseOpencodeEvent(null)).toEqual([])
  })
})

describe('opencodeErrorMessage', () => {
  it('extracts the nested API error message (401 etc.)', () => {
    const ev = { type: 'error', error: { name: 'APIError', data: { message: 'The API key status is not active', statusCode: 401 } } }
    expect(opencodeErrorMessage(ev)).toBe('The API key status is not active')
  })
  it('non-error event → null', () => {
    expect(opencodeErrorMessage({ type: 'text', part: { text: 'hi' } })).toBeNull()
  })
})

describe('opencodeUsage', () => {
  it('reads tokens.total from step_finish', () => {
    expect(opencodeUsage({ type: 'step_finish', part: { tokens: { total: 19894 } } })).toBe(19894)
    expect(opencodeUsage({ type: 'text', part: { text: 'x' } })).toBeNull()
  })
})

describe('parseOpencodeModels', () => {
  it('maps "provider/model" lines, keeping the full id, label=model, desc=provider', () => {
    const out = parseOpencodeModels('opencode/big-pickle\nmyprovider/ark-code-latest\n\ngarbage')
    expect(out).toEqual([
      { id: 'opencode/big-pickle', label: 'big-pickle', description: 'opencode' },
      { id: 'myprovider/ark-code-latest', label: 'ark-code-latest', description: 'myprovider' },
    ])
  })
})

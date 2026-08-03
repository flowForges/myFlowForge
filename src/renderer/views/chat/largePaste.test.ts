import { describe, it, expect } from 'vitest'
import { shouldOffloadPaste, pastedFileName, base64OfUtf8, PASTE_OFFLOAD_THRESHOLD } from './largePaste'

describe('shouldOffloadPaste', () => {
  it('is false for small pastes, true at/over the threshold', () => {
    expect(shouldOffloadPaste('x'.repeat(PASTE_OFFLOAD_THRESHOLD - 1))).toBe(false)
    expect(shouldOffloadPaste('x'.repeat(PASTE_OFFLOAD_THRESHOLD))).toBe(true)
  })
})

describe('pastedFileName', () => {
  const at = new Date(2026, 7, 3, 9, 5, 7) // 2026-08-03 09:05:07 (month is 0-based)
  it('uses .json when the text looks like JSON', () => {
    expect(pastedFileName('  {"a":1}\n', at)).toBe('pasted-20260803-090507.json')
    expect(pastedFileName('[1,2,3]', at)).toBe('pasted-20260803-090507.json')
  })
  it('uses .txt otherwise', () => {
    expect(pastedFileName('just some prose', at)).toBe('pasted-20260803-090507.txt')
  })
})

describe('base64OfUtf8', () => {
  it('round-trips CJK text through UTF-8 (btoa alone would throw)', () => {
    const s = '上下文消耗 { "键": "值" }'
    const b64 = base64OfUtf8(s)
    // Decode back the same way the main-process savePaste does (Buffer.from(b64,'base64')).
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
    expect(new TextDecoder().decode(bytes)).toBe(s)
  })
  it('handles large input without overflowing apply()', () => {
    const big = '数'.repeat(100_000)
    expect(() => base64OfUtf8(big)).not.toThrow()
  })
})

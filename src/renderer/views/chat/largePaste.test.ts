import { describe, it, expect } from 'vitest'
import {
  shouldOffloadPaste, pastedFileName, base64OfUtf8, PASTE_OFFLOAD_THRESHOLD,
  pastePlaceholder, insertPastePlaceholder,
} from './largePaste'

describe('shouldOffloadPaste', () => {
  it('is false for small pastes, true at/over the threshold', () => {
    expect(shouldOffloadPaste('x'.repeat(PASTE_OFFLOAD_THRESHOLD - 1))).toBe(false)
    expect(shouldOffloadPaste('x'.repeat(PASTE_OFFLOAD_THRESHOLD))).toBe(true)
  })

  it('一个中等函数(~1.5k)还留在输入框里,别转文件', () => {
    expect(shouldOffloadPaste('x'.repeat(1_500))).toBe(false)
  })
})

describe('insertPastePlaceholder', () => {
  const N = 'pasted-20260803-090507.txt'

  it('插在光标处,并返回插入后的光标位置', () => {
    const r = insertPastePlaceholder('先看这个报错：\n\n哪里错了？', 8, 8, N)
    expect(r.text).toBe(`先看这个报错：\n[${N}]\n哪里错了？`)
    expect(r.text.slice(0, r.caret)).toBe(`先看这个报错：\n[${N}]`)
  })

  it('紧贴文字时两侧各补一个空格,免得读成一个词', () => {
    expect(insertPastePlaceholder('对比a和b', 3, 3, N).text).toBe(`对比a [${N}] 和b`)
  })

  it('已经有空白就不再补', () => {
    expect(insertPastePlaceholder('对比 和b', 3, 3, N).text).toBe(`对比 [${N}] 和b`)
  })

  it('空输入框:两侧都不补', () => {
    expect(insertPastePlaceholder('', 0, 0, N).text).toBe(`[${N}]`)
  })

  it('选中一段再粘 = 替换掉选中的那段(与原生粘贴一致)', () => {
    expect(insertPastePlaceholder('保留XXXX保留', 2, 6, N).text).toBe(`保留 [${N}] 保留`)
  })

  it('连粘两坨各自留下位置,不会互相覆盖', () => {
    const a = insertPastePlaceholder('先看报错：\n\n再对比配置：\n', 6, 6, 'a.txt')
    const b = insertPastePlaceholder(a.text, a.text.length, a.text.length, 'b.json')
    expect(b.text).toBe('先看报错：\n[a.txt]\n再对比配置：\n[b.json]')
  })
})

describe('pastePlaceholder', () => {
  it('是方括号包住的文件名', () => {
    expect(pastePlaceholder('pasted-1.txt')).toBe('[pasted-1.txt]')
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

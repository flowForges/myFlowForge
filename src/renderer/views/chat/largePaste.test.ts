import { describe, it, expect } from 'vitest'
import {
  shouldOffloadPaste, pastedFileName, pastedFileNameForFile, base64OfUtf8, PASTE_OFFLOAD_THRESHOLD,
  pastePlaceholder, insertPastePlaceholder, insertPastedText, resolvePasteSelection,
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

// ★ 存盘是异步的:选区和正文都是 await 之前读的,那几百毫秒里用户还能继续打字。
// 插入前必须拿最新正文重新判定一次选区,否则要么把占位符插错位置,要么把用户敲的字回滚掉。
describe('resolvePasteSelection', () => {
  it('用户在插入点之后接着打字 → 选区仍然有效,原位插', () => {
    expect(resolvePasteSelection('先看这个报错，', '先看这个报错', 6, 6)).toEqual({ start: 6, end: 6 })
  })
  it('正文一个字没动 → 原样返回', () => {
    expect(resolvePasteSelection('abc', 'abc', 1, 1)).toEqual({ start: 1, end: 1 })
  })
  it('用户在插入点之前插了字 → 旧下标已经指向别处,退到末尾', () => {
    // 粘贴时是 'abc' 的下标 3;等待期间在最前面插了 'XY' → 'XYabc'
    expect(resolvePasteSelection('XYabc', 'abc', 3, 3)).toEqual({ start: 5, end: 5 })
  })
  it('用户在等待期间删字删到比选区还短 → 退到末尾,不越界', () => {
    expect(resolvePasteSelection('a', 'abcdef', 4, 6)).toEqual({ start: 1, end: 1 })
  })
  it('选中一段再粘贴:那段还在就替换它,被改过就退到末尾', () => {
    expect(resolvePasteSelection('保留XXXX保留', '保留XXXX保留', 2, 6)).toEqual({ start: 2, end: 6 })
    // 选中的那段被改掉了 → 退到末尾(len 8),而不是硬按旧下标 2..6 把新内容也吃掉
    expect(resolvePasteSelection('保留YYYY保留', '保留XXXX保留', 2, 6)).toEqual({ start: 8, end: 8 })
  })
})

describe('insertPastedText', () => {
  it('按原生粘贴语义插回选区(替换选中段),不加空格不加括号', () => {
    expect(insertPastedText('abcd', 2, 2, 'XY')).toEqual({ text: 'abXYcd', caret: 4 })
    expect(insertPastedText('保留XXXX保留', 2, 6, '新')).toEqual({ text: '保留新保留', caret: 3 })
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

describe('pastedFileNameForFile —— 剪贴板图片改名,有意义的原名保留', () => {
  const at = new Date(2026, 7, 9, 21, 4, 55) // 21:04:55

  it('剪贴板截图(Chrome 一律给 image.png)改成 img-时分秒', () => {
    expect(pastedFileNameForFile('image.png', at)).toBe('img-210455.png')
    expect(pastedFileNameForFile('image.jpeg', at)).toBe('img-210455.jpeg')
    // 大小写与 Windows/其它浏览器的常见变体
    expect(pastedFileNameForFile('Image.PNG', at)).toBe('img-210455.PNG')
    expect(pastedFileNameForFile('屏幕截图.png', at)).toBe('img-210455.png')
  })

  it('用户自己起的名字原样保留 —— 那比我们生成的更有信息量', () => {
    expect(pastedFileNameForFile('hook.jpg', at)).toBe('hook.jpg')
    expect(pastedFileNameForFile('设计稿-v3.png', at)).toBe('设计稿-v3.png')
    expect(pastedFileNameForFile('report.pdf', at)).toBe('report.pdf')
  })

  it('没有扩展名 / 空名字的 blob 也得有个能落盘的名字', () => {
    expect(pastedFileNameForFile('', at)).toBe('img-210455.png')
    expect(pastedFileNameForFile('image', at)).toBe('img-210455.png')
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

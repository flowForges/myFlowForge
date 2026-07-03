import { describe, it, expect } from 'vitest'
import { highlight } from './highlight'

describe('highlight', () => {
  it('marks keywords, strings, and line comments for a known language', () => {
    const toks = highlight(`const x = "hi" // note`, 'ts')
    expect(toks.some(t => t.cls === 'kw' && t.text === 'const')).toBe(true)
    expect(toks.some(t => t.cls === 'st' && t.text.includes('hi'))).toBe(true)
    expect(toks.some(t => t.cls === 'cm' && t.text.includes('// note'))).toBe(true)
    expect(toks.map(t => t.text).join('')).toBe(`const x = "hi" // note`)
  })
  it('returns a single plain token for an unknown language', () => {
    expect(highlight('const x = 1', 'text')).toEqual([{ cls: null, text: 'const x = 1' }])
  })
  it('treats a # line as a comment in python', () => {
    const toks = highlight('# hello', 'py')
    expect(toks).toEqual([{ cls: 'cm', text: '# hello' }])
  })
  it('highlights go keywords, a string and a // comment', () => {
    const toks = highlight('func main() { return "hi" } // c', 'go')
    expect(toks.some(t => t.cls === 'kw' && t.text === 'func')).toBe(true)
    expect(toks.some(t => t.cls === 'kw' && t.text === 'return')).toBe(true)
    expect(toks.some(t => t.cls === 'st' && t.text.includes('hi'))).toBe(true)
    expect(toks.some(t => t.cls === 'cm' && t.text.includes('// c'))).toBe(true)
    expect(toks.map(t => t.text).join('')).toBe('func main() { return "hi" } // c')
  })
  it('resolves language aliases (golang→go, typescript→ts)', () => {
    expect(highlight('func x()', 'golang').some(t => t.cls === 'kw' && t.text === 'func')).toBe(true)
    expect(highlight('const x = 1', 'typescript').some(t => t.cls === 'kw' && t.text === 'const')).toBe(true)
    expect(highlight('const x = 1', 'javascript').some(t => t.cls === 'kw' && t.text === 'const')).toBe(true)
  })
  it('tags numeric literals as numbers', () => {
    const toks = highlight('let x = 42', 'ts')
    expect(toks.some(t => t.cls === 'nu' && t.text === '42')).toBe(true)
  })
  it('highlights sql keywords case-insensitively', () => {
    const toks = highlight('SELECT * FROM t', 'sql')
    expect(toks.some(t => t.cls === 'kw' && /select/i.test(t.text))).toBe(true)
  })
})

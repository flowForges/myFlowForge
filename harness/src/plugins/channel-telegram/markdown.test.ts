import { describe, expect, it } from 'vitest'
import { capEntities, splitChunks, toEntities, type Entity } from './markdown'

const slices = (r: { text: string; entities: Entity[] }) => r.entities.map(e => [e.type, r.text.slice(e.offset, e.offset + e.length)])
const lone = (s: string) => /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s)

describe('toEntities', () => {
  it('bold, code and pre; offsets are UTF-16 units with emoji and CJK before them', () => {
    const r = toEntities('你好😀 **粗体😀** 然后 `代码` 完\n```ts\nconst a = "😀"\n```\n尾')
    expect(r.text).toBe('你好😀 粗体😀 然后 代码 完\nconst a = "😀"\n尾')
    expect(slices(r)).toEqual([['bold', '粗体😀'], ['code', '代码'], ['pre', 'const a = "😀"']])
    expect(r.entities[2]?.language).toBe('ts')
  })
  it('headings become bold', () => {
    const r = toEntities('## 标题 😀\n正文')
    expect(r.text).toBe('标题 😀\n正文')
    expect(slices(r)).toEqual([['bold', '标题 😀']])
  })
  it('unclosed fence runs to the end', () => {
    const r = toEntities('前\n```py\nx = 1\ny = 2')
    expect(r.text).toBe('前\nx = 1\ny = 2')
    expect(slices(r)).toEqual([['pre', 'x = 1\ny = 2']])
  })
  it('a fence inside a line is not a fence', () => {
    const r = toEntities('say ```not``` here')
    expect(r.entities.filter(e => e.type === 'pre')).toEqual([])
  })
  it('unmatched and nested markers stay literal', () => {
    expect(toEntities('a ** b').text).toBe('a ** b')
    expect(toEntities('**a').entities).toEqual([])
    expect(toEntities('`a').text).toBe('`a')
    const n = toEntities('**a **b** c**')
    expect(n.text).toContain('**')
    expect(n.entities.every(e => e.type === 'bold' && !n.text.slice(e.offset, e.offset + e.length).includes('*'))).toBe(true)
    // markers inside code are literal
    const c = toEntities('`**x**`')
    expect(c.text).toBe('**x**')
    expect(slices(c)).toEqual([['code', '**x**']])
  })
  it('a link stays text, no text_link', () => {
    const r = toEntities('[x](https://evil.example)')
    expect(r.text).toBe('[x](https://evil.example)')
    expect(r.entities).toEqual([])
  })
  it('pre language outside the whitelist is dropped', () => {
    for (const bad of ['Python', 'a'.repeat(21), 'x"y', '<b>', 'ts;rm']) {
      const r = toEntities('```' + bad + '\nx\n```')
      expect(r.entities[0]?.language).toBeUndefined()
      expect(r.entities[0]?.type).toBe('pre')
    }
    expect(toEntities('```c++\nx\n```').entities[0]?.language).toBe('c++')
    expect(toEntities('```c#\nx\n```').entities[0]?.language).toBe('c#')
  })
  it('an empty fence yields no entity', () => {
    expect(toEntities('```\n```').entities).toEqual([])
  })
})

describe('splitChunks', () => {
  it('every chunk fits, the concatenation is the source, no broken pair', () => {
    const src = ('行😀'.repeat(30) + '\n').repeat(200) + '😀'.repeat(5000)
    const parts = splitChunks(src, [], 3900)
    expect(parts.map(p => p.text).join('')).toBe(src)
    for (const p of parts) {
      expect(p.text.length).toBeLessThanOrEqual(3900)
      expect(lone(p.text)).toBe(false)
    }
  })
  it('prefers a newline', () => {
    const src = 'a'.repeat(3000) + '\n' + 'b'.repeat(3000)
    expect(splitChunks(src, [], 3900)[0]!.text).toBe('a'.repeat(3000) + '\n')
  })
  it('splits a pre on both sides, entities re-based', () => {
    const body = 'x'.repeat(5000)
    const src = '前言\n' + body + '\n后记'
    const ents: Entity[] = [{ type: 'pre', offset: 3, length: 5000, language: 'ts' }, { type: 'bold', offset: 0, length: 2 }]
    const parts = splitChunks(src, ents, 3900)
    expect(parts.length).toBe(2)
    const pres = parts.map(p => p.entities.find(e => e.type === 'pre'))
    expect(pres[0]).toBeDefined()
    expect(pres[1]).toBeDefined()
    expect(pres[0]!.language).toBe('ts')
    expect(pres[1]!.language).toBe('ts')
    expect(parts[0]!.text.slice(pres[0]!.offset, pres[0]!.offset + pres[0]!.length)).toMatch(/^x+$/)
    expect(parts[1]!.text.slice(pres[1]!.offset, pres[1]!.offset + pres[1]!.length)).toMatch(/^x+$/)
    const xs = (parts[0]!.text.slice(pres[0]!.offset, pres[0]!.offset + pres[0]!.length) + parts[1]!.text.slice(pres[1]!.offset, pres[1]!.offset + pres[1]!.length)).length
    expect(xs).toBeGreaterThanOrEqual(5000)
    expect(parts[0]!.entities.find(e => e.type === 'bold')).toEqual({ type: 'bold', offset: 0, length: 2 })
    expect(parts[1]!.entities.find(e => e.type === 'bold')).toBeUndefined()
  })
  it('no zero-length entities', () => {
    const src = 'a'.repeat(3900) + 'b'
    for (const p of splitChunks(src, [{ type: 'bold', offset: 0, length: 3900 }], 3900)) for (const e of p.entities) expect(e.length).toBeGreaterThan(0)
  })
})

describe('capEntities', () => {
  const mk = (type: Entity['type'], n: number) => Array.from({ length: n }, (_, i) => ({ type, offset: i * 2, length: 1 }))
  it('drops bold first, then code, never pre unless needed', () => {
    const a = capEntities([...mk('bold', 80), ...mk('code', 15), ...mk('pre', 10)])
    expect(a.length).toBeLessThanOrEqual(100)
    expect(a.filter(e => e.type === 'code').length).toBe(15)
    const b = capEntities([...mk('bold', 80), ...mk('code', 80), ...mk('pre', 10)])
    expect(b.length).toBeLessThanOrEqual(100)
    expect(b.filter(e => e.type === 'pre').length).toBe(10)
    expect(capEntities(mk('bold', 100)).length).toBe(100)
  })
})

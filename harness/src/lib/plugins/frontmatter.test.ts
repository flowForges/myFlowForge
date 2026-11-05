import { describe, it, expect } from 'vitest'
import { parseFrontmatter } from './frontmatter'

const f = (t: string) => parseFrontmatter(t)

describe('parseFrontmatter', () => {
  it('plain, quoted with colons, comments', () => {
    const r = f('---\nname: x\ndescription: "a: b # not a comment"\nother: \'it\'\'s: ok\'\nplain: v # gone\n---\nbody\n')
    expect(r.ok).toBe(true)
    expect(r.fields.get('name')).toBe('x')
    expect(r.fields.get('description')).toBe('a: b # not a comment')
    expect(r.fields.get('other')).toBe("it's: ok")
    expect(r.fields.get('plain')).toBe('v')
    expect(r.body).toBe('body\n')
  })

  it('folded >- and literal | blocks', () => {
    const r = f('---\ndescription: >-\n  one\n  two\n\n  three\nlit: |\n  a\n   b\nnext: z\n---\nB')
    expect(r.fields.get('description')).toBe('one two\nthree')
    expect(r.fields.get('lit')).toBe('a\n b\n')
    expect(r.fields.get('next')).toBe('z')
  })

  it('inline and block lists', () => {
    const r = f('---\narguments: [a, "b, c", \'d\']\nallowed-tools:\n  - Bash(*)\n  - Read\nempty: []\n---\n')
    expect(r.fields.get('arguments')).toEqual(['a', 'b, c', 'd'])
    expect(r.fields.get('allowed-tools')).toEqual(['Bash(*)', 'Read'])
    expect(r.fields.get('empty')).toEqual([])
  })

  it('no closing line: no frontmatter, whole text is the body', () => {
    const t = '---\nname: x\nstill body\n'
    const r = f(t)
    expect(r.ok).toBe(false)
    expect(r.fields.size).toBe(0)
    expect(r.body).toBe(t)
  })

  it('__proto__ is just a key', () => {
    const r = f('---\n__proto__: x\nconstructor: y\n---\n')
    expect(r.fields.get('__proto__')).toBe('x')
    expect(r.fields.get('constructor')).toBe('y')
    expect(({} as Record<string, unknown>).x).toBeUndefined()
  })

  it('a body starting with --- survives', () => {
    const r = f('---\nname: x\n---\n---\nnot front\n')
    expect(r.body).toBe('---\nnot front\n')
  })

  it('no frontmatter, CRLF, BOM, empty, never throws', () => {
    expect(f('hello').ok).toBe(false)
    expect(f('').body).toBe('')
    const r = f('﻿---\r\nname: x\r\n---\r\nB\r\n')
    expect(r.fields.get('name')).toBe('x')
    expect(r.body).toBe('B\r\n')
    expect(f('---\n---\n').ok).toBe(true)
    expect(f('---\nk: [unclosed\nj: "unclosed\n---\n').fields.get('k')).toBe('[unclosed')
  })

  it('a 1 MB header without a close is linear', () => {
    const t = Date.now()
    f('---\n' + 'k: v\n'.repeat(200000))
    expect(Date.now() - t).toBeLessThan(2000)
  })
})

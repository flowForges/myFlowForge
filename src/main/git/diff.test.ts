import { describe, it, expect } from 'vitest'
import { parseUnifiedDiff, langFromPath } from './diff'

describe('parseUnifiedDiff', () => {
  it('parses a unified diff into add/del/ctx lines with line numbers', () => {
    const diff = [
      'diff --git a/f.txt b/f.txt',
      'index 111..222 100644',
      '--- a/f.txt',
      '+++ b/f.txt',
      '@@ -1,3 +1,4 @@',
      ' a',
      '-b',
      '+B',
      '+d',
      ' c'
    ].join('\n')
    const lines = parseUnifiedDiff(diff)
    expect(lines).toEqual([
      { kind: 'ctx', ln: 1, text: 'a' },
      { kind: 'del', ln: 2, text: 'b' },
      { kind: 'add', ln: 2, text: 'B' },
      { kind: 'add', ln: 3, text: 'd' },
      { kind: 'ctx', ln: 4, text: 'c' }
    ])
  })
})

describe('langFromPath', () => {
  it('maps extensions to languages with a text fallback', () => {
    expect(langFromPath('a/b/c.ts')).toBe('ts')
    expect(langFromPath('x.TSX')).toBe('tsx')
    expect(langFromPath('s.py')).toBe('py')
    expect(langFromPath('main.go')).toBe('go')
    expect(langFromPath('q.sql')).toBe('sql')
    expect(langFromPath('App.vue')).toBe('vue')
    expect(langFromPath('cfg.yml')).toBe('yaml')
    expect(langFromPath('readme')).toBe('text')
    expect(langFromPath('data.bin')).toBe('text')
  })
})

import { describe, expect, it } from 'vitest'
import { parsePatch, planPatch, type PatchOp } from './applyPatch'

const wrap = (...body: string[]) => ['*** Begin Patch', ...body, '*** End Patch'].join('\n')

const ok = (text: string): PatchOp[] => {
  const r = parsePatch(text)
  if (!Array.isArray(r)) throw new Error(r.error)
  return r
}

const files = (m: Record<string, string>) => (p: string) => m[p]

const plan = (patch: string, m: Record<string, string>) => {
  const r = planPatch(ok(patch), files(m))
  if ('error' in r) throw new Error(r.error)
  return Object.fromEntries(r.writes.map(w => [w.path, w.content]))
}

describe('parsePatch', () => {
  it('add / delete / update with move and two hunks', () => {
    const ops = ok(
      wrap(
        '*** Add File: new.txt',
        '+hello',
        '+world',
        '*** Delete File: old.txt',
        '*** Update File: a.txt',
        '*** Move to: b.txt',
        '@@ def foo',
        ' x',
        '-y',
        '+Y',
        '@@',
        '-z',
        '+Z',
        '*** End of File',
      ),
    )
    expect(ops).toEqual([
      { kind: 'add', path: 'new.txt', content: 'hello\nworld\n' },
      { kind: 'delete', path: 'old.txt' },
      {
        kind: 'update',
        path: 'a.txt',
        moveTo: 'b.txt',
        hunks: [
          { context: 'def foo', lines: [{ op: ' ', text: 'x' }, { op: '-', text: 'y' }, { op: '+', text: 'Y' }] },
          { lines: [{ op: '-', text: 'z' }, { op: '+', text: 'Z' }], eof: true },
        ],
      },
    ])
  })

  it('tolerates a heredoc wrapper, CRLF and surrounding blank lines', () => {
    const text = `apply_patch <<'EOF'\r\n\r\n*** Begin Patch\r\n*** Add File: a\r\n+x\r\n*** End Patch\r\nEOF\r\n`
    expect(ok(text)).toEqual([{ kind: 'add', path: 'a', content: 'x\n' }])
    expect(ok(`<<EOF\n${wrap('*** Delete File: a')}\nEOF`)).toEqual([{ kind: 'delete', path: 'a' }])
  })

  it('a first hunk without @@ and an empty line inside a hunk (blank context) are accepted', () => {
    const ops = ok(wrap('*** Update File: a', ' a', '', '-b', '+c'))
    expect(ops[0]).toMatchObject({ hunks: [{ lines: [{ op: ' ', text: 'a' }, { op: ' ', text: '' }, { op: '-', text: 'b' }, { op: '+', text: 'c' }] }] })
  })

  it('errors', () => {
    const err = (t: string) => {
      const r = parsePatch(t)
      expect(Array.isArray(r)).toBe(false)
      return (r as { error: string }).error
    }
    expect(err('*** Begin Patch\n*** Add File: a\n+x')).toMatch(/End Patch/)
    expect(err('*** Add File: a\n+x\n*** End Patch')).toMatch(/Begin Patch/)
    expect(err(wrap())).toMatch(/没有/)
    expect(err(wrap('*** Add File: a', 'x'))).toMatch(/第 3 行/)
    expect(err(wrap('*** Update File: a'))).toMatch(/hunk/)
    expect(err(wrap('*** Update File: a', '@@', ' x', '@@'))).toMatch(/空的 hunk|hunk/)
    expect(err(wrap('*** Frobnicate: a'))).toMatch(/第 2 行/)
    expect(err(wrap('*** Add File:   '))).toMatch(/路径/)
    expect(err(wrap('*** Delete File: a', '*** Delete File: a'))).toMatch(/多次/)
    expect(err(wrap('*** Update File: a', '*** Move to: b', '@@', '-x', '*** Delete File: b'))).toMatch(/多次/)
  })
})

describe('planPatch', () => {
  it('add, delete and update with two hunks', () => {
    const out = plan(
      wrap('*** Add File: n.txt', '+new', '*** Delete File: d.txt', '*** Update File: u.txt', '@@', ' a', '-b', '+B', '@@', ' d', '-e', '+E1', '+E2'),
      { 'd.txt': 'bye\n', 'u.txt': 'a\nb\nc\nd\ne\nf\n' },
    )
    expect(out).toEqual({ 'n.txt': 'new\n', 'd.txt': null, 'u.txt': 'a\nB\nc\nd\nE1\nE2\nf\n' })
  })

  it('@@ context picks the right one of two identical blocks', () => {
    const src = 'def bar():\n    return 1\n\ndef foo():\n    return 1\n'
    const out = plan(wrap('*** Update File: m.py', '@@ def foo():', '-    return 1', '+    return 2'), { 'm.py': src })
    expect(out['m.py']).toBe('def bar():\n    return 1\n\ndef foo():\n    return 2\n')
  })

  it('later hunks search after the previous one', () => {
    const out = plan(wrap('*** Update File: f', '@@', '-x', '+1', '@@', '-x', '+2'), { f: 'x\ny\nx\n' })
    expect(out.f).toBe('1\ny\n2\n')
  })

  it('trailing-whitespace and then trim-insensitive matching', () => {
    expect(plan(wrap('*** Update File: f', ' a', '-b', '+B'), { f: 'a  \nb\t\nc\n' }).f).toBe('a  \nB\nc\n')
    expect(plan(wrap('*** Update File: f', '-  b', '+B'), { f: 'a\n\tb\nc\n' }).f).toBe('a\nB\nc\n')
  })

  it('exact match wins over a looser earlier one', () => {
    expect(plan(wrap('*** Update File: f', '-b', '+B'), { f: 'b \nb\n' }).f).toBe('b \nB\n')
  })

  it('move writes the target and deletes the source', () => {
    expect(plan(wrap('*** Update File: a', '*** Move to: sub/b', '@@', '-1', '+2'), { a: '1\n' })).toEqual({ 'sub/b': '2\n', a: null })
  })

  it('CRLF stays CRLF; no final newline stays without one', () => {
    expect(plan(wrap('*** Update File: f', '-b', '+B'), { f: 'a\r\nb\r\nc\r\n' }).f).toBe('a\r\nB\r\nc\r\n')
    expect(plan(wrap('*** Update File: f', '-c', '+C'), { f: 'a\nb\nc' }).f).toBe('a\nb\nC')
  })

  it('*** End of File anchors to the last lines; pure additions append (or follow @@ context)', () => {
    expect(plan(wrap('*** Update File: f', '@@', ' x', '+end', '*** End of File'), { f: 'x\ny\nx\n' }).f).toBe('x\ny\nx\nend\n')
    expect(plan(wrap('*** Update File: f', '@@', '+tail'), { f: 'a\n' }).f).toBe('a\ntail\n')
    expect(plan(wrap('*** Update File: f', '@@ a', '+after-a'), { f: 'a\nb\n' }).f).toBe('a\nafter-a\nb\n')
    expect(plan(wrap('*** Update File: f', '@@', '+first'), { f: '' }).f).toBe('first\n')
  })

  it('a trailing blank context line matches the end of the file', () => {
    expect(plan(wrap('*** Update File: f', ' a', '-b', '+B', ''), { f: 'a\nb\n' }).f).toBe('a\nB\n')
  })

  it('errors: no match (with hunk number), add over existing, delete / update / move with missing or existing files', () => {
    const err = (patch: string, m: Record<string, string>) => {
      const r = planPatch(ok(patch), files(m))
      expect('error' in r).toBe(true)
      return (r as { error: string }).error
    }
    expect(err(wrap('*** Update File: f', '@@', '-a', '+A', '@@', '-zz', '+Z'), { f: 'a\nb\n' })).toMatch(/f.*第 2 个 hunk/)
    expect(err(wrap('*** Update File: f', '@@ nope', '-a', '+A'), { f: 'a\n' })).toMatch(/nope/)
    expect(err(wrap('*** Add File: f', '+x'), { f: 'old' })).toMatch(/已存在/)
    expect(err(wrap('*** Delete File: f'), {})).toMatch(/不存在/)
    expect(err(wrap('*** Update File: f', '-a', '+b'), {})).toMatch(/不存在/)
    expect(err(wrap('*** Update File: f', '*** Move to: g', '-a', '+b'), { f: 'a\n', g: '' })).toMatch(/已存在/)
  })
})

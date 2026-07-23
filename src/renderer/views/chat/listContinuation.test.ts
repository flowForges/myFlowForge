import { describe, it, expect } from 'vitest'
import { applyListContinuation } from './listContinuation'

// Helper: run against a value where `|` marks the caret.
function at(withCaret: string) {
  const pos = withCaret.indexOf('|')
  const value = withCaret.replace('|', '')
  return applyListContinuation(value, pos, pos)
}
// Render a result back into caret notation for readable assertions.
function show(r: { value: string; cursor: number } | null): string | null {
  return r ? r.value.slice(0, r.cursor) + '|' + r.value.slice(r.cursor) : null
}

describe('applyListContinuation', () => {
  it('continues an ordered list, incrementing the number', () => {
    expect(show(at('1. buy milk|'))).toBe('1. buy milk\n2. |')
    expect(show(at('3. third|'))).toBe('3. third\n4. |')
  })
  it('supports the ) ordered delimiter', () => {
    expect(show(at('1) a|'))).toBe('1) a\n2) |')
  })
  it('continues an unordered list, repeating the bullet', () => {
    expect(show(at('- foo|'))).toBe('- foo\n- |')
    expect(show(at('* foo|'))).toBe('* foo\n* |')
    expect(show(at('+ foo|'))).toBe('+ foo\n+ |')
  })
  it('continues a checkbox list with a fresh unchecked box', () => {
    expect(show(at('- [x] done|'))).toBe('- [x] done\n- [ ] |')
    expect(show(at('- [ ] todo|'))).toBe('- [ ] todo\n- [ ] |')
  })
  it('preserves indentation for nested items', () => {
    expect(show(at('  - a|'))).toBe('  - a\n  - |')
    expect(show(at('    2. x|'))).toBe('    2. x\n    3. |')
  })
  it('exits the list when the item is empty (marker only) → clears the line', () => {
    expect(show(at('1. |'))).toBe('|')
    expect(show(at('- |'))).toBe('|')
    expect(show(at('- [ ] |'))).toBe('|')
  })
  it('exits an empty item in the middle, leaving a blank line', () => {
    expect(show(at('a\n2. |\nb'))).toBe('a\n|\nb')
  })
  it('operates on the caret line in a multi-line value', () => {
    expect(show(at('intro\n1. one|'))).toBe('intro\n1. one\n2. |')
  })
  it('splits mid-line, moving the tail into the new item', () => {
    expect(show(at('1. ab|cd'))).toBe('1. ab\n2. |cd')
  })
  it('returns null for a non-list line (caller then sends)', () => {
    expect(at('hello world|')).toBeNull()
    expect(at('|')).toBeNull()
    expect(at('just text\nmore|')).toBeNull()
  })
  it('returns null when there is a range selection (not a collapsed caret)', () => {
    expect(applyListContinuation('1. foo', 0, 6)).toBeNull()
  })
})

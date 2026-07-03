import { describe, it, expect } from 'vitest'
import { computeCoverage } from './coverage'

const providers = [
  { id: 'claude', displayName: 'Claude Code' },
  { id: 'codex', displayName: 'Codex' },
  { id: 'gemini', displayName: 'Gemini CLI' },
  { id: 'cursor', displayName: 'Cursor Agent' },
  { id: 'qoder', displayName: 'Qoder' },
]

describe('computeCoverage', () => {
  it('has source → supported, no source → unsupported with reason', () => {
    const c = computeCoverage(['claude', 'codex', 'cursor', 'qoder'], providers)
    expect(c.supported.map(s => s.id)).toEqual(['claude', 'codex', 'cursor', 'qoder'])
    expect(c.supported[0]).toEqual({ id: 'claude', label: 'Claude Code' })
    expect(c.unsupported).toEqual([
      { id: 'gemini', label: 'Gemini CLI', reason: '会话记录存储在云端，暂不支持本地导入' },
    ])
  })
  it('unknown sourceless provider uses default reason', () => {
    const c = computeCoverage(['claude'], [
      { id: 'claude', displayName: 'C' },
      { id: 'foo', displayName: 'Foo' },
    ])
    expect(c.unsupported).toEqual([
      { id: 'foo', label: 'Foo', reason: '无本地会话记录，暂不支持导入' },
    ])
  })
})

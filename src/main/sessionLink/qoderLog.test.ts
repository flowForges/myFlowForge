import { describe, it, expect } from 'vitest'
import { readExternal } from './index'
import { linkRoots } from './types'
import { defaultRoots } from '../sessionImport/types'
import { jsonl, tempFile, claudeTurnRows } from './testFixtures'

describe('readExternal qoder (Claude-like JSONL assumed)', () => {
  it('reads Claude-shaped records', async () => {
    const r = await readExternal('qoder', tempFile('q.jsonl', jsonl(claudeTurnRows())), { offset: 0 })
    expect(r.turns.map(t => t.who)).toEqual(['user', 'tool', 'assistant'])
    expect(r.endedCleanly).toBe(true)
  })
  it('unknown record shapes → no turns, no crash, endedCleanly false (mtime-only occupancy)', async () => {
    const r = await readExternal('qoder', tempFile('q.jsonl', jsonl([{ kind: 'weird', data: 1 }, 'garbage', 42, null])), { offset: 0 })
    expect(r.turns).toEqual([])
    expect(r.endedCleanly).toBe(false)
    expect(r.exists).toBe(true)
  })
  it('tolerates role-only records (no top-level type)', async () => {
    const r = await readExternal('qoder', tempFile('q.jsonl', jsonl([{ id: 'q1', message: { role: 'user', content: [{ type: 'text', text: '你好' }] } }])), { offset: 0 })
    expect(r.turns.map(t => [t.who, t.text, t.id])).toEqual([['user', '你好', 'q1']])
  })
})

describe('roots honour env', () => {
  it('linkRoots: CODEX_HOME / CLAUDE_CONFIG_DIR / QODER_CONFIG_DIR, QODER_HOME alias, home fallback', () => {
    expect(linkRoots({}, '/h')).toEqual({ codex: '/h/.codex/sessions', claude: '/h/.claude/projects', qoder: '/h/.qoder/projects' })
    expect(linkRoots({ CODEX_HOME: '/c', CLAUDE_CONFIG_DIR: '/k', QODER_CONFIG_DIR: '/q' }, '/h')).toEqual({ codex: '/c/sessions', claude: '/k/projects', qoder: '/q/projects' })
    expect(linkRoots({ QODER_HOME: '/qh' }, '/h').qoder).toBe('/qh/projects')
  })
  it('sessionImport defaultRoots also honours env', () => {
    const r = defaultRoots('/h', { CODEX_HOME: '/c', CLAUDE_CONFIG_DIR: '/k', QODER_HOME: '/q' })
    expect(r.codex).toBe('/c/sessions')
    expect(r.claude).toBe('/k/projects')
    expect(r.qoder).toBe('/q/logs/sessions')
    expect(defaultRoots('/h', {}).claude).toBe('/h/.claude/projects')
  })
})

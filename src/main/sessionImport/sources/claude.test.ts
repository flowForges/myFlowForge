import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeSource } from './claude'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cl-'))
  const proj = join(root, '-Users-me-proj'); mkdirSync(proj, { recursive: true })
  const lines = [
    { type: 'mode', mode: 'normal' },
    { type: 'user', isMeta: true, message: { role: 'user', content: '<local-command-caveat>noise' }, timestamp: '2026-06-01T00:00:00.000Z', cwd: '/Users/me/proj' },
    { type: 'user', message: { role: 'user', content: '帮我重构登录流程' }, timestamp: '2026-06-01T00:01:00.000Z', cwd: '/Users/me/proj' },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: '好的,这是方案' }] }, timestamp: '2026-06-01T00:02:00.000Z' },
    'BROKEN JSON LINE',
  ].map(l => typeof l === 'string' ? l : JSON.stringify(l)).join('\n')
  writeFileSync(join(proj, 'sess-uuid-1.jsonl'), lines)
  return root
}

describe('claudeSource', () => {
  it('scans sessions with title/cwd/count, skipping meta+broken lines', () => {
    const [s] = claudeSource.scan({ claude: fixture(), codex: '', cursor: '', qoder: '' })
    expect(s.source).toBe('claude')
    expect(s.externalId).toBe('sess-uuid-1')
    expect(s.cwd).toBe('/Users/me/proj')
    expect(s.title).toContain('重构登录流程')
    expect(s.messageCount).toBe(2)   // 1 real user + 1 assistant (meta user excluded)
    expect(s.hasBody).toBe(true)
  })
  it('readMessages returns ordered user/ai text', () => {
    const root = fixture()
    const [s] = claudeSource.scan({ claude: root, codex: '', cursor: '', qoder: '' })
    const msgs = claudeSource.readMessages(s)
    expect(msgs.map(m => m.who)).toEqual(['user', 'ai'])
    expect(msgs[1].text).toBe('好的,这是方案')
  })
})

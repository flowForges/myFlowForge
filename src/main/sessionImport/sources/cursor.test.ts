import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cursorSource } from './cursor'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cu-'))
  const t = join(root, 'Users-me-work', 'agent-transcripts', 'uuid-cu'); mkdirSync(t, { recursive: true })
  const lines = [
    { role: 'user', message: { content: [{ type: 'text', text: '<user_query>\n写一封邮件\n</user_query>' }] } },
    { role: 'assistant', message: { content: [{ type: 'text', text: '这是邮件草稿' }] } },
    'BROKEN',
  ].map(l => typeof l === 'string' ? l : JSON.stringify(l)).join('\n')
  writeFileSync(join(t, 'uuid-cu.jsonl'), lines)
  return root
}

describe('cursorSource', () => {
  it('scans agent-transcripts, decodes cwd from dir, strips tags', () => {
    const [s] = cursorSource.scan({ claude: '', codex: '', cursor: fixture(), qoder: '' })
    expect(s.externalId).toBe('uuid-cu')
    expect(s.cwd).toBe('/Users/me/work')
    expect(s.title).toContain('写一封邮件')
    expect(s.messageCount).toBe(2)
  })
  it('readMessages returns user+ai', () => {
    const root = fixture()
    const [s] = cursorSource.scan({ claude: '', codex: '', cursor: root, qoder: '' })
    expect(cursorSource.readMessages(s).map(m => m.who)).toEqual(['user', 'ai'])
  })
})

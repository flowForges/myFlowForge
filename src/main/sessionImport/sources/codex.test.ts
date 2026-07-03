import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codexSource } from './codex'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cx-'))
  const day = join(root, '2026', '06', '15'); mkdirSync(day, { recursive: true })
  const lines = [
    { timestamp: '2026-06-15T21:00:00.000Z', type: 'session_meta', payload: { id: 'uuid-cx', timestamp: '2026-06-15T21:00:00.000Z', cwd: '/Users/me/work' } },
    { timestamp: '2026-06-15T21:00:05.000Z', type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<permissions>noise' }] } },
    { timestamp: '2026-06-15T21:01:00.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '修复构建错误' }] } },
    { timestamp: '2026-06-15T21:02:00.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '已修复' }] } },
    'BROKEN',
  ].map(l => typeof l === 'string' ? l : JSON.stringify(l)).join('\n')
  writeFileSync(join(day, 'rollout-2026-06-15T21-00-00-uuid-cx.jsonl'), lines)
  return root
}

describe('codexSource', () => {
  it('scans rollout files: meta cwd/id + user title, dev role excluded', () => {
    const [s] = codexSource.scan({ claude: '', codex: fixture(), cursor: '', qoder: '' })
    expect(s.externalId).toBe('uuid-cx')
    expect(s.cwd).toBe('/Users/me/work')
    expect(s.title).toContain('修复构建错误')
    expect(s.messageCount).toBe(2)
  })
  it('readMessages joins content blocks, excludes developer', () => {
    const root = fixture()
    const [s] = codexSource.scan({ claude: '', codex: root, cursor: '', qoder: '' })
    expect(codexSource.readMessages(s).map(m => m.who)).toEqual(['user', 'ai'])
  })
})

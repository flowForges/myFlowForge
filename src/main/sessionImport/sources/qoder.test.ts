import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { qoderSource } from './qoder'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'qo-'))
  const seg = join(root, '-Users-me-ex', 'uuid-qo', 'segments'); mkdirSync(seg, { recursive: true })
  writeFileSync(join(seg, '2026-06-26T19-56-57.jsonl'), JSON.stringify({ ts: '2026-06-26T19:56:59.384+08:00', type: 'session.config.loaded', data: { project_root: '/Users/me/ex' } }))
  return root
}

describe('qoderSource', () => {
  it('registers metadata only, hasBody false, count 0', () => {
    const [s] = qoderSource.scan({ claude: '', codex: '', cursor: '', qoder: fixture() })
    expect(s.source).toBe('qoder')
    expect(s.externalId).toBe('uuid-qo')
    expect(s.cwd).toBe('/Users/me/ex')
    expect(s.hasBody).toBe(false)
    expect(s.messageCount).toBe(0)
  })
  it('readMessages is empty (no body on disk)', () => {
    const root = fixture()
    const [s] = qoderSource.scan({ claude: '', codex: '', cursor: '', qoder: root })
    expect(qoderSource.readMessages(s)).toEqual([])
  })
})

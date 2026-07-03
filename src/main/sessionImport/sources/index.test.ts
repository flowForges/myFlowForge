import { describe, it, expect } from 'vitest'
import { scanAll, readSession } from './index'

describe('source registry', () => {
  it('one failing source does not break others (fail-open)', () => {
    // empty/missing roots → each source returns [] without throwing
    const all = scanAll({ claude: '/no/claude', codex: '/no/codex', cursor: '/no/cursor', qoder: '/no/qoder' })
    expect(all).toEqual([])
  })
  it('readSession dispatches by source and tolerates unknown', () => {
    expect(readSession({ source: 'qoder', externalId: 'x', cwd: '/', title: '', startedAt: 0, lastTs: 0, messageCount: 0, filePaths: [], hasBody: false })).toEqual([])
  })
})

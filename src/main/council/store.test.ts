import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CouncilConfig, CouncilState } from '@shared/council'
import type { PersistedCouncil } from './engine'
import { councilDir, loadCouncils, loadLastConfig, saveCouncil, saveLastConfig } from './store'

const seat = (id: string, provider = 'codex') => ({ id, provider, model: `m-${id}`, label: `${provider} · ${id}` })
const config: CouncilConfig = {
  topic: '怎么设计缓存',
  attachments: [{ name: 'a.png', path: '/tmp/a.png', size: 3 }],
  seats: [seat('A'), seat('B')],
  leader: seat('L', 'claude'),
  mode: { kind: 'rounds', rounds: 2 },
  materials: { projectCwd: '/tmp/p', diff: 'uncommitted' },
}

function persisted(id: string, sid: string, over: Partial<CouncilState> = {}): PersistedCouncil {
  return {
    state: {
      id, workspacePath: '/ws', sessionId: sid, status: 'running', round: 2, totalRounds: 2,
      speaking: [], startedAt: 1000, elapsedMs: 5, config, ...over,
    },
    transcript: { items: [{ seat: 'A', label: 'codex · A', round: 1, stage: 'answer', text: 'hi' }], seen: { A: 1 } },
    failures: { B: 1 },
    dropped: [],
    phase: 'critique',
    spokenThisRound: ['A'],
    resumes: 2,
  }
}

let ws: string
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'council-store-')) })
afterEach(() => rmSync(ws, { recursive: true, force: true }))

describe('council store', () => {
  it('councilDir is <ws>/.forge/council', () => {
    expect(councilDir(ws)).toBe(join(ws, '.forge', 'council'))
  })

  it('save/load round-trip, filtered by session, no temp file left behind', () => {
    const a = persisted('c-a', 's1')
    const b = persisted('c-b', 's2', { startedAt: 2000 })
    saveCouncil(ws, a)
    saveCouncil(ws, b)
    expect(loadCouncils(ws)).toEqual([a, b])
    expect(loadCouncils(ws, 's1')).toEqual([a])
    expect(readdirSync(councilDir(ws)).sort()).toEqual(['c-a.json', 'c-b.json'])
  })

  it('saving again overwrites the same <id>.json', () => {
    saveCouncil(ws, persisted('c-a', 's1'))
    const later = persisted('c-a', 's1', { status: 'paused', round: 3 })
    saveCouncil(ws, later)
    expect(loadCouncils(ws)).toEqual([later])
  })

  it('corrupt or foreign json files are skipped without throwing', () => {
    const ok = persisted('c-ok', 's1')
    saveCouncil(ws, ok)
    writeFileSync(join(councilDir(ws), 'broken.json'), '{ not json')
    writeFileSync(join(councilDir(ws), 'other.json'), JSON.stringify({ hello: 1 }))
    writeFileSync(join(councilDir(ws), '2026-10-21-0905-x.md'), '# result')
    expect(loadCouncils(ws)).toEqual([ok])
  })

  it('missing directory → empty list', () => {
    expect(loadCouncils(ws)).toEqual([])
  })

  it('last-config round-trip keeps seats/leader/mode/materials and drops topic/attachments', () => {
    expect(loadLastConfig(ws)).toBeNull()
    saveLastConfig(ws, config)
    expect(loadLastConfig(ws)).toEqual({ seats: config.seats, leader: config.leader, mode: config.mode, materials: config.materials })
    // 上次配置不能被当成一场共商读出来
    expect(loadCouncils(ws)).toEqual([])
  })

  it('corrupt last-config → null', () => {
    mkdirSync(councilDir(ws), { recursive: true })
    saveLastConfig(ws, config)
    writeFileSync(join(councilDir(ws), 'last-config.json'), '{')
    expect(loadLastConfig(ws)).toBeNull()
  })
})

// src/main/run/persist.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RunStore } from '../run/runStore'
import { wsRunDir } from '../config/paths'
import { saveControllerState, loadControllerState, findLatestRun2Run, findRun2RunForSession, isTerminalStatus, listRuns, loadRun, deleteRun } from './persist'
import { initMachine, type RunPlan, type MachineState } from './machine'
import type { RunControllerState } from './controller'

let ws: string
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'per-')) })
afterEach(() => { rmSync(ws, { recursive: true, force: true }) })

const plan: RunPlan = { runId: 'r1', stages: [{ key: 'design', name: 'D', provider: 'x', model: 'm', scope: 'root', gate: true }] }

describe('controller persistence', () => {
  it('round-trips machine/inbox/feedback/status/pendingDirective', () => {
    const store = new RunStore(ws, 'r1')
    const s = {
      machine: initMachine(plan),
      inbox: [{ id: 'g1', kind: 'gate', stageKey: 'design', body: 'b' }],
      feedback: [{ id: 'f1', text: 'note' }],
      outcomes: {},
      status: 'awaiting' as const,
      pendingDirective: { design: 'tighten up the copy' },
    }
    saveControllerState(store, s as any)
    const back = loadControllerState(store)
    expect(back?.status).toBe('awaiting')
    expect(back?.inbox[0].id).toBe('g1')
    expect(back?.feedback[0].text).toBe('note')
    expect(back?.machine.stages[0].key).toBe('design')
    expect(back?.pendingDirective).toEqual({ design: 'tighten up the copy' })
  })
  it('returns null when nothing saved', () => {
    const store = new RunStore(ws, 'r1')
    expect(loadControllerState(store)).toBeNull()
  })

  // P-C2/T3 (Finding 2): sessionId/task must survive a save/load round-trip — otherwise a disk-resumed
  // run silently loses session-card scoping (P3 relies on run2.state.sessionId) and its task seed.
  it('round-trips sessionId and task', () => {
    const store = new RunStore(ws, 'r1')
    const s = {
      machine: initMachine(plan), inbox: [], feedback: [], outcomes: {},
      status: 'running' as const, pendingDirective: {},
      sessionId: 'sess-42', task: '【需求原文】做个登录页',
    }
    saveControllerState(store, s as any)
    const back = loadControllerState(store)
    expect(back?.sessionId).toBe('sess-42')
    expect(back?.task).toBe('【需求原文】做个登录页')
  })

  // See RunControllerState.laneSessions doc (controller.ts) — the same round-trip guarantee as
  // sessionId/task above: without this, a run2 stage agent's captured CLI session id would vanish
  // on a disk-resumed run, and the IDs panel (composeAgentSessions) would show it as uncaptured
  // even though the original run had already surfaced it.
  it('round-trips laneSessions', () => {
    const store = new RunStore(ws, 'r1')
    const s = {
      machine: initMachine(plan), inbox: [], feedback: [], outcomes: {},
      status: 'running' as const, pendingDirective: {},
      laneSessions: { 'design:root': { provider: 'claude', sessionId: 'sess-99' } },
    }
    saveControllerState(store, s as any)
    const back = loadControllerState(store)
    expect(back?.laneSessions).toEqual({ 'design:root': { provider: 'claude', sessionId: 'sess-99' } })
  })

  // Backward compatibility: an older saved run2-state (written before laneSessions existed) must
  // load with an empty map, not throw and not be defaulted to something that looks authoritative.
  it('laneSessions defaults to {} for a saved state that never set it', () => {
    const store = new RunStore(ws, 'r1')
    const s = { machine: initMachine(plan), inbox: [], feedback: [], outcomes: {}, status: 'running' as const, pendingDirective: {} }
    saveControllerState(store, s as any)
    const back = loadControllerState(store)
    expect(back?.laneSessions).toEqual({})
  })

  // Backward compatibility: a state saved before this field existed (or one built without it, like
  // the very first test above) must load with sessionId/task simply absent — not throw, not default
  // to some sentinel — so an older on-disk run still resumes, just unscoped/without a seed.
  it('sessionId/task are absent (not defaulted) for a saved state that never set them', () => {
    const store = new RunStore(ws, 'r1')
    const s = { machine: initMachine(plan), inbox: [], feedback: [], outcomes: {}, status: 'running' as const, pendingDirective: {} }
    saveControllerState(store, s as any)
    const back = loadControllerState(store)
    expect(back?.sessionId).toBeUndefined()
    expect(back?.task).toBeUndefined()
  })

  // P-C2/T3 review Finding 1 (CRITICAL): `projects` — the EXACT gate-selected subset a run was
  // launched with — must survive a save/load round-trip, or a disk-resumed run has no record of
  // which projects actually participated and a resume caller must fall back to reconstructing
  // "every project on the workspace" (see manager.ts's resumeFromDisk doc for the corruption this
  // caused before persisting it).
  it('round-trips projects (the gate-selected subset)', () => {
    const store = new RunStore(ws, 'r1')
    const projects = [{ name: 'go-blog', cwd: '/ws/go-blog', provider: 'codex', model: 'gpt' }]
    const s = {
      machine: initMachine(plan), inbox: [], feedback: [], outcomes: {},
      status: 'running' as const, pendingDirective: {}, projects,
    }
    saveControllerState(store, s as any)
    const back = loadControllerState(store)
    expect(back?.projects).toEqual(projects)
  })

  // Backward compatibility: same rationale as sessionId/task above — an older saved state (or one
  // built without `projects`, like every OTHER test in this file) must load with it simply absent.
  it('projects is absent (not defaulted) for a saved state that never set it', () => {
    const store = new RunStore(ws, 'r1')
    const s = { machine: initMachine(plan), inbox: [], feedback: [], outcomes: {}, status: 'running' as const, pendingDirective: {} }
    saveControllerState(store, s as any)
    const back = loadControllerState(store)
    expect(back?.projects).toBeUndefined()
  })

  // Improvement ⑥: laneTimings (per-project/per-lane execution timing) must survive a save/load
  // round-trip too — otherwise a resumed/historical run loses each lane's own elapsed time, not
  // just the whole stage's (stageTimings already round-trips, see the first test in this file).
  it('round-trips laneTimings', () => {
    const store = new RunStore(ws, 'r1')
    const laneTimings = { 'design:a': { startedAt: 1000, endedAt: 2500 }, 'design:b': { startedAt: 1200 } }
    const s = {
      machine: initMachine(plan), inbox: [], feedback: [], outcomes: {},
      status: 'running' as const, pendingDirective: {}, laneTimings,
    }
    saveControllerState(store, s as any)
    const back = loadControllerState(store)
    expect(back?.laneTimings).toEqual(laneTimings)
  })

  // Backward compatibility, mirroring stageTimings' own `?? {}` fallback (persist.ts's
  // loadControllerState): an older saved state (or one built without `laneTimings`, like every
  // OTHER test in this file) must load with an empty object, not throw or leave it undefined.
  it('laneTimings defaults to {} for a saved state that never set it', () => {
    const store = new RunStore(ws, 'r1')
    const s = { machine: initMachine(plan), inbox: [], feedback: [], outcomes: {}, status: 'running' as const, pendingDirective: {} }
    saveControllerState(store, s as any)
    const back = loadControllerState(store)
    expect(back?.laneTimings).toEqual({})
  })

  // Item ⑤: provider/model/cwd must survive a save/load round-trip on a per-outcome basis, sourced
  // from the outcome's own `order` — otherwise historical run-history replay can't show them (see
  // runHistoryAdapter.ts).
  it('round-trips provider/model/cwd per outcome (sourced from order)', () => {
    const store = new RunStore(ws, 'r1')
    const s = {
      machine: initMachine(plan), inbox: [], feedback: [],
      outcomes: {
        design: [{
          order: { id: 'design:root', stageKey: 'design', name: 'design', provider: 'codex', model: 'gpt-5', cwd: '/ws/go-blog', prompt: 'do it' },
          status: 'ok' as const, attempts: 1,
        }],
      },
      status: 'ok' as const, pendingDirective: {},
    }
    saveControllerState(store, s as any)
    const back = loadControllerState(store)
    expect(back?.outcomes.design[0]).toMatchObject({ provider: 'codex', model: 'gpt-5', cwd: '/ws/go-blog' })
  })

  // Backward compatibility: a legacy saved outcome (written before provider/model/cwd were
  // persisted, like every OTHER outcome fixture in this file) must load with them simply absent —
  // not throw, not default to a sentinel.
  it('a legacy saved outcome without provider/model/cwd loads with them absent, not throwing', () => {
    const store = new RunStore(ws, 'r1')
    // Simulates on-disk data written by an OLDER build: outcomes shaped per the old, narrower
    // SavedOutcome (no provider/model/cwd) rather than saveControllerState's current (order-based)
    // output.
    store.setContext('run2-state', {
      machine: initMachine(plan), inbox: [], feedback: [],
      outcomes: { design: [{ id: 'design:root', status: 'ok', project: undefined, attempts: 1 }] },
      status: 'ok', pendingDirective: {},
    })
    const back = loadControllerState(store)
    expect(back?.outcomes.design[0].id).toBe('design:root')
    expect(back?.outcomes.design[0].provider).toBeUndefined()
    expect(back?.outcomes.design[0].model).toBeUndefined()
    expect(back?.outcomes.design[0].cwd).toBeUndefined()
  })
})

describe('findLatestRun2Run (P-C2/T3 review Finding 1): latest-mtime-wins regardless of terminal-ness', () => {
  // Mirrors the fixture shape manager.test.ts's disk-resume suite uses.
  function fixtureState(status: RunControllerState['status']): RunControllerState {
    const machine: MachineState = { plan, stages: [{ key: 'design', status: 'pending', round: 0 }], currentIndex: 0 }
    return { machine, inbox: [], feedback: [], outcomes: {}, status, pendingDirective: {}, liveLanes: {}, stageTimings: {}, laneTimings: {}, laneSessions: {}, paused: false }
  }
  // Seeds a run's context.json then stamps its mtime explicitly — real filesystem mtime resolution
  // (and same-millisecond writes in a fast test) is too coarse/unreliable to order two saves by
  // "which ran second", so this pins each run's mtime to a deliberately distinct, known value.
  function seedRun(runId: string, status: RunControllerState['status'], mtimeMs: number) {
    saveControllerState(new RunStore(ws, runId), fixtureState(status))
    const ctxFile = join(wsRunDir(ws, runId), 'context.json')
    const t = mtimeMs / 1000
    utimesSync(ctxFile, t, t)
  }

  const OLDER_MS = Date.now() - 3600_000 // an hour ago
  const NEWER_MS = Date.now() // now

  it('older non-terminal run + newer TERMINAL run: returns the newer (terminal) one — caller must treat this as not-resumable', () => {
    seedRun('run-old', 'running', OLDER_MS)
    seedRun('run-new', 'ok', NEWER_MS)
    const found = findLatestRun2Run(ws)
    expect(found?.runId).toBe('run-new')
    expect(isTerminalStatus(found!.state.status)).toBe(true)
  })

  it('older non-terminal run + newer NON-terminal run: returns the newer', () => {
    seedRun('run-old', 'running', OLDER_MS)
    seedRun('run-new', 'awaiting', NEWER_MS)
    const found = findLatestRun2Run(ws)
    expect(found?.runId).toBe('run-new')
    expect(isTerminalStatus(found!.state.status)).toBe(false)
  })

  it('returns null when the workspace has no runs dir at all', () => {
    expect(findLatestRun2Run(join(ws, 'nope'))).toBeNull()
  })
})

// composeAgentSessions (chat/agentSessions.ts) uses this to find which run2 run a chat session
// owns — run2 launches never set ChatSession.runId (see findRun2RunForSession's doc), so ownership
// is matched by the saved state's own `sessionId` field instead.
describe('findRun2RunForSession', () => {
  function fixtureState(status: RunControllerState['status'], sessionId?: string): RunControllerState {
    const machine: MachineState = { plan, stages: [{ key: 'design', status: 'pending', round: 0 }], currentIndex: 0 }
    return { machine, inbox: [], feedback: [], outcomes: {}, status, pendingDirective: {}, liveLanes: {}, stageTimings: {}, laneTimings: {}, laneSessions: {}, paused: false, sessionId }
  }
  function seedRun(runId: string, status: RunControllerState['status'], sessionId: string | undefined, mtimeMs: number) {
    saveControllerState(new RunStore(ws, runId), fixtureState(status, sessionId))
    const ctxFile = join(wsRunDir(ws, runId), 'context.json')
    const t = mtimeMs / 1000
    utimesSync(ctxFile, t, t)
  }

  it('returns null when no run is owned by this session', () => {
    seedRun('run-a', 'running', 'sess-OTHER', Date.now())
    expect(findRun2RunForSession(ws, 'sess-mine')).toBeNull()
  })

  it('finds the single run owned by this session', () => {
    seedRun('run-a', 'running', 'sess-mine', Date.now())
    const found = findRun2RunForSession(ws, 'sess-mine')
    expect(found?.runId).toBe('run-a')
  })

  it('prefers a currently-running owned run over an older terminal owned run', () => {
    seedRun('run-old-done', 'ok', 'sess-mine', Date.now() - 3600_000)
    seedRun('run-new-running', 'running', 'sess-mine', Date.now() - 1000)
    const found = findRun2RunForSession(ws, 'sess-mine')
    expect(found?.runId).toBe('run-new-running')
  })

  it('falls back to the most recently modified terminal run when none are running', () => {
    seedRun('run-a', 'ok', 'sess-mine', Date.now() - 2000)
    seedRun('run-b', 'failed', 'sess-mine', Date.now())
    const found = findRun2RunForSession(ws, 'sess-mine')
    expect(found?.runId).toBe('run-b')
  })

  it('ignores runs owned by a different session even if newer', () => {
    seedRun('run-mine', 'running', 'sess-mine', Date.now() - 5000)
    seedRun('run-other', 'running', 'sess-OTHER', Date.now())
    const found = findRun2RunForSession(ws, 'sess-mine')
    expect(found?.runId).toBe('run-mine')
  })
})

describe('listRuns / loadRun (run-history, spec §12.7)', () => {
  function fixtureState(status: RunControllerState['status'], doneCount: number, totalStages: number, task?: string): RunControllerState {
    const stages = Array.from({ length: totalStages }, (_, i) => ({ key: `s${i}`, status: (i < doneCount ? 'done' : 'pending') as 'done' | 'pending', round: 0 }))
    const machine: MachineState = { plan, stages, currentIndex: 0 }
    return { machine, inbox: [], feedback: [], outcomes: {}, status, pendingDirective: {}, liveLanes: {}, stageTimings: {}, laneTimings: {}, laneSessions: {}, paused: false, task }
  }
  // Same mtime-pinning rationale as findLatestRun2Run's seedRun above — real fs mtime resolution is
  // too coarse to reliably order several saves by "which ran Nth".
  function seedRun(runId: string, status: RunControllerState['status'], mtimeMs: number, doneCount = 1, totalStages = 2, task?: string) {
    saveControllerState(new RunStore(ws, runId), fixtureState(status, doneCount, totalStages, task))
    const ctxFile = join(wsRunDir(ws, runId), 'context.json')
    const t = mtimeMs / 1000
    utimesSync(ctxFile, t, t)
  }

  it('returns all runs newest-first, with status/doneCount/totalStages/task', () => {
    seedRun('run-a', 'ok', Date.now() - 2000, 2, 2, 'task A')
    seedRun('run-b', 'running', Date.now() - 1000, 1, 3, 'task B')
    seedRun('run-c', 'failed', Date.now(), 1, 2, 'task C')
    const list = listRuns(ws)
    expect(list.map((l) => l.runId)).toEqual(['run-c', 'run-b', 'run-a'])
    expect(list[0]).toMatchObject({ runId: 'run-c', status: 'failed', doneCount: 1, totalStages: 2, task: 'task C' })
    expect(list[1]).toMatchObject({ runId: 'run-b', status: 'running', doneCount: 1, totalStages: 3, task: 'task B' })
    expect(list[2]).toMatchObject({ runId: 'run-a', status: 'ok', doneCount: 2, totalStages: 2, task: 'task A' })
  })

  it('skips a run directory whose context.json is corrupt (invalid JSON)', () => {
    seedRun('run-good', 'ok', Date.now(), 2, 2)
    const badDir = wsRunDir(ws, 'run-bad')
    mkdirSync(badDir, { recursive: true })
    writeFileSync(join(badDir, 'context.json'), '{ not valid json', 'utf8')
    const list = listRuns(ws)
    expect(list.map((l) => l.runId)).toEqual(['run-good'])
  })

  it('returns an empty array when the workspace has no runs dir at all', () => {
    expect(listRuns(join(ws, 'nope'))).toEqual([])
  })

  it('loadRun returns the full saved state for a given runId', () => {
    seedRun('run-x', 'ok', Date.now(), 1, 1, 'do the thing')
    const loaded = loadRun(ws, 'run-x')
    expect(loaded?.status).toBe('ok')
    expect(loaded?.task).toBe('do the thing')
    expect(loaded?.machine.stages).toHaveLength(1)
  })

  it('loadRun returns null for an unknown runId (and does not create a directory for it)', () => {
    expect(loadRun(ws, 'nope')).toBeNull()
    expect(existsSync(wsRunDir(ws, 'nope'))).toBe(false)
  })
})

// Run-state UX fix: run-history 删除 — generalizes discardResumableRun to an EXPLICIT runId picked
// from the history list, regardless of terminal-ness (a finished run's saved state can be deleted
// too, unlike discardResumableRun which only ever targets a non-terminal "resumable" run).
describe('deleteRun (run-history delete)', () => {
  function fixtureState(status: RunControllerState['status'], task?: string): RunControllerState {
    const machine: MachineState = { plan, stages: [{ key: 's0', status: 'done', round: 0 }], currentIndex: 0 }
    return { machine, inbox: [], feedback: [], outcomes: {}, status, pendingDirective: {}, liveLanes: {}, stageTimings: {}, laneTimings: {}, laneSessions: {}, paused: false, task }
  }

  it('clears the given run so it no longer loads or appears in listRuns', () => {
    saveControllerState(new RunStore(ws, 'run-del'), fixtureState('ok', 'to be deleted'))
    expect(loadRun(ws, 'run-del')).not.toBeNull()

    expect(deleteRun(ws, 'run-del')).toBe(true)

    expect(loadRun(ws, 'run-del')).toBeNull()
    expect(listRuns(ws).map((l) => l.runId)).not.toContain('run-del')
  })

  it('also deletes a non-terminal (running/awaiting) run\'s state, unlike discardResumableRun\'s terminal gate', () => {
    saveControllerState(new RunStore(ws, 'run-orphan'), fixtureState('running'))
    expect(deleteRun(ws, 'run-orphan')).toBe(true)
    expect(loadRun(ws, 'run-orphan')).toBeNull()
  })

  it('returns false and is a no-op for an unknown runId (does not create a directory for it)', () => {
    expect(deleteRun(ws, 'nope')).toBe(false)
    expect(existsSync(wsRunDir(ws, 'nope'))).toBe(false)
  })

  it('returns false for an unknown workspace path', () => {
    expect(deleteRun(join(ws, 'no-such-ws'), 'run-x')).toBe(false)
  })
})

// src/main/run/persist.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RunStore } from '../orchestrator/runStore'
import { wsRunDir } from '../config/paths'
import { saveControllerState, loadControllerState, findLatestRun2Run, isTerminalStatus } from './persist'
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
})

describe('findLatestRun2Run (P-C2/T3 review Finding 1): latest-mtime-wins regardless of terminal-ness', () => {
  // Mirrors the fixture shape manager.test.ts's disk-resume suite uses.
  function fixtureState(status: RunControllerState['status']): RunControllerState {
    const machine: MachineState = { plan, stages: [{ key: 'design', status: 'pending', round: 0 }], currentIndex: 0 }
    return { machine, inbox: [], feedback: [], outcomes: {}, status, pendingDirective: {}, liveLanes: {}, stageTimings: {}, paused: false }
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

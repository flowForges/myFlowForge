// src/main/run/persist.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RunStore } from '../orchestrator/runStore'
import { saveControllerState, loadControllerState } from './persist'
import { initMachine, type RunPlan } from './machine'

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
})

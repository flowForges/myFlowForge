import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RunStore } from '../run/runStore'
import { runHeadless } from './engine'
import type { RunPlan } from './machine'
import type { AgentProvider, AgentTask, AgentCallbacks } from '../agents/types'

let ws: string
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'run-')) })
afterEach(() => { rmSync(ws, { recursive: true, force: true }) })

// records prompts so we can assert upstream is threaded in
const prompts: Record<string, string> = {}
function recordingProvider(): AgentProvider {
  return {
    id: 'x', displayName: 'X', capabilities: { structuredOutput: true, permissionHook: true, pty: false },
    async detect() { return true }, async listModels() { return [{ id: 'm', label: 'M' }] },
    run(task: AgentTask, cb: AgentCallbacks) {
      prompts[task.agentId] = task.prompt
      const done = (async () => { cb.onHandoff?.({ summary: `output of ${task.agentId}` }); const r = { ok: true, summary: 'x' }; cb.onDone(r); return r })()
      return { id: task.agentId, cancel() {}, done }
    },
  }
}
function failingDevelop(): AgentProvider {
  return {
    id: 'x', displayName: 'X', capabilities: { structuredOutput: true, permissionHook: true, pty: false },
    async detect() { return true }, async listModels() { return [{ id: 'm', label: 'M' }] },
    run(task: AgentTask, cb: AgentCallbacks) {
      const done = (async () => {
        if (task.stageKey === 'develop') {
          cb.onState('err')
          const err = new Error('nope')
          cb.onError(err)
          const r = { ok: false }
          cb.onDone(r)
          return r
        }
        cb.onHandoff?.({ summary: `output of ${task.agentId}` }); const r = { ok: true, summary: 'x' }; cb.onDone(r); return r
      })()
      return { id: task.agentId, cancel() {}, done }
    },
  }
}

const plan: RunPlan = {
  runId: 'r1',
  stages: [
    { key: 'design', name: '方案', provider: 'x', model: 'm', scope: 'root', gate: true },
    { key: 'develop', name: '开发', provider: 'x', model: 'm', scope: 'per-project', gate: true },
  ],
}

describe('runHeadless', () => {
  it('runs stages in order, writes artifacts, threads upstream, ends ok', async () => {
    const store = new RunStore(ws, 'r1')
    const res = await runHeadless(plan, {
      providers: { x: recordingProvider() }, store, env: {},
      projects: [{ name: 'a', cwd: join(ws, 'a') }, { name: 'b', cwd: join(ws, 'b') }],
      sleep: async () => {},
    })
    expect(res.status).toBe('ok')
    expect(res.state.stages.map((s) => s.status)).toEqual(['done', 'done'])
    // design produced 1 artifact, develop produced 2
    expect(existsSync(join(store.runDir, 'artifacts', 'design-root.md'))).toBe(true)
    expect(existsSync(join(store.runDir, 'artifacts', 'develop-a.md'))).toBe(true)
    expect(existsSync(join(store.runDir, 'artifacts', 'develop-b.md'))).toBe(true)
    // develop prompt saw design's artifact path (upstream threaded)
    expect(prompts['develop:a']).toContain('design-root.md')
  })

  it('stops at failed status when a lane in a stage fails', async () => {
    const store = new RunStore(ws, 'r1')
    const res = await runHeadless(plan, {
      providers: { x: failingDevelop() }, store, env: {},
      projects: [{ name: 'a', cwd: join(ws, 'a') }],
      retries: 0, sleep: async () => {},
    })
    expect(res.status).toBe('failed')
    expect(res.state.stages[0].status).toBe('done') // design ok
    expect(res.state.stages[1].status).toBe('running') // develop stuck, not advanced
    expect(res.outcomes['develop'][0].status).toBe('failed')
  })

  it('rejects with a descriptive error when a per-project stage has no projects', async () => {
    const store = new RunStore(ws, 'r1')
    await expect(runHeadless(plan, {
      providers: { x: recordingProvider() }, store, env: {},
      projects: [],
      sleep: async () => {},
    })).rejects.toThrow(/stage "develop" produced no work orders/)
  })
})

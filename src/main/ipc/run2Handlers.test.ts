import { describe, it, expect } from 'vitest'
import { registerRun2 } from './run2Handlers'
import { Run2Manager } from '../run/manager'
import { RunStore } from '../orchestrator/runStore'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as CH from './channels'
import type { AgentProvider, AgentTask, AgentCallbacks } from '../agents/types'

function okProvider(): AgentProvider {
  return {
    id: 'x', displayName: 'X', capabilities: { structuredOutput: true, permissionHook: true, pty: false },
    async detect() { return true }, async listModels() { return [{ id: 'm', label: 'M' }] },
    run(task: AgentTask, cb: AgentCallbacks) {
      const done = (async () => { cb.onHandoff?.({ summary: 'ok' }); const r = { ok: true, summary: '' }; cb.onDone(r); return r })()
      return { id: task.agentId, cancel() {}, done }
    },
  }
}

describe('registerRun2', () => {
  it('wires run2:start through planFromStages + manager.start', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'r2h-'))
    try {
      const handlers = new Map<string, (...a: any[]) => any>()
      const manager = new Run2Manager({ providers: { x: okProvider() }, env: {}, makeStore: (w, r) => new RunStore(w, r), emit: { event: () => {}, update: () => {} } })
      registerRun2({ manager, onInvoke: (ch, h) => handlers.set(ch, h) })
      expect(handlers.has(CH.run2Start)).toBe(true)
      const start = handlers.get(CH.run2Start)!
      const state = await start({}, { workspacePath: ws, runId: 'r1', stages: [{ key: 'design', name: '方案', provider: 'x', model: 'm', scope: 'root', gate: false }], projects: [{ name: 'a', cwd: join(ws, 'a') }] })
      expect(state.status).toBe('running')
      // abort handler exists and is safe
      const abort = handlers.get(CH.run2Abort)!
      expect(() => abort({}, { workspacePath: ws })).not.toThrow()
    } finally { rmSync(ws, { recursive: true, force: true }) }
  })
})

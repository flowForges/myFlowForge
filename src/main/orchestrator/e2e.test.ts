/**
 * End-to-end smoke test: exercises the full main-process vertical slice without
 * Electron/GUI — EventBus + Orchestrator + RunStore blackboard + confirm bubbling.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventBus } from './eventBus'
import { Orchestrator } from './orchestrator'
import type { AgentProvider } from '../agents/types'
import type { EngineEvent } from '@shared/types'
import { wsRunDir } from '../config/paths'

let ws: string
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'e2e-')) })
afterEach(() => rmSync(ws, { recursive: true, force: true }))

/** Fake provider: logs a line, asks onConfirm once on the 'design' stage, then completes ok */
function makeFakeProvider(): AgentProvider {
  return {
    id: 'fake',
    displayName: 'Fake Agent',
    capabilities: { structuredOutput: true, permissionHook: true, pty: false },
    async detect() { return true },
    async listModels() { return [{ id: 'test-model', label: 'Test Model' }] },
    run(task, cb) {
      cb.onState('run')
      cb.onLog({ ts: '00:00:00', text: `starting ${task.name}`, level: 'info' })
      const done = (async () => {
        if (task.stageKey === 'design') {
          // Ask for confirmation — the test will auto-resolve it with 'allow'
          await cb.onConfirm({ title: 'Proceed with design?', where: 'design/spec.md' })
        }
        cb.onState('ok')
        const result = { ok: true, summary: `${task.name} completed` }
        cb.onDone(result)
        return result
      })()
      return { id: task.agentId, cancel() {}, done }
    }
  }
}

describe('end-to-end smoke: orchestrator + runStore + confirm bubbling', () => {
  it('completes a 2-stage (design + develop) run, fans out develop to 2 agents, persists messages.jsonl', async () => {
    const runId = 'smoke-run-1'
    const bus = new EventBus()
    const events: EngineEvent[] = []
    bus.subscribe(e => events.push(e))

    const orch = new Orchestrator({ bus, providers: { fake: makeFakeProvider() }, proxy: () => '' })

    // Auto-resolve any pending confirm with 'allow'
    bus.subscribe(e => {
      if (e.type === 'pending:add') {
        setTimeout(() => orch.resolve({ id: e.action.id, decision: 'allow' }), 0)
      }
    })

    // Create temp dirs for the two develop projects
    const proj1Dir = mkdtempSync(join(tmpdir(), 'proj1-'))
    const proj2Dir = mkdtempSync(join(tmpdir(), 'proj2-'))

    try {
      const run = await orch.startRun({
        runId,
        workspaceName: 'smoke-workspace',
        workspacePath: ws,
        stages: [
          { key: 'design', name: 'Design Stage', provider: 'fake', model: 'test-model' },
          { key: 'develop', name: 'Develop Stage', provider: 'fake', model: 'test-model' }
        ],
        developProjects: [
          { name: 'proj1', cwd: proj1Dir },
          { name: 'proj2', cwd: proj2Dir }
        ]
      })

      // 1. Run completed successfully
      expect(run.status).toBe('ok')

      // 2. Both stages are present and ok
      expect(run.stages).toHaveLength(2)
      const designStage = run.stages.find(s => s.key === 'design')!
      const developStage = run.stages.find(s => s.key === 'develop')!
      expect(designStage.state).toBe('ok')
      expect(developStage.state).toBe('ok')

      // 3. Develop stage fanned out to 2 agents (one per project)
      expect(developStage.agents).toHaveLength(2)
      expect(developStage.agents.map(a => a.name)).toEqual(['proj1', 'proj2'])

      // 4. A pending:add event was emitted (confirm was raised)
      expect(events.some(e => e.type === 'pending:add')).toBe(true)

      // 5. A pending:resolve event was emitted (confirm was answered)
      expect(events.some(e => e.type === 'pending:resolve')).toBe(true)

      // 6. run:update events were emitted throughout
      expect(events.filter(e => e.type === 'run:update').length).toBeGreaterThan(0)

      // 7. messages.jsonl was written (confirm message was persisted to the blackboard)
      const messagesFile = join(wsRunDir(ws, runId), 'messages.jsonl')
      expect(existsSync(messagesFile)).toBe(true)
      const lines = readFileSync(messagesFile, 'utf8').trim().split('\n').filter(Boolean)
      expect(lines.length).toBeGreaterThanOrEqual(1)
      const firstMsg = JSON.parse(lines[0])
      expect(firstMsg.type).toBe('confirm')
      expect(firstMsg.runId).toBe(runId)
      expect(firstMsg.payload).toMatchObject({ title: 'Proceed with design?' })
    } finally {
      rmSync(proj1Dir, { recursive: true, force: true })
      rmSync(proj2Dir, { recursive: true, force: true })
    }
  })
})

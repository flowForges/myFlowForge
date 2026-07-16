import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Orchestrator } from './orchestrator'
import { EventBus } from './eventBus'
import type { AgentProvider } from '../agents/types'

let ws: string
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'wscustom-')) })
afterEach(() => rmSync(ws, { recursive: true, force: true }))

function recProvider(runs: { stageKey: string; agentId: string; prompt: string }[]): AgentProvider {
  return {
    id: 'rec', displayName: 'Rec',
    capabilities: { structuredOutput: false, permissionHook: false, pty: false },
    async detect() { return true }, async listModels() { return [] },
    run(task, cb) {
      runs.push({ stageKey: task.stageKey, agentId: task.agentId, prompt: task.prompt })
      cb.onState('run')
      const done = (async () => { cb.onState('ok'); cb.onDone({ ok: true, summary: 'ok' } as any); return { ok: true } })()
      return { id: task.agentId, cancel() {}, done }
    }
  }
}

describe('Orchestrator custom (non-builtin) stages (#3)', () => {
  it('runs a stage with a custom key and uses its prompt as the full body (no builtin base)', async () => {
    const bus = new EventBus()
    const runs: { stageKey: string; agentId: string; prompt: string }[] = []
    const orch = new Orchestrator({ bus, providers: { rec: recProvider(runs) }, proxy: () => '' })
    bus.subscribe(e => { if (e.type === 'pending:add') setTimeout(() => orch.resolve({ id: e.action.id, decision: 'allow' }), 0) })

    const run = await orch.startRun({
      runId: 'c1', workspaceName: 'ws', workspacePath: ws,
      stages: [{ key: 'security-audit', name: '安全审计', provider: 'rec', model: 'm', prompt: '逐条核对 OWASP Top 10', gate: true }],
      developProjects: []
    })

    expect(run.status).toBe('ok')
    const audit = runs.find(r => r.stageKey === 'security-audit')!
    expect(audit).toBeTruthy()
    expect(audit.prompt).toContain('安全审计')          // custom name shown as the stage name
    expect(audit.prompt).toContain('逐条核对 OWASP Top 10') // custom prompt is the body
  })

  it('a custom stage with review:parallel fans out reviewers (behavior driven by flag, not key)', async () => {
    const bus = new EventBus()
    const runs: { stageKey: string; agentId: string; prompt: string }[] = []
    const orch = new Orchestrator({ bus, providers: { rec: recProvider(runs) }, proxy: () => '' })
    bus.subscribe(e => { if (e.type === 'pending:add') setTimeout(() => orch.resolve({ id: e.action.id, decision: 'allow' }), 0) })

    const run = await orch.startRun({
      runId: 'c2', workspaceName: 'ws', workspacePath: ws,
      stages: [{
        key: 'lint-review', name: '规范审查', provider: 'rec', model: 'm', gate: false,
        review: { mode: 'parallel', scope: 'workspace', reviewers: ['correctness', 'security'] },
      }],
      developProjects: []
    })

    expect(run.status).toBe('ok')
    // two lens reviewers fanned out for a NON-'review' stage key
    const stage = run.stages.find(s => s.key === 'lint-review')!
    expect(stage.agents.length).toBe(2)
  })

  it('a per-project review stage honors the spec.projects subset (门控里 3 选 2 只评审所选项目)', async () => {
    const bus = new EventBus()
    const runs: { stageKey: string; agentId: string; prompt: string }[] = []
    const orch = new Orchestrator({ bus, providers: { rec: recProvider(runs) }, proxy: () => '' })
    bus.subscribe(e => { if (e.type === 'pending:add') setTimeout(() => orch.resolve({ id: e.action.id, decision: 'allow' }), 0) })

    const run = await orch.startRun({
      runId: 'c4', workspaceName: 'ws', workspacePath: ws,
      stages: [{
        key: 'code-review', name: '代码 CR', provider: 'rec', model: 'm', gate: false,
        review: { mode: 'parallel', scope: 'per-project' },
        projects: ['web', 'api'], // user ticked 2 of the 3 projects in the approval card
      }],
      developProjects: [
        { name: 'web', cwd: join(ws, 'web') },
        { name: 'api', cwd: join(ws, 'api') },
        { name: 'infra', cwd: join(ws, 'infra') },
      ],
    })

    expect(run.status).toBe('ok')
    const stage = run.stages.find(s => s.key === 'code-review')!
    // Only the 2 chosen projects get a reviewer — the review branch used to fan out over ALL 3.
    expect(stage.agents.map(a => a.name).sort()).toEqual(['api', 'web'])
  })

  it('gate:false on a custom stage skips the review gate entirely', async () => {
    const bus = new EventBus()
    const events: any[] = []
    bus.subscribe(e => events.push(e))
    const orch = new Orchestrator({ bus, providers: { rec: recProvider([]) }, proxy: () => '' })

    const run = await orch.startRun({
      runId: 'c3', workspaceName: 'ws', workspacePath: ws,
      stages: [{ key: 'notes', name: '随手记', provider: 'rec', model: 'm', gate: false }],
      developProjects: []
    })

    expect(run.status).toBe('ok')
    expect(events.some(e => e.type === 'pending:add')).toBe(false)
  })
})

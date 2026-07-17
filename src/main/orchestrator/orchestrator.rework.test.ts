import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Orchestrator, parseReworkJson } from './orchestrator'
import { EventBus } from './eventBus'
import type { AgentProvider } from '../agents/types'
import type { EngineEvent } from '@shared/types'

let ws: string
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'wsrework-')) })
afterEach(() => rmSync(ws, { recursive: true, force: true }))

// Records each run's (stageKey, prompt) so tests can assert re-runs + rework-note injection.
function recordingProvider(runs: { stageKey: string; prompt: string }[]): AgentProvider {
  return {
    id: 'rec', displayName: 'Rec',
    capabilities: { structuredOutput: false, permissionHook: false, pty: false },
    async detect() { return true }, async listModels() { return [] },
    run(task, cb) {
      runs.push({ stageKey: task.stageKey, prompt: task.prompt })
      cb.onState('run')
      const done = (async () => { cb.onState('ok'); const r = { ok: true, summary: 'ok' }; cb.onDone(r); return r })()
      return { id: task.agentId, cancel() {}, done }
    }
  }
}

// Drive gates by scripting one response per pending:add, in order.
function scriptGates(bus: EventBus, orch: Orchestrator, responses: { decision: 'allow' | 'deny' | 'modify'; value?: string }[]) {
  let i = 0
  bus.subscribe(e => {
    if (e.type === 'pending:add' && e.action.kind === 'confirm') {
      const r = responses[i++] ?? { decision: 'allow' }
      setTimeout(() => orch.resolve({ id: e.action.id, decision: r.decision, value: r.value }), 0)
    }
  })
}

describe('Orchestrator per-stage rework loop (打回重做)', () => {
  it('modify re-runs the SAME stage carrying the revision direction, then allow proceeds', async () => {
    const bus = new EventBus()
    const runs: { stageKey: string; prompt: string }[] = []
    const orch = new Orchestrator({ bus, providers: { rec: recordingProvider(runs) }, proxy: () => '' })
    // design gate: modify → re-run; design gate again: allow → develop; develop gate: allow → done.
    scriptGates(bus, orch, [
      { decision: 'modify', value: '请补充鉴权边界的分析' },
      { decision: 'allow' },
      { decision: 'allow' },
    ])

    const run = await orch.startRun({
      runId: 'rw1', workspaceName: 'ws', workspacePath: ws,
      stages: [
        { key: 'design', name: '技术方案设计', provider: 'rec', model: 'm', gate: true },
        { key: 'develop', name: '代码开发', provider: 'rec', model: 'm', gate: true },
      ],
      developProjects: []
    })

    expect(run.status).toBe('ok')
    // design ran twice (original + rework), develop once
    const designRuns = runs.filter(r => r.stageKey === 'design')
    expect(designRuns.length).toBe(2)
    expect(runs.filter(r => r.stageKey === 'develop').length).toBe(1)
    // the SECOND design run carries the rework direction; the first does not
    expect(designRuns[0].prompt).not.toContain('请补充鉴权边界的分析')
    expect(designRuns[1].prompt).toContain('请补充鉴权边界的分析')
    expect(designRuns[1].prompt).toContain('返工要求')
  })

  it('modify then deny (终止) re-runs once then stops the whole run; develop never runs', async () => {
    const bus = new EventBus()
    const runs: { stageKey: string; prompt: string }[] = []
    const orch = new Orchestrator({ bus, providers: { rec: recordingProvider(runs) }, proxy: () => '' })
    scriptGates(bus, orch, [
      { decision: 'modify', value: '方向不对，重来' },
      { decision: 'deny' },
    ])

    const run = await orch.startRun({
      runId: 'rw2', workspaceName: 'ws', workspacePath: ws,
      stages: [
        { key: 'design', name: '技术方案设计', provider: 'rec', model: 'm', gate: true },
        { key: 'develop', name: '代码开发', provider: 'rec', model: 'm', gate: true },
      ],
      developProjects: []
    })

    expect(run.status).toBe('err')
    expect(runs.filter(r => r.stageKey === 'design').length).toBe(2)
    expect(runs.some(r => r.stageKey === 'develop')).toBe(false)
  })

  it('gate:true makes a NON-design stage (requirement) gate + reworkable', async () => {
    const bus = new EventBus()
    const events: EngineEvent[] = []
    bus.subscribe(e => events.push(e))
    const runs: { stageKey: string; prompt: string }[] = []
    const orch = new Orchestrator({ bus, providers: { rec: recordingProvider(runs) }, proxy: () => '' })
    scriptGates(bus, orch, [
      { decision: 'modify', value: '需求理解有偏差' },
      { decision: 'allow' },
    ])

    const run = await orch.startRun({
      runId: 'rw3', workspaceName: 'ws', workspacePath: ws,
      stages: [{ key: 'requirement', name: '需求评估', provider: 'rec', model: 'm', gate: true }],
      developProjects: []
    })

    expect(run.status).toBe('ok')
    expect(runs.filter(r => r.stageKey === 'requirement').length).toBe(2)
    // the gate for a non-design stage still fires and is marked reworkable
    const gate = events.find(e => e.type === 'pending:add' && e.action.kind === 'confirm')
    expect(gate && gate.type === 'pending:add' && gate.action.kind === 'confirm' && gate.action.reworkable).toBe(true)
  })

  // A provider whose chat() returns a canned rework-plan JSON (drives planRework), and whose run()
  // records (agentId, prompt) so tests can assert WHICH projects re-ran.
  function providerWithChat(runs: { agentId: string; stageKey: string; prompt: string }[], planJson: string): AgentProvider {
    return {
      id: 'rec', displayName: 'Rec',
      capabilities: { structuredOutput: false, permissionHook: false, pty: false },
      async detect() { return true }, async listModels() { return [] },
      run(task, cb) {
        runs.push({ agentId: task.agentId, stageKey: task.stageKey, prompt: task.prompt })
        cb.onState('run')
        const done = (async () => { cb.onState('ok'); const r = { ok: true, summary: 'ok' }; cb.onDone(r); return r })()
        return { id: task.agentId, cancel() {}, done }
      },
      chat(task, cb) {
        cb.onAssistantDelta(planJson)
        cb.onDone({ elapsed: 0 })
        return { id: task.id, cancel() {}, done: Promise.resolve({ ok: true, summary: '' }) }
      },
    }
  }

  it('per-project 打回: 主代理判断无需读码 → 直接出修订版方案再门控,不重跑子代理', async () => {
    const bus = new EventBus()
    const runs: { agentId: string; stageKey: string; prompt: string }[] = []
    const bodies: string[] = []
    const provider = providerWithChat(runs, JSON.stringify({ needsCode: false, projects: [], revised: '# 修订版方案\n结合你的意见改好了', summary: '直接改' }))
    const orch = new Orchestrator({ bus, providers: { rec: provider }, proxy: () => '' })
    let n = 0
    bus.subscribe(e => {
      if (e.type === 'pending:add' && e.action.kind === 'confirm' && e.action.reworkable) {
        bodies.push((e.action as { body?: string }).body ?? '')
        const d = n++ === 0 ? { decision: 'modify' as const, value: '鉴权边界再细化' } : { decision: 'allow' as const }
        setTimeout(() => orch.resolve({ id: e.action.id, ...d }), 0)
      }
    })
    const run = await orch.startRun({
      runId: 'rwpp1', workspaceName: 'ws', workspacePath: ws,
      stages: [{ key: 'design', name: '技术方案设计', provider: 'rec', model: 'm', gate: true }],
      developProjects: [{ name: 'p1', cwd: ws }, { name: 'p2', cwd: ws }] as never,
    })
    expect(run.status).toBe('ok')
    // round 0 fan-out = p1 + p2 + 汇总 (3 design-keyed runs); the reason-only re-gate does NOT re-run anything.
    expect(runs.filter(r => r.stageKey === 'design').length).toBe(3)
    // the SECOND gate shows the main agent's revised proposal, not a re-fan-out result.
    expect(bodies[1]).toContain('修订版方案')
  })

  it('per-project 打回: 主代理判断需读码 → 先问要不要重探,只重跑被选中的项目', async () => {
    const bus = new EventBus()
    const runs: { agentId: string; stageKey: string; prompt: string }[] = []
    let askedReprobe = false
    const provider = providerWithChat(runs, JSON.stringify({ needsCode: true, projects: ['p2'], directive: '重新核实 p2 的实现细节', summary: '需要重探 p2' }))
    const orch = new Orchestrator({ bus, providers: { rec: provider }, proxy: () => '' })
    let n = 0
    bus.subscribe(e => {
      if (e.type !== 'pending:add') return
      const a = e.action
      if (a.kind === 'confirm' && a.reworkable) {
        const d = n++ === 0 ? { decision: 'modify' as const, value: 'p2 有问题' } : { decision: 'allow' as const }
        setTimeout(() => orch.resolve({ id: a.id, ...d }), 0)
      } else if (a.kind === 'select') {
        askedReprobe = true
        // choose "重新分析这些项目" (choice 0)
        setTimeout(() => orch.resolve({ id: a.id, decision: 'allow', choice: 0 }), 0)
      }
    })
    const run = await orch.startRun({
      runId: 'rwpp2', workspaceName: 'ws', workspacePath: ws,
      stages: [{ key: 'design', name: '技术方案设计', provider: 'rec', model: 'm', gate: true }],
      developProjects: [{ name: 'p1', cwd: ws }, { name: 'p2', cwd: ws }] as never,
    })
    expect(run.status).toBe('ok')
    expect(askedReprobe).toBe(true)                                 // user was asked before re-reading code
    expect(runs.filter(r => r.agentId === 'design:p1').length).toBe(1) // p1 kept, NOT re-run
    expect(runs.filter(r => r.agentId === 'design:p2').length).toBe(2) // only p2 re-probed
    expect(runs.filter(r => r.agentId === 'design:p2')[1].prompt).toContain('重新核实 p2') // directive injected
  })

  it('parseReworkJson tolerates a ```json fence + surrounding prose; returns undefined when unparseable', () => {
    expect(parseReworkJson('```json\n{"needsCode":true,"projects":["a"]}\n```')).toEqual({ needsCode: true, projects: ['a'] })
    expect(parseReworkJson('好的,我的判断:\n{"needsCode":false,"revised":"x"}\n以上。')).toEqual({ needsCode: false, revised: 'x' })
    expect(parseReworkJson('完全没有 JSON')).toBeUndefined()
    expect(parseReworkJson('{坏的 json')).toBeUndefined()
  })

  it('gate:true gates the LAST stage too (design as sole stage fires a gate)', async () => {
    const bus = new EventBus()
    const events: EngineEvent[] = []
    bus.subscribe(e => events.push(e))
    const runs: { stageKey: string; prompt: string }[] = []
    const orch = new Orchestrator({ bus, providers: { rec: recordingProvider(runs) }, proxy: () => '' })
    scriptGates(bus, orch, [{ decision: 'allow' }])

    const run = await orch.startRun({
      runId: 'rw4', workspaceName: 'ws', workspacePath: ws,
      stages: [{ key: 'design', name: '技术方案设计', provider: 'rec', model: 'm', gate: true }],
      developProjects: []
    })

    expect(run.status).toBe('ok')
    expect(events.some(e => e.type === 'pending:add' && e.action.kind === 'confirm')).toBe(true)
  })
})

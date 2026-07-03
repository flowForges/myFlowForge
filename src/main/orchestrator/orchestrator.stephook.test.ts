import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Orchestrator } from './orchestrator'
import { EventBus } from './eventBus'
import type { AgentTask, AgentCallbacks, AgentProvider, AgentSession } from '../agents/types'
import type { StartRunOpts } from './orchestrator'

// Fake provider that RECORDS every task it receives (to assert ordering) and auto-completes
// each agent. A `holdHook` option lets a test pause a hook's completion so cancellation can be
// exercised deterministically (not used here — see note in the cancel case).
function recordingProvider() {
  const tasks: AgentTask[] = []
  const provider: AgentProvider = {
    id: 'claude',
    displayName: 'Claude',
    capabilities: { structuredOutput: false, permissionHook: false, pty: false, mcpTools: true },
    detect: async () => true,
    listModels: async () => [],
    run: (task, cb: AgentCallbacks) => {
      tasks.push(task)
      let resolveDone!: (r: { ok: boolean }) => void
      const done = new Promise<{ ok: boolean }>(r => { resolveDone = r })
      queueMicrotask(() => {
        cb.onState('run')
        cb.onLog({ ts: '00:00:00', text: `output of ${task.name}`, level: 'ok', kind: 'output' })
        cb.onState('ok')
        cb.onDone({ ok: true })
        resolveDone({ ok: true })
      })
      return { id: task.agentId, cancel: () => resolveDone({ ok: false }), done } as AgentSession
    },
  }
  return { tasks, provider }
}

const baseOpts = (workspacePath: string, stepPlugins: any[]): StartRunOpts => ({
  runId: 'r',
  workspaceName: 'ws',
  workspacePath,
  task: '做个登录页',
  stages: [
    { key: 'requirement', name: '需求评估', provider: 'claude', model: 'opus-4.8', scope: 'root' },
    { key: 'design', name: '技术方案设计', provider: 'claude', model: 'opus-4.8', scope: 'root' },
  ],
  developProjects: [],
  stepPlugins,
} as StartRunOpts)

describe('orchestrator runs __wf step plugins at run completion', () => {
  it('runs an __wf hook AFTER all stage tasks, and does NOT run __basic/__proj step plugins (deferred)', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'orch-stephook-'))
    const rp = recordingProvider()
    const bus = new EventBus()
    const orch = new Orchestrator({ bus, providers: { claude: rp.provider }, proxy: () => '' })

    await orch.startRun(baseOpts(ws, [
      { id: 'wf1', name: '收尾整理', prompt: '总结本次工作流', after: '__wf', tools: [], skills: [] },
      { id: 'b1', name: '建区初始化', prompt: 'x', after: '__basic', tools: [], skills: [] },
      { id: 'p1', name: '项目初始化', prompt: 'x', after: '__proj', tools: [], skills: [] },
    ]))

    const reqIdx = rp.tasks.findIndex(t => t.stageKey === 'requirement')
    const designIdx = rp.tasks.findIndex(t => t.stageKey === 'design')
    const wfIdx = rp.tasks.findIndex(t => t.stageKey === 'hook:wf1')

    expect(reqIdx).toBeGreaterThanOrEqual(0)
    expect(designIdx).toBeGreaterThanOrEqual(0)
    expect(wfIdx).toBeGreaterThan(reqIdx)        // __wf after requirement
    expect(wfIdx).toBeGreaterThan(designIdx)     // __wf after design — i.e. after ALL stages

    // __basic / __proj are deferred — they must NOT execute.
    expect(rp.tasks.some(t => t.stageKey === 'hook:b1')).toBe(false)
    expect(rp.tasks.some(t => t.stageKey === 'hook:p1')).toBe(false)

    // The __wf hook is surfaced as a StageRuntime keyed hook:<id> with the HOOK role.
    const run = orch.getRun()!
    const wfStage = run.stages.find(s => s.key === 'hook:wf1')!
    expect(wfStage).toBeTruthy()
    expect(wfStage.state).toBe('ok')
    expect(wfStage.agents[0].hook).toBe(true)
    expect(run.status).toBe('ok')

    rmSync(ws, { recursive: true, force: true })
  })

  it('a cancelled run SKIPS __wf step plugins', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'orch-stephook-'))
    const rp = recordingProvider()
    const bus = new EventBus()
    const orch = new Orchestrator({ bus, providers: { claude: rp.provider }, proxy: () => '' })

    const p = orch.startRun(baseOpts(ws, [
      { id: 'wf1', name: '收尾整理', prompt: 'x', after: '__wf', tools: [], skills: [] },
    ]))
    // Cancel before the run completes; the __wf hook must never execute.
    orch.cancel()
    await p

    expect(rp.tasks.some(t => t.stageKey === 'hook:wf1')).toBe(false)
    expect(orch.getRun()!.status).toBe('err')

    rmSync(ws, { recursive: true, force: true })
  })
})

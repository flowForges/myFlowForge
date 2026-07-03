import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Orchestrator } from './orchestrator'
import { EventBus } from './eventBus'
import type { AgentTask, AgentCallbacks, AgentProvider, AgentSession } from '../agents/types'
import type { StartRunOpts } from './orchestrator'

// Fake provider that RECORDS every task it receives (to assert weave order + allowedTools) and
// auto-completes each agent: onState('ok') + resolve done. `failHook` makes any hook:* task error.
function recordingProvider(opts: { failHook?: boolean } = {}) {
  const tasks: AgentTask[] = []
  const provider: AgentProvider = {
    id: 'claude',
    displayName: 'Claude',
    capabilities: { structuredOutput: false, permissionHook: false, pty: false, mcpTools: true },
    detect: async () => true,
    listModels: async () => [],
    run: (task, cb: AgentCallbacks) => {
      tasks.push(task)
      const isHook = task.stageKey.startsWith('hook:')
      let resolveDone!: (r: { ok: boolean }) => void
      const done = new Promise<{ ok: boolean }>(r => { resolveDone = r })
      // Async-complete on a microtask so startRun's await ordering is exercised realistically.
      queueMicrotask(() => {
        cb.onState('run')
        if (isHook && opts.failHook) {
          cb.onError(new Error('hook boom'))
          cb.onState('err')
          resolveDone({ ok: false })
          return
        }
        // Emit an output log so a hook's brief captures real text.
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

const baseOpts = (workspacePath: string, plugins: any[]): StartRunOpts => ({
  runId: 'r',
  workspaceName: 'ws',
  workspacePath,
  task: '做个登录页',
  stages: [
    { key: 'requirement', name: '需求评估', provider: 'claude', model: 'opus-4.8', scope: 'root' },
    { key: 'design', name: '技术方案设计', provider: 'claude', model: 'opus-4.8', scope: 'root' },
  ],
  developProjects: [],
  plugins,
} as StartRunOpts)

describe('orchestrator weaves & runs wf-scope plugins', () => {
  it('runs the hook AFTER its `after` stage and BEFORE the next, with mapped allowedTools, and chains output into briefs', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'orch-plugin-'))
    const rp = recordingProvider()
    const bus = new EventBus()
    const orch = new Orchestrator({ bus, providers: { claude: rp.provider }, proxy: () => '' })

    await orch.startRun(baseOpts(ws, [
      { id: 'h1', name: '读取记忆', prompt: '整理偏好', after: 'requirement', tools: ['read'], skills: [] },
    ]))

    const reqIdx = rp.tasks.findIndex(t => t.stageKey === 'requirement')
    const hookIdx = rp.tasks.findIndex(t => t.stageKey.startsWith('hook:'))
    const designIdx = rp.tasks.findIndex(t => t.stageKey === 'design')

    expect(reqIdx).toBeGreaterThanOrEqual(0)
    expect(hookIdx).toBeGreaterThan(reqIdx)       // hook after requirement
    expect(designIdx).toBeGreaterThan(hookIdx)    // hook before design

    // tools:['read'] → claudeAllowedTools → ['Read']
    expect(rp.tasks[hookIdx].allowedTools).toEqual(['Read'])
    expect(rp.tasks[hookIdx].skills).toEqual([])
    expect(rp.tasks[hookIdx].cwd).toBe(ws)         // workspace root, not per-project
    expect(rp.tasks[hookIdx].stageKey).toBe('hook:h1')

    // Output chaining: the design stage's prompt sees the hook's output (briefs include plugin name).
    const designPrompt = rp.tasks[designIdx].prompt
    expect(designPrompt).toContain('读取记忆')

    // Hook surfaced as a StageRuntime with key hook:<id>, a single agent tagged hook + HOOK role.
    const run = orch.getRun()!
    const hookStage = run.stages.find(s => s.key === 'hook:h1')!
    expect(hookStage).toBeTruthy()
    expect(hookStage.state).toBe('ok')
    expect(hookStage.agents).toHaveLength(1)
    expect(hookStage.agents[0].hook).toBe(true)
    expect(hookStage.agents[0].role).toBe('插件 · HOOK')
    expect(run.status).toBe('ok')

    rmSync(ws, { recursive: true, force: true })
  })

  it('a hook agent failure does NOT abort the run — downstream stage still runs, and a failure brief is chained', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'orch-plugin-'))
    const rp = recordingProvider({ failHook: true })
    const bus = new EventBus()
    const orch = new Orchestrator({ bus, providers: { claude: rp.provider }, proxy: () => '' })

    await orch.startRun(baseOpts(ws, [
      { id: 'h1', name: '坏插件', prompt: 'x', after: 'requirement', tools: [], skills: [] },
    ]))

    // The design stage still ran despite the hook erroring.
    expect(rp.tasks.some(t => t.stageKey === 'design')).toBe(true)
    // Failure brief chained: the design prompt references the failed plugin / failure note.
    const designPrompt = rp.tasks.find(t => t.stageKey === 'design')!.prompt
    expect(designPrompt).toContain('坏插件')
    expect(designPrompt).toContain('插件失败')

    rmSync(ws, { recursive: true, force: true })
  })

  it('a failed hook does NOT flip the run to err — run.status is ok when all real stages succeed (spec §7 non-gating)', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'orch-plugin-nongating-'))
    const rp = recordingProvider({ failHook: true })
    const bus = new EventBus()
    const orch = new Orchestrator({ bus, providers: { claude: rp.provider }, proxy: () => '' })

    await orch.startRun(baseOpts(ws, [
      { id: 'h1', name: '坏钩子', prompt: '出错', after: 'requirement', tools: [], skills: [] },
    ]))

    const run = orch.getRun()!
    // All real stages (requirement, design) succeeded; only hook:h1 errored.
    expect(run.stages.find(s => s.key === 'requirement')!.state).toBe('ok')
    expect(run.stages.find(s => s.key === 'design')!.state).toBe('ok')
    expect(run.stages.find(s => s.key === 'hook:h1')!.state).toBe('err')
    // The run itself must be ok — hook errors are non-gating per spec §7.
    expect(run.status).toBe('ok')

    rmSync(ws, { recursive: true, force: true })
  })
})

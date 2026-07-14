import { describe, it, expect, vi } from 'vitest'
import { makeProposeRun } from './proposeRun'
import type { ProposeDeps } from './proposeRun'

const ws = {
  name: 'w', repoId: 'r', root: '/w', workflowId: 'standard', status: 'idle',
  stages: [{ key: 'develop', provider: 'claude', model: 'opus-4.8' }], projects: [],
} as any

function mkDeps(over: Partial<ProposeDeps> = {}): ProposeDeps {
  return {
    getRun: () => ({ id: 'run-42', status: 'idle' } as any),
    readWorkspace: () => ws,
    readWorkflows: () => [],
    writeWorkspace: () => {},
    startRun: () => {},
    emitPlanRequest: () => {},
    emitNote: () => {},
    setSessionMode: () => {},
    emitModeChanged: () => {},
    ...over,
  }
}

describe('proposeRun mode flip', () => {
  it('allow → startRun, then sets session mode=workflow with runId, notes, emits mode-changed', async () => {
    const startRun = vi.fn()
    const setSessionMode = vi.fn()
    const emitNote = vi.fn()
    const emitModeChanged = vi.fn()
    const captured: string[] = []
    const deps = mkDeps({
      startRun,
      setSessionMode,
      emitNote,
      emitModeChanged,
      getRun: () => ({ id: 'run-42', status: 'idle' } as any),
      emitPlanRequest: (_w, req) => captured.push(req.id),
    })
    const propose = makeProposeRun(deps)
    const p = propose('/w', '迁移 OKLch', '迁移 OKLch')
    propose.resolve(captured[0], { decision: 'allow' })
    const r = await p
    expect(r.approved).toBe(true)
    expect(startRun).toHaveBeenCalledTimes(1)
    expect(setSessionMode).toHaveBeenCalledWith('/w', 'workflow', 'run-42')
    expect(emitModeChanged).toHaveBeenCalledWith('/w', 'workflow', 'run-42')
    expect(emitNote).toHaveBeenCalledWith('/w', '识别到任务型指令 · 已自动编排为多代理工作流')
  })

  it('deny → no startRun, no mode flip, no mode-changed', async () => {
    const startRun = vi.fn()
    const setSessionMode = vi.fn()
    const emitModeChanged = vi.fn()
    const captured: string[] = []
    const deps = mkDeps({ startRun, setSessionMode, emitModeChanged, emitPlanRequest: (_w, req) => captured.push(req.id) })
    const propose = makeProposeRun(deps)
    const p = propose('/w', 'x', 'x')
    propose.resolve(captured[0], { decision: 'deny' })
    const r = await p
    expect(r.approved).toBe(false)
    expect(startRun).not.toHaveBeenCalled()
    expect(setSessionMode).not.toHaveBeenCalled()
    expect(emitModeChanged).not.toHaveBeenCalled()
  })

  it('modify → no startRun, no mode flip, returns feedback', async () => {
    const startRun = vi.fn()
    const setSessionMode = vi.fn()
    const captured: string[] = []
    const deps = mkDeps({ startRun, setSessionMode, emitPlanRequest: (_w, req) => captured.push(req.id) })
    const propose = makeProposeRun(deps)
    const p = propose('/w', 'x', 'x')
    propose.resolve(captured[0], { decision: 'modify', value: '换个方案' })
    const r = await p
    expect(r).toEqual({ approved: false, feedback: '换个方案' })
    expect(startRun).not.toHaveBeenCalled()
    expect(setSessionMode).not.toHaveBeenCalled()
  })

  // 回归:主代理 turn 中断/出错时,仍阻塞在审批的 propose 会孤立泄漏,卡片诡异"自己消失"。
  // turn 结束时须能把本工作区所有待审批 propose 判为 deny 并回收,交由 handlers 广播 plan-resolved 清卡。
  it('cancelForWorkspace denies pending proposes, returns their ids, and clears them', async () => {
    const captured: string[] = []
    const deps = mkDeps({ emitPlanRequest: (_w, req) => captured.push(req.id) })
    const propose = makeProposeRun(deps)
    const p = propose('/w', 'x', 'x')
    expect(propose.has(captured[0])).toBe(true)
    const cancelled = propose.cancelForWorkspace('/w')
    expect(cancelled).toEqual([captured[0]])
    const r = await p
    expect(r).toEqual({ approved: false })
    expect(propose.has(captured[0])).toBe(false)
  })

  it('cancelForWorkspace only touches the given workspace, leaving others pending', async () => {
    const captured: { w: string; id: string }[] = []
    const deps = mkDeps({ emitPlanRequest: (w, req) => captured.push({ w, id: req.id }) })
    const propose = makeProposeRun(deps)
    void propose('/w', 'x', 'x')
    void propose('/other', 'y', 'y')
    const idW = captured.find(c => c.w === '/w')!.id
    const idOther = captured.find(c => c.w === '/other')!.id
    const cancelled = propose.cancelForWorkspace('/w')
    expect(cancelled).toEqual([idW])
    expect(propose.has(idW)).toBe(false)
    expect(propose.has(idOther)).toBe(true)
  })

  it('cancelForWorkspace skips excluded ids (prior turns\' still-pending proposes survive)', async () => {
    const captured: string[] = []
    const deps = mkDeps({ emitPlanRequest: (_w, req) => captured.push(req.id) })
    const propose = makeProposeRun(deps)
    void propose('/w', 'prior', 'prior')            // 上一轮遗留的待审批卡片
    const priorIds = new Set(propose.pendingIds('/w'))
    void propose('/w', 'this-turn', 'this-turn')    // 本轮产生、随后被中断的方案
    const cancelled = propose.cancelForWorkspace('/w', priorIds)
    expect(cancelled).toEqual([captured[1]])         // 只回收本轮的
    expect(propose.has(captured[0])).toBe(true)      // 上一轮的卡片保留
    expect(propose.has(captured[1])).toBe(false)
  })

  // Selective execution: the agent may narrow the run to a subset of stages, and scope per-project
  // stages to a subset of projects — globally or per-stage (analyze all, develop some).
  const wsMulti = {
    name: 'w', path: '/w', workflowId: 'standard', status: 'idle',
    stages: [
      { key: 'requirement', provider: 'claude', model: 'opus-4.8' },
      { key: 'design', provider: 'claude', model: 'opus-4.8' },   // per-project by default
      { key: 'develop', provider: 'claude', model: 'opus-4.8' },  // per-project by default
      { key: 'test', provider: 'claude', model: 'opus-4.8' },
      { key: 'review', provider: 'claude', model: 'opus-4.8' },
    ],
    projects: [{ name: 'a', repoId: 'a', branch: 'main' }, { name: 'b', repoId: 'b', branch: 'main' }],
  } as any

  it('narrows to chosen stages + a global project subset (developProjects stays full)', async () => {
    const startRun = vi.fn()
    const captured: string[] = []
    const deps = mkDeps({ startRun, readWorkspace: () => wsMulti, emitPlanRequest: (_w, req) => captured.push(req.id) })
    const propose = makeProposeRun(deps)
    const p = propose('/w', 'small task', 'small task', { stages: ['requirement', 'develop'], projects: ['a'] })
    propose.resolve(captured[0], { decision: 'allow' })
    await p
    const opts = startRun.mock.calls[0][0]
    expect(opts.stages.map((s: any) => s.key)).toEqual(['requirement', 'develop'])
    expect(opts.developProjects.map((d: any) => d.name)).toEqual(['a', 'b'])   // full set of worktrees
    expect(opts.stages.find((s: any) => s.key === 'develop').projects).toEqual(['a'])  // stage scoped
  })

  it('stageProjects scopes per stage — analyze all, develop only some', async () => {
    const startRun = vi.fn()
    const captured: string[] = []
    const deps = mkDeps({ startRun, readWorkspace: () => wsMulti, emitPlanRequest: (_w, req) => captured.push(req.id) })
    const propose = makeProposeRun(deps)
    const p = propose('/w', 't', 't', { stageProjects: { design: ['a', 'b'], develop: ['a'] } })
    propose.resolve(captured[0], { decision: 'allow' })
    await p
    const opts = startRun.mock.calls[0][0]
    expect(opts.stages.find((s: any) => s.key === 'design').projects).toEqual(['a', 'b'])
    expect(opts.stages.find((s: any) => s.key === 'develop').projects).toEqual(['a'])
    expect(opts.stages.find((s: any) => s.key === 'requirement').projects).toBeUndefined()
  })

  // Multi-workflow-per-workspace: select.workflowId picks a named workflow's own固化 stages;
  // no workflowId falls back to the ad-hoc union of every workspace workflow's stages so
  // select.stages can narrow across all of them.
  const wsDouble = {
    name: 'w', path: '/w', workflowId: 'standard', status: 'idle', stages: [], projects: [],
    workflows: [
      { id: 'quick', name: '快速修复', stages: [
        { key: 'requirement', provider: 'claude', model: 'opus-4.8' },
        { key: 'design', provider: 'claude', model: 'opus-4.8' },
      ] },
      { id: 'full', name: '完整流程', stages: [
        { key: 'requirement', provider: 'claude', model: 'opus-4.8' },
        { key: 'design', provider: 'claude', model: 'opus-4.8' },
        { key: 'develop', provider: 'claude', model: 'opus-4.8' },
        { key: 'test', provider: 'claude', model: 'opus-4.8' },
        { key: 'review', provider: 'claude', model: 'opus-4.8' },
      ] },
    ],
  } as any

  it('select.workflowId=full → 用 full 的 stages,plan-request 带 workflowName', async () => {
    const emitted: any[] = []
    const deps = mkDeps({ readWorkspace: () => wsDouble, emitPlanRequest: (_p, r) => emitted.push(r) })
    const propose = makeProposeRun(deps)
    const p = propose('/w', '方案', 'task', { workflowId: 'full' })
    const req = emitted[0]
    expect(req.workflowName).toBe('完整流程')
    expect(req.stages.map((s: any) => s.name)).toContain('代码开发')  // full 含 develop
    // Task 12: workflowOptions carries every workspace workflow (not just the matched one) so the
    // approval card can offer a switch dropdown.
    expect(req.workflowOptions).toEqual([{ id: 'quick', name: '快速修复' }, { id: 'full', name: '完整流程' }])
    propose.resolve(req.id, { decision: 'deny' })
    await p
  })

  it('无 workflowId + stages 裁剪 → ad-hoc union,workflowName 缺省', async () => {
    const emitted: any[] = []
    const deps = mkDeps({ readWorkspace: () => wsDouble, emitPlanRequest: (_p, r) => emitted.push(r) })
    const propose = makeProposeRun(deps)
    const p = propose('/w', '临时', 'task', { stages: ['requirement', 'design'] })
    const req = emitted[0]
    expect(req.workflowName).toBeUndefined()
    expect(req.stages.map((s: any) => s.name)).toEqual(['需求评估', '技术方案设计'])
    propose.resolve(req.id, { decision: 'deny' })
    await p
  })

  it('does not flip mode when a run is already live (allow rejected)', async () => {
    const startRun = vi.fn()
    const setSessionMode = vi.fn()
    const emitNote = vi.fn()
    const captured: string[] = []
    const deps = mkDeps({
      startRun,
      setSessionMode,
      emitNote,
      getRun: () => ({ id: 'run-9', status: 'run' } as any),
      emitPlanRequest: (_w, req) => captured.push(req.id),
    })
    const propose = makeProposeRun(deps)
    const p = propose('/w', 'x', 'x')
    propose.resolve(captured[0], { decision: 'allow' })
    const r = await p
    expect(r.approved).toBe(false)
    expect(startRun).not.toHaveBeenCalled()
    expect(setSessionMode).not.toHaveBeenCalled()
    expect(emitNote).toHaveBeenCalledWith('/w', '已有运行进行中,稍后再试。')
  })
})

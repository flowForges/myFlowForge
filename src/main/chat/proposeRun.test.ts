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

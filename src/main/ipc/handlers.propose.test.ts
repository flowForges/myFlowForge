import { describe, it, expect, vi } from 'vitest'
import { makeProposeRun } from '../chat/proposeRun'

const ws = { name: 'w', path: '/w', workflowId: 'std', status: 'idle' as const,
  stages: [{ key: 'requirement' as const, provider: 'claude', model: 'opus-4.8' }], projects: [],
  plugins: [], stepPlugins: [] }

function deps(over: Partial<any> = {}) {
  return {
    getRun: () => null, readWorkspace: () => ws, readWorkflows: () => [],
    writeWorkspace: vi.fn(),
    startRun: vi.fn(),
    emitPlanRequest: vi.fn(),
    emitNote: vi.fn(),
    setSessionMode: vi.fn(),
    emitModeChanged: vi.fn(),
    ...over,
  }
}

describe('proposeRun choke-point', () => {
  it('批准 → startRun 恰一次,返回 approved', async () => {
    const d = deps()
    const proposeRun = makeProposeRun(d)
    const p = proposeRun('/w', '先建模型', '加评论')
    const { id } = d.emitPlanRequest.mock.calls[0][1]
    proposeRun.resolve(id, { decision: 'allow' })
    expect(await p).toEqual({ approved: true })
    expect(d.startRun).toHaveBeenCalledTimes(1)
  })
  it('取消 → 不 startRun', async () => {
    const d = deps(); const proposeRun = makeProposeRun(d)
    const p = proposeRun('/w', 'x')
    const { id } = d.emitPlanRequest.mock.calls[0][1]
    proposeRun.resolve(id, { decision: 'deny' })
    expect(await p).toEqual({ approved: false })
    expect(d.startRun).not.toHaveBeenCalled()
  })
  it('修改 → 返回 feedback,不 startRun', async () => {
    const d = deps(); const proposeRun = makeProposeRun(d)
    const p = proposeRun('/w', 'x')
    const { id } = d.emitPlanRequest.mock.calls[0][1]
    proposeRun.resolve(id, { decision: 'modify', value: '换个方向' })
    expect(await p).toEqual({ approved: false, feedback: '换个方向' })
    expect(d.startRun).not.toHaveBeenCalled()
  })
  it('已有 run 在跑 → 批准也拒绝并回显', async () => {
    const d = deps({ getRun: () => ({ status: 'run' }) as any })
    const proposeRun = makeProposeRun(d)
    const p = proposeRun('/w', 'x')
    const { id } = d.emitPlanRequest.mock.calls[0][1]
    proposeRun.resolve(id, { decision: 'allow' })
    expect((await p).approved).toBe(false)
    expect(d.startRun).not.toHaveBeenCalled()
  })
})

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Orchestrator, gateApprovedKey } from './orchestrator'
import { EventBus } from './eventBus'
import { RunStore } from './runStore'
import type { AgentProvider } from '../agents/types'

let ws: string
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'ws-gate-')) })
afterEach(() => rmSync(ws, { recursive: true, force: true }))

// Minimal provider: every agent immediately finishes ok.
function okProvider(): AgentProvider {
  return {
    id: 'okp', displayName: 'OK',
    capabilities: { structuredOutput: false, permissionHook: false, pty: false, mcpTools: true } as any,
    async detect() { return true },
    async listModels() { return [] },
    run(task, cb) {
      const done = (async () => { cb.onState('ok'); const r = { ok: true, summary: 'ok' }; cb.onDone(r); return r })()
      return { id: task.agentId, cancel() {}, done }
    },
  }
}

const TWO_STAGE = {
  runId: 'r-gate',
  workspaceName: 'ws',
  workspacePath: '',
  stages: [
    { key: 'design', name: '技术方案', provider: 'okp', model: 'm' },
    { key: 'develop', name: '代码开发', provider: 'okp', model: 'm' },
  ],
  developProjects: [],
}

describe('design review gate persistence', () => {
  it('persists gate-approval when the design gate is APPROVED, so resume treats design as done', async () => {
    const bus = new EventBus()
    bus.subscribe(e => { if (e.type === 'pending:add') setTimeout(() => orch.resolve({ id: e.action.id, decision: 'allow' }), 0) })
    const orch = new Orchestrator({ bus, providers: { okp: okProvider() }, proxy: () => '' })
    const run = await orch.startRun({ ...TWO_STAGE, workspacePath: ws })
    expect(run.status).toBe('ok')
    const store = new RunStore(ws, 'r-gate')
    expect(store.getContext(gateApprovedKey('design'))).toBe(true)
  })

  it('does NOT persist gate-approval when the design gate is DENIED (cancelled at confirm)', async () => {
    const bus = new EventBus()
    bus.subscribe(e => { if (e.type === 'pending:add') setTimeout(() => orch.resolve({ id: e.action.id, decision: 'deny' }), 0) })
    const orch = new Orchestrator({ bus, providers: { okp: okProvider() }, proxy: () => '' })
    const run = await orch.startRun({ ...TWO_STAGE, workspacePath: ws })
    // Denied gate stops the run; design never becomes an approved, resumable-past stage.
    expect(run.status).toBe('err')
    const store = new RunStore(ws, 'r-gate')
    expect(store.getContext(gateApprovedKey('design'))).not.toBe(true)
  })

  // 回归(P2):门控抑制(isLast)此前只按 opts.stages 算,忽略织入的插件 hook。若被门控的 design 恰是
  // stages 里最后一个,但其后还织了一个 after:'design' 的 hook,则 design 并非真正最后一步,门控却被误跳过,
  // hook 会在方案未经评审的情况下继续跑。修复后 isLast 须按织入后的完整序列算。
  it('review gate fires when the gated stage is last among stages but a woven hook still follows', async () => {
    const seen: string[] = []
    const bus = new EventBus()
    bus.subscribe(e => {
      if (e.type === 'pending:add') { seen.push(e.action.id); setTimeout(() => orch.resolve({ id: e.action.id, decision: 'allow' }), 0) }
    })
    const orch = new Orchestrator({ bus, providers: { okp: okProvider() }, proxy: () => '' })
    const hook = { id: 'h1', name: 'Hook', prompt: 'x', after: 'design', skills: [], tools: [] }
    await orch.startRun({
      runId: 'r-gate-hook', workspaceName: 'ws', workspacePath: ws,
      stages: [{ key: 'design', name: '技术方案', provider: 'okp', model: 'm' }],
      developProjects: [],
      plugins: [hook],
    } as any)
    expect(seen.some(id => id.startsWith('review-design'))).toBe(true)
  })

  // 回归(P0):在方案评审门控暂停时点全局「终止」→ orch.cancel() 不经过门控按钮的 resolve。
  // gate 的 `await this.raise(...)` 没有背后进程可杀,若 cancel() 不 drain 挂起的 resolver,该 await 永不返回,
  // 整个 startRun 协程永久悬挂 + 泄漏 bridge socket。修复后 cancel() 必须唤醒它,使 run 干净落 err。
  it('external cancel() while paused at the design gate resolves the run to err without hanging', async () => {
    const bus = new EventBus()
    bus.subscribe(e => { if (e.type === 'pending:add') setTimeout(() => orch.cancel('用户终止'), 0) })
    const orch = new Orchestrator({ bus, providers: { okp: okProvider() }, proxy: () => '' })
    const run = await Promise.race([
      orch.startRun({ ...TWO_STAGE, workspacePath: ws }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('run wedged: startRun 在门控处被 cancel 后从未 resolve')), 1500)),
    ])
    expect(run.status).toBe('err')
    expect(run.pending).toEqual([])   // 挂起的门控卡片已被 drain,不残留
  })
})

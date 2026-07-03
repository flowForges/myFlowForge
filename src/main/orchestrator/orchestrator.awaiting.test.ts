import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Orchestrator } from './orchestrator'
import { EventBus } from './eventBus'
import type { AgentProvider } from '../agents/types'

let ws: string
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'ws-awaiting-')) })
afterEach(() => rmSync(ws, { recursive: true, force: true }))

// provider：run 里发起一次 onConfirm(阻塞等待),拿到决定后完成。
function confirmProvider(): AgentProvider {
  return {
    id: 'cp', displayName: 'CP',
    capabilities: { structuredOutput: false, permissionHook: true, pty: false, mcpTools: false } as any,
    async detect() { return true },
    async listModels() { return [] },
    run(task, cb) {
      const done = (async () => {
        cb.onState('run')
        const decision = await cb.onConfirm!({ title: '删除文件?' })
        cb.onLog({ ts: '0', text: '决定=' + decision, level: 'info' })
        cb.onState('ok'); const r = { ok: true, summary: 'ok' }; cb.onDone(r); return r
      })()
      return { id: task.agentId, cancel() {}, done }
    },
  }
}

describe('等待人工期间豁免看门狗(awaiting 状态)', () => {
  it('onConfirm 阻塞时 agent 进入 awaiting,resolve 后回 run', async () => {
    const bus = new EventBus()
    const states: string[] = []
    bus.subscribe(e => {
      if (e.type === 'agent:state') states.push(e.state)
      if (e.type === 'pending:add') setTimeout(() => orch.resolve({ id: e.action.id, decision: 'allow' }), 0)
    })
    const orch = new Orchestrator({ bus, providers: { cp: confirmProvider() }, proxy: () => '' })
    const run = await orch.startRun({
      runId: 'r-aw', workspaceName: 'ws', workspacePath: ws,
      stages: [{ key: 'develop', name: '代码开发', provider: 'cp', model: 'm' }],
      developProjects: [],
    })
    expect(run.status).toBe('ok')
    expect(states).toContain('awaiting')
    // awaiting 之后必然回到 run(setAgentAwaiting(false))
    expect(states.indexOf('awaiting')).toBeLessThan(states.lastIndexOf('run'))
  })
})

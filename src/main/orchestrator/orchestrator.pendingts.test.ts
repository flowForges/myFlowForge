import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Orchestrator } from './orchestrator'
import { EventBus } from './eventBus'
import type { AgentProvider } from '../agents/types'
import type { PendingAction } from '@shared/types'

let ws: string
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'ws-pts-')) })
afterEach(() => rmSync(ws, { recursive: true, force: true }))

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

describe('raise 给 PendingAction 打 ts', () => {
  it('设计门控弹出的 pending 带 ISO ts', async () => {
    const bus = new EventBus()
    let captured: any = null
    bus.subscribe(e => {
      if (e.type === 'pending:add') { captured = e.action; setTimeout(() => orch.resolve({ id: e.action.id, decision: 'allow' }), 0) }
    })
    const orch = new Orchestrator({ bus, providers: { okp: okProvider() }, proxy: () => '' })
    await orch.startRun({
      runId: 'r-pts', workspaceName: 'ws', workspacePath: ws,
      stages: [
        { key: 'design', name: '技术方案', provider: 'okp', model: 'm' },
        { key: 'develop', name: '代码开发', provider: 'okp', model: 'm' },
      ],
      developProjects: [],
    })
    expect(captured).not.toBeNull()
    expect(typeof (captured as PendingAction).ts).toBe('string')
    expect((captured as any).ts).toMatch(/^\d{4}-\d\d-\d\dT/)
  })
})

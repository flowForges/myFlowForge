import { describe, it, expect } from 'vitest'
import { EventBus } from './eventBus'
import { Orchestrator } from './orchestrator'

describe('RunState carries workspacePath', () => {
  it('startRun returns a RunState whose workspacePath equals opts.workspacePath', async () => {
    const orch = new Orchestrator({ bus: new EventBus(), providers: {}, proxy: () => '' })
    const run = await orch.startRun({
      runId: 'r1', workspaceName: 'ws', workspacePath: '/tmp/ws-xyz',
      stages: [], developProjects: []
    })
    expect(run.workspacePath).toBe('/tmp/ws-xyz')
  })
})

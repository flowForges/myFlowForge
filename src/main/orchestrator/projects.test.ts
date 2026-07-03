import { describe, it, expect } from 'vitest'
import { EventBus } from './eventBus'
import { Orchestrator } from './orchestrator'

describe('RunState carries projects', () => {
  it('startRun populates run.projects from developProjects', async () => {
    const orch = new Orchestrator({ bus: new EventBus(), providers: {}, proxy: () => '' })
    const run = await orch.startRun({
      runId: 'r1', workspaceName: 'ws', workspacePath: '/tmp/ws',
      stages: [], developProjects: [{ name: 'web', cwd: '/tmp/ws/web' }, { name: 'api', cwd: '/tmp/ws/api' }]
    })
    expect(run.projects).toEqual([{ name: 'web', cwd: '/tmp/ws/web' }, { name: 'api', cwd: '/tmp/ws/api' }])
  })
})

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeWorkspace, readWorkspace, setStageModel } from './store'

// Multi-workflow: stages live in ws.workflows[].stages now; ws.stages ([] here) is the legacy
// migration seed and is left empty on purpose, exactly like production readWorkspace returns for any
// workspace created/edited under the multi-workflow model — setStageModel must not depend on it.
function makeWs(dir: string, workflows: Array<{ id: string; name: string; stages: Array<{ key: string; provider: string; model: string }> }>) {
  writeWorkspace({
    name: 'w', path: dir, workflowId: workflows[0]?.id ?? 'wf', status: 'idle', plugins: [], stepPlugins: [],
    stages: [],
    workflows,
    projects: [],
  })
}

describe('setStageModel', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'forge-ssm-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('updates the matching develop stage in every workflow that has one, persists into workflows[].stages', () => {
    makeWs(dir, [
      { id: 'wf1', name: 'wf1', stages: [{ key: 'design', provider: 'claude', model: 'opus' }, { key: 'develop', provider: 'claude', model: 'sonnet' }] },
      { id: 'wf2', name: 'wf2', stages: [{ key: 'develop', provider: 'claude', model: 'sonnet' }] },
    ])
    setStageModel(dir, 'develop', 'codex', 'gpt-5-codex')
    const ws = readWorkspace(dir)!
    const wf1Develop = ws.workflows.find(w => w.id === 'wf1')!.stages.find(s => s.key === 'develop')!
    const wf2Develop = ws.workflows.find(w => w.id === 'wf2')!.stages.find(s => s.key === 'develop')!
    expect(wf1Develop.provider).toBe('codex')
    expect(wf1Develop.model).toBe('gpt-5-codex')
    expect(wf2Develop.provider).toBe('codex')
    expect(wf2Develop.model).toBe('gpt-5-codex')
    // other stages untouched
    expect(ws.workflows.find(w => w.id === 'wf1')!.stages.find(s => s.key === 'design')!.provider).toBe('claude')
  })

  it('is a no-op when no workflow has the stage key (legacy empty ws.stages is never consulted)', () => {
    makeWs(dir, [{ id: 'wf1', name: 'wf1', stages: [{ key: 'develop', provider: 'claude', model: 'sonnet' }] }])
    setStageModel(dir, 'nope', 'codex', 'x')
    expect(readWorkspace(dir)!.workflows.find(w => w.id === 'wf1')!.stages.find(s => s.key === 'develop')!.provider).toBe('claude')
  })
})

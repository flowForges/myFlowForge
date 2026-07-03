import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeWorkspace, readWorkspace, setStageModel } from './store'

function makeWs(dir: string) {
  writeWorkspace({
    name: 'w', path: dir, workflowId: 'wf', status: 'idle', plugins: [], stepPlugins: [],
    stages: [
      { key: 'design', provider: 'claude', model: 'opus' },
      { key: 'develop', provider: 'claude', model: 'sonnet' },
    ],
    projects: [],
  })
}

describe('setStageModel', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'forge-ssm-')); makeWs(dir) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('updates the matching stage provider+model and persists', () => {
    setStageModel(dir, 'develop', 'codex', 'gpt-5-codex')
    const ws = readWorkspace(dir)!
    const develop = ws.stages.find(s => s.key === 'develop')!
    expect(develop.provider).toBe('codex')
    expect(develop.model).toBe('gpt-5-codex')
    // other stages untouched
    expect(ws.stages.find(s => s.key === 'design')!.provider).toBe('claude')
  })

  it('is a no-op when stage key not found', () => {
    setStageModel(dir, 'nope', 'codex', 'x')
    expect(readWorkspace(dir)!.stages.find(s => s.key === 'develop')!.provider).toBe('claude')
  })
})

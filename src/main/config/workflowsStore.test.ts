import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let tmp: string
vi.mock('./paths', async (orig) => {
  const actual = await orig<typeof import('./paths')>()
  return { ...actual, sysFile: (n: string) => join((globalThis as any).__SYS__, n) }
})
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'wf-')); (globalThis as any).__SYS__ = tmp })
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe('workflows store', () => {
  it('writes and reads back the workflows list', async () => {
    const { writeWorkflows, readWorkflows } = await import('./store')
    writeWorkflows({ workflows: [{ id: 'w1', name: 'W1', stages: [{ key: 'develop', defaultAgent: 'claude', defaultModel: 'opus-4.8' }], plugins: [], stagePrompts: {} }] })
    expect(readWorkflows().workflows).toHaveLength(1)
    expect(readWorkflows().workflows[0].id).toBe('w1')
  })
})

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let tmp: string
vi.mock('./paths', async (orig) => {
  const actual = await orig<typeof import('./paths')>()
  return { ...actual, sysFile: (n: string) => join((globalThis as any).__SYS__, n) }
})
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'cs-')); (globalThis as any).__SYS__ = tmp })
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe('custom-stage library store', () => {
  it('defaults to an empty library when the file is absent', async () => {
    const { readCustomStages } = await import('./store')
    expect(readCustomStages().stages).toEqual([])
  })

  it('upsert adds a def (generating an id when absent) and reads it back', async () => {
    const { upsertCustomStage, readCustomStages } = await import('./store')
    const list = upsertCustomStage({ name: '安全审计', defaultAgent: 'codex', defaultModel: 'gpt-5-codex', prompt: 'x', gate: true })
    expect(list).toHaveLength(1)
    expect(list[0].id).toBeTruthy()
    expect(list[0]).toMatchObject({ name: '安全审计', defaultAgent: 'codex', defaultModel: 'gpt-5-codex', prompt: 'x', gate: true })
    expect(readCustomStages().stages).toHaveLength(1)
  })

  it('upsert with an existing id REPLACES that def (edit-once semantics)', async () => {
    const { upsertCustomStage } = await import('./store')
    upsertCustomStage({ id: 'fixed', name: '原名', defaultAgent: 'claude', defaultModel: '' })
    const list = upsertCustomStage({ id: 'fixed', name: '改名', defaultAgent: 'claude', defaultModel: 'opus-4.8' })
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: 'fixed', name: '改名', defaultModel: 'opus-4.8' })
  })

  it('delete removes a def by id', async () => {
    const { upsertCustomStage, deleteCustomStage } = await import('./store')
    upsertCustomStage({ id: 'a', name: 'A', defaultAgent: 'claude', defaultModel: '' })
    upsertCustomStage({ id: 'b', name: 'B', defaultAgent: 'claude', defaultModel: '' })
    const after = deleteCustomStage('a')
    expect(after.map(s => s.id)).toEqual(['b'])
  })

  it('fills key = id when no key given', async () => {
    const { upsertCustomStage } = await import('./store')
    const [def] = upsertCustomStage({ id: 'k1', name: 'N', defaultAgent: 'claude', defaultModel: '' })
    expect(def.key).toBe('k1')
  })
})

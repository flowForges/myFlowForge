import { describe, it, expect, vi } from 'vitest'
import { runPlugin, type ExecRun } from './pluginHost'
import { EXTENSION_POINTS } from './extensionPoints'
import type { InstalledPlugin } from './pluginSchema'

const basePlugin: InstalledPlugin = {
  id: 'test-plugin',
  dir: '/fake/plugin',
  type: 'statusbar-usage',
  name: 'Test Plugin',
  entry: 'index.js',
  refreshSec: 300,
  enabled: true,
}

const validPayload = JSON.stringify({ window5h: { used: 10, limit: 100 } })

function makeExec(stdout: string, failed = false): ExecRun {
  return async () => ({ stdout, failed })
}

function throwingExec(): ExecRun {
  return async () => { throw new Error('exec exploded') }
}

describe('EXTENSION_POINTS statusbar-usage validate', () => {
  const ep = EXTENSION_POINTS['statusbar-usage']

  it('window5h only → ok', () => {
    const r = ep.validate({ window5h: { used: 5, limit: 50 } })
    expect(r.ok).toBe(true)
  })

  it('weekly only → ok', () => {
    const r = ep.validate({ weekly: { used: 100, limit: 1000 } })
    expect(r.ok).toBe(true)
  })

  it('neither window5h nor weekly → error', () => {
    const r = ep.validate({ label: 'only label' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBeTruthy()
  })

  it('both fields → ok', () => {
    const r = ep.validate({ window5h: { used: 1, limit: 10 }, weekly: { used: 5, limit: 50 } })
    expect(r.ok).toBe(true)
  })
})

describe('runPlugin', () => {
  it('valid statusbar-usage JSON → ok+type+data', async () => {
    const result = await runPlugin(basePlugin, { exec: makeExec(validPayload) })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.type).toBe('statusbar-usage')
      expect(result.data).toMatchObject({ window5h: { used: 10, limit: 100 } })
    }
  })

  it('non-JSON stdout → error', async () => {
    const result = await runPlugin(basePlugin, { exec: makeExec('not json at all') })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('JSON')
  })

  it('empty stdout → error', async () => {
    const result = await runPlugin(basePlugin, { exec: makeExec('') })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('无输出')
  })

  it('whitespace-only stdout → error', async () => {
    const result = await runPlugin(basePlugin, { exec: makeExec('   \n  ') })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('无输出')
  })

  it('failed:true → error', async () => {
    const result = await runPlugin(basePlugin, { exec: makeExec(validPayload, true) })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('失败')
  })

  it('schema mismatch (no window field) → error', async () => {
    const bad = JSON.stringify({ label: 'no window' })
    const result = await runPlugin(basePlugin, { exec: makeExec(bad) })
    expect(result.ok).toBe(false)
  })

  it('unknown type → error with 不支持的类型', async () => {
    const plugin: InstalledPlugin = { ...basePlugin, type: 'unknown-type' }
    const result = await runPlugin(plugin, { exec: makeExec(validPayload) })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('不支持的类型')
  })

  it('exec throws → error (caught, never throws)', async () => {
    const result = await runPlugin(basePlugin, { exec: throwingExec() })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('exec exploded')
  })

  it('valid payload with resetAt → ok', async () => {
    const payload = JSON.stringify({ window5h: { used: 5, limit: 50, resetAt: 1234567890 } })
    const result = await runPlugin(basePlugin, { exec: makeExec(payload) })
    expect(result.ok).toBe(true)
  })

  it('entry path traversal (../../bin/sh) → error, exec never called', async () => {
    const execSpy = vi.fn(async () => ({ stdout: '', failed: false }))
    const traversalPlugin: InstalledPlugin = { ...basePlugin, entry: '../../bin/sh' }
    const result = await runPlugin(traversalPlugin, { exec: execSpy })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('越界')
    expect(execSpy).not.toHaveBeenCalled()
  })
})

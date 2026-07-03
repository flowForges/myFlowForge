import { describe, it, expect, vi } from 'vitest'
import { makeRun } from './usageService'
import type { InstalledPlugin } from '../plugins/pluginSchema'

const native: InstalledPlugin = { id: 'forge-official-codex-usage', dir: '', type: 'statusbar-usage', provider: 'codex', name: 'Codex', entry: 'native', refreshSec: 300, enabled: true, native: true }
const thirdParty: InstalledPlugin = { ...native, id: 'x', native: false, entry: 'run.js', dir: '/p' }

describe('makeRun', () => {
  it('routes native plugins to usage runner', async () => {
    const usage = vi.fn(async () => ({ ok: true as const, type: 'statusbar-usage', data: {} }))
    const host = vi.fn(async () => ({ ok: false as const, error: 'should-not-call' }))
    const run = makeRun({ runUsage: usage, runHost: host })
    await run(native)
    expect(usage).toHaveBeenCalledOnce()
    expect(host).not.toHaveBeenCalled()
  })
  it('routes third-party plugins to host runner', async () => {
    const usage = vi.fn(async () => ({ ok: true as const, type: 'statusbar-usage', data: {} }))
    const host = vi.fn(async () => ({ ok: true as const, type: 'statusbar-usage', data: {} }))
    const run = makeRun({ runUsage: usage, runHost: host })
    await run(thirdParty)
    expect(host).toHaveBeenCalledOnce()
    expect(usage).not.toHaveBeenCalled()
  })
})

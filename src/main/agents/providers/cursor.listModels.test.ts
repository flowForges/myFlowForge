// cursor.listModels.test.ts — listModelsLive + capabilities.liveModels tests
// ⚠️ Real cursor-agent --list-models output format is UNKNOWN (not logged in).
//    All fixtures are synthetic; parseModelsList is tolerant by design.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeCursorProvider } from './cursor'

let dir: string

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cursor-lm-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** Create a fake bin that prints `stdout` and exits with `code`. */
function fakeBin(stdout: string, code = 0): string {
  const p = join(dir, 'fakebin.js')
  writeFileSync(p, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(stdout)})\nprocess.exit(${code})\n`)
  chmodSync(p, 0o755)
  return p
}

describe('cursor capabilities', () => {
  it('advertises liveModels: true', () => {
    const provider = makeCursorProvider({ defaultModels: [] })
    expect(provider.capabilities.liveModels).toBe(true)
  })
})

describe('cursor listModelsLive()', () => {
  it('returns parsed models from JSON array stdout', async () => {
    const stdout = JSON.stringify([{ id: 'claude-4', name: 'Claude 4' }, { id: 'gpt-4o' }])
    const bin = fakeBin(stdout, 0)
    const provider = makeCursorProvider({ bin, defaultModels: [] })
    const models = await provider.listModelsLive!(process.env)
    expect(models).toHaveLength(2)
    expect(models[0]).toMatchObject({ id: 'claude-4', label: 'Claude 4' })
    expect(models[1]).toMatchObject({ id: 'gpt-4o', label: 'gpt-4o' })
  })

  it('returns parsed models from JSON {models:[...]} stdout', async () => {
    const stdout = JSON.stringify({ models: [{ id: 'm1', label: 'Model 1' }] })
    const bin = fakeBin(stdout, 0)
    const provider = makeCursorProvider({ bin, defaultModels: [] })
    const models = await provider.listModelsLive!(process.env)
    expect(models).toHaveLength(1)
    expect(models[0]).toMatchObject({ id: 'm1', label: 'Model 1' })
  })

  it('returns [] when stdout is an auth error', async () => {
    const stdout = 'Authentication required. Please login first.'
    const bin = fakeBin(stdout, 1)
    const provider = makeCursorProvider({ bin, defaultModels: [] })
    const models = await provider.listModelsLive!(process.env)
    expect(models).toEqual([])
  })

  it('returns [] when execa rejects (bin not found)', async () => {
    const provider = makeCursorProvider({ bin: '/nonexistent/cursor-agent', defaultModels: [] })
    const models = await provider.listModelsLive!(process.env)
    expect(models).toEqual([])
  })

  it('returns [] when stdout is empty', async () => {
    const bin = fakeBin('', 0)
    const provider = makeCursorProvider({ bin, defaultModels: [] })
    const models = await provider.listModelsLive!(process.env)
    expect(models).toEqual([])
  })
})

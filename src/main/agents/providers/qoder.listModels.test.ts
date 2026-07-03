// qoder.listModels.test.ts — listModelsLive + capabilities.liveModels tests
// ⚠️ Real qodercli --list-models output format is UNKNOWN (not logged in).
//    All fixtures are synthetic; parseModelsList is tolerant by design.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeQoderProvider } from './qoder'

let dir: string

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'qoder-lm-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** Create a fake bin that prints `stdout` and exits with `code`. */
function fakeBin(stdout: string, code = 0): string {
  const p = join(dir, 'fakebin.js')
  writeFileSync(p, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(stdout)})\nprocess.exit(${code})\n`)
  chmodSync(p, 0o755)
  return p
}

describe('qoder capabilities', () => {
  it('advertises liveModels: true', () => {
    const provider = makeQoderProvider({ defaultModels: [] })
    expect(provider.capabilities.liveModels).toBe(true)
  })
})

describe('qoder listModelsLive()', () => {
  it('returns parsed models from JSON array stdout', async () => {
    const stdout = JSON.stringify([{ id: 'gpt-4o', label: 'GPT-4o' }, { id: 'o3', name: 'O3' }])
    const bin = fakeBin(stdout, 0)
    const provider = makeQoderProvider({ bin: `node`, preArgs: [bin], defaultModels: [] })
    // listModelsLive calls execa(bin, ['--list-models']); with preArgs it should use them
    // For this unit test we supply a custom bin directly to exercise the execa path:
    const provider2 = makeQoderProvider({ bin, defaultModels: [] })
    const models = await provider2.listModelsLive!(process.env)
    expect(models).toHaveLength(2)
    expect(models[0]).toMatchObject({ id: 'gpt-4o', label: 'GPT-4o' })
    expect(models[1]).toMatchObject({ id: 'o3', label: 'O3' })
  })

  it('returns parsed models from plain-text stdout', async () => {
    const stdout = 'model-a\nmodel-b  Fast model\n'
    const bin = fakeBin(stdout, 0)
    const provider = makeQoderProvider({ bin, defaultModels: [] })
    const models = await provider.listModelsLive!(process.env)
    expect(models).toHaveLength(2)
    expect(models[0]).toMatchObject({ id: 'model-a', label: 'model-a' })
    expect(models[1]).toMatchObject({ id: 'model-b', label: 'Fast model' })
  })

  it('returns [] when stdout is an auth/login error message', async () => {
    const stdout = 'Not logged in. Please run: qodercli login'
    const bin = fakeBin(stdout, 1)
    const provider = makeQoderProvider({ bin, defaultModels: [] })
    const models = await provider.listModelsLive!(process.env)
    expect(models).toEqual([])
  })

  it('returns [] when execa rejects (bin not found)', async () => {
    const provider = makeQoderProvider({ bin: '/nonexistent/does-not-exist', defaultModels: [] })
    const models = await provider.listModelsLive!(process.env)
    expect(models).toEqual([])
  })

  it('returns [] when stdout is empty', async () => {
    const bin = fakeBin('', 0)
    const provider = makeQoderProvider({ bin, defaultModels: [] })
    const models = await provider.listModelsLive!(process.env)
    expect(models).toEqual([])
  })
})

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// C-1: `computerUse.provisioned` is monotonic within an app run. Once seen true, neither a rewritten / corrupted
// client.json nor a stale renderer patch can turn V3's disclaim back off.
let tmp: string
vi.mock('./paths', async (orig) => {
  const actual = await orig<typeof import('./paths')>()
  return { ...actual, SYS_DIR: '__REPLACED__', sysFile: (n: string) => join((globalThis as any).__SYS__, n) }
})

const store = await import('./store')
const { readSettings, writeSettings, resetProvisionedLatchForTest } = store
const clientOnDisk = () => JSON.parse(readFileSync(join(tmp, 'client.json'), 'utf8'))

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'forge-prov-'))
  ;(globalThis as any).__SYS__ = tmp
  resetProvisionedLatchForTest()
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

function provision() {
  const s = readSettings()
  writeSettings({ ...s, computerUse: { ...s.computerUse, provisioned: true } })
  expect(readSettings().computerUse.provisioned).toBe(true)
}

describe('provisioned is monotonic (C-1)', () => {
  it('starts false and is not latched by a false read', () => {
    expect(readSettings().computerUse.provisioned).toBe(false)
    writeSettings(readSettings())
    expect(clientOnDisk().computerUse.provisioned).toBe(false)
  })

  it('a client.json rewritten to provisioned:false is still read as true, and the next write restores it', () => {
    provision()
    const raw = clientOnDisk()
    writeFileSync(join(tmp, 'client.json'), JSON.stringify({ ...raw, computerUse: { ...raw.computerUse, provisioned: false } }))
    expect(readSettings().computerUse.provisioned).toBe(true)
    writeSettings(readSettings())
    expect(clientOnDisk().computerUse.provisioned).toBe(true)
  })

  it('a corrupted client.json (bad JSON, wrong type, missing key) is still read as true', () => {
    provision()
    for (const bad of ['{ not json', JSON.stringify({ computerUse: { provisioned: 'no' } }), JSON.stringify({ computerUse: 7 }), '{}']) {
      writeFileSync(join(tmp, 'client.json'), bad)
      expect(readSettings().computerUse.provisioned).toBe(true)
    }
    writeSettings(readSettings())
    expect(clientOnDisk().computerUse.provisioned).toBe(true)
  })

  it('a stale renderer patch (computerUse without provisioned, or with false) cannot clear it', () => {
    provision()
    // what configSetSettings does: { ...readSettings(), ...pickClientPatch(patch) }
    const prev = readSettings()
    writeSettings({ ...prev, computerUse: { extraBlocked: ['com.x'] } as never })
    expect(clientOnDisk().computerUse).toMatchObject({ provisioned: true, extraBlocked: ['com.x'] })
    writeSettings({ ...readSettings(), computerUse: { ...prev.computerUse, provisioned: false } })
    expect(clientOnDisk().computerUse.provisioned).toBe(true)
    expect(readSettings().computerUse.provisioned).toBe(true)
  })

  it('the writer ORs with the stored value even before anything was read this run', () => {
    writeFileSync(join(tmp, 'client.json'), JSON.stringify({ computerUse: { provisioned: true } }))
    writeFileSync(join(tmp, 'settings.json'), JSON.stringify({}))
    resetProvisionedLatchForTest()
    const d = readSettings()
    resetProvisionedLatchForTest()   // simulate a writer that never read first
    writeSettings({ ...d, computerUse: { ...d.computerUse, provisioned: false } })
    expect(clientOnDisk().computerUse.provisioned).toBe(true)
  })
})

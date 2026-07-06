import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findAppPath, scanOpeners, resolveOpener, withoutOpener } from './detect'
import type { OpenerSpec } from './catalog'

let tmp: string
vi.mock('../config/paths', async (orig) => {
  const actual = await orig<typeof import('../config/paths')>()
  return { ...actual, sysFile: (n: string) => join((globalThis as any).__OPENERS_SYS__, n) }
})

const spec = (bundleIds: string[]): OpenerSpec => ({ id: 'x', name: 'X', bundleIds, openMode: 'together' })

describe('detectOpeners cache versioning', () => {
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'openers-')); (globalThis as any).__OPENERS_SYS__ = tmp })
  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  it('re-scans a pre-icon cache (no version) so icons self-heal', async () => {
    const { detectOpeners, openersCacheFile } = await import('./detect')
    // simulate an old cache written before icons existed: apps present, no version, no icons
    writeFileSync(openersCacheFile(), JSON.stringify({ apps: [{ id: 'vscode', name: 'VS Code', openMode: 'together', appPath: '/x', icon: undefined }] }))
    const icon = vi.fn(async () => 'data:image/png;base64,AAAA')
    await detectOpeners(icon, false)
    expect(icon).toHaveBeenCalled()   // rescanned → icon extractor ran
  })

  it('trusts a version-tagged cache without re-scanning', async () => {
    const { detectOpeners, openersCacheFile, OPENERS_CACHE_VERSION } = await import('./detect')
    writeFileSync(openersCacheFile(), JSON.stringify({ v: OPENERS_CACHE_VERSION, apps: [{ id: 'vscode', name: 'VS Code', openMode: 'together', appPath: '/x', icon: 'data:image/png;base64,BBBB' }] }))
    const icon = vi.fn(async () => 'data:image/png;base64,AAAA')
    const list = await detectOpeners(icon, false)
    expect(icon).not.toHaveBeenCalled()          // trusted cache → no rescan
    expect(list[0].icon).toBe('data:image/png;base64,BBBB')
  })
})

describe('findAppPath', () => {
  it('first installed bundle id wins', async () => {
    const find = async (id: string) => (id === 'com.b' ? process.cwd() : null)
    expect(await findAppPath(spec(['com.a', 'com.b']), find)).toBe(process.cwd())
  })
  it('none installed → null', async () => {
    expect(await findAppPath(spec(['com.a', 'com.b']), async () => null)).toBeNull()
  })
  it('mdfind hit but path no longer exists (stale) → skip', async () => {
    expect(await findAppPath(spec(['com.a']), async () => '/no/such/App.app')).toBeNull()
  })
})

describe('scanOpeners', () => {
  it('returns only detected openers, carrying openMode + icon', async () => {
    // Only VS Code "installed" — its catalog bundle id resolves; all others miss.
    const find = async (id: string) => (id === 'com.microsoft.VSCode' ? process.cwd() : null)
    const icon = async (p: string) => `data:icon:${p}`
    const list = await scanOpeners(icon, find)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      id: 'vscode', name: 'VS Code', openMode: 'together', appPath: process.cwd(), icon: `data:icon:${process.cwd()}`,
    })
  })
})

describe('resolveOpener', () => {
  it('finds a detected opener by id', () => {
    const apps = [{ id: 'vscode', name: 'VS Code', openMode: 'together' as const, appPath: '/a' }]
    expect(resolveOpener('vscode', apps)?.appPath).toBe('/a')
    expect(resolveOpener('nope', apps)).toBeUndefined()
  })
})

describe('withoutOpener', () => {
  it('drops the given id, keeps the rest (order preserved)', () => {
    const apps = [
      { id: 'vscode', name: 'VS Code', openMode: 'together' as const, appPath: '/a' },
      { id: 'finder', name: 'Finder', openMode: 'folder-only' as const, appPath: '/b' },
    ]
    expect(withoutOpener(apps, 'vscode')).toEqual([apps[1]])
    expect(withoutOpener(apps, 'nope')).toEqual(apps)
  })
})

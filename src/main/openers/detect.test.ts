import { describe, it, expect } from 'vitest'
import { findAppPath, scanOpeners, resolveOpener, withoutOpener } from './detect'
import type { OpenerSpec } from './catalog'

const spec = (bundleIds: string[]): OpenerSpec => ({ id: 'x', name: 'X', bundleIds, openMode: 'together' })

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

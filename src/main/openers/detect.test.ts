import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findMacAppPath, findWinAppPath, scanOpeners, resolveOpener, withoutOpener } from './detect'
import { OPENER_CATALOG, type OpenerSpec } from './catalog'
import type { WinFsProbe } from './winPaths'

let tmp: string
vi.mock('../config/paths', async (orig) => {
  const actual = await orig<typeof import('../config/paths')>()
  return { ...actual, sysFile: (n: string) => join((globalThis as any).__OPENERS_SYS__, n) }
})

const macSpec = (bundleIds: string[]): OpenerSpec => ({ id: 'x', name: 'X', openMode: 'together', mac: { bundleIds } })
const noFs: WinFsProbe = { exists: () => false, readdir: () => [] }
const noReg = async () => ''

describe('OPENER_CATALOG invariants', () => {
  it('every entry is reachable on at least one platform', () => {
    for (const s of OPENER_CATALOG) expect(s.mac ?? s.win, s.id).toBeDefined()
  })
  it('ids are unique (they are the persisted user preference key)', () => {
    const ids = OPENER_CATALOG.map(s => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
  it('every Windows entry carries at least one path template', () => {
    for (const s of OPENER_CATALOG) if (s.win) expect(s.win.paths.length, s.id).toBeGreaterThan(0)
  })
  it('Windows path templates are absolute — they all start with an environment variable', () => {
    for (const s of OPENER_CATALOG) for (const p of s.win?.paths ?? []) expect(p, `${s.id}: ${p}`).toMatch(/^%[^%]+%\\/)
  })
  it('the registry fallback key, when given, is an executable name', () => {
    for (const s of OPENER_CATALOG) if (s.win?.exe) expect(s.win.exe.toLowerCase(), s.id).toMatch(/\.exe$/)
  })
  it('ships both a macOS and a Windows way to open a plain folder', () => {
    expect(OPENER_CATALOG.some(s => s.mac && s.openMode === 'folder-only')).toBe(true)
    expect(OPENER_CATALOG.some(s => s.win && s.openMode === 'folder-only')).toBe(true)
  })
})

describe('findMacAppPath', () => {
  it('first installed bundle id wins', async () => {
    const find = async (id: string) => (id === 'com.b' ? process.cwd() : null)
    expect(await findMacAppPath(macSpec(['com.a', 'com.b']), find)).toBe(process.cwd())
  })
  it('none installed → null', async () => {
    expect(await findMacAppPath(macSpec(['com.a', 'com.b']), async () => null)).toBeNull()
  })
  it('mdfind hit but path no longer exists (stale) → skip', async () => {
    expect(await findMacAppPath(macSpec(['com.a']), async () => '/no/such/App.app')).toBeNull()
  })
  it('a Windows-only spec has nothing to look up on macOS', async () => {
    const winOnly: OpenerSpec = { id: 'explorer', name: 'File Explorer', openMode: 'folder-only', win: { paths: ['%SystemRoot%\\explorer.exe'] } }
    expect(await findMacAppPath(winOnly, async () => process.cwd())).toBeNull()
  })
})

describe('findWinAppPath', () => {
  const spec: OpenerSpec = {
    id: 'vscode', name: 'VS Code', openMode: 'together',
    win: { paths: ['%LOCALAPPDATA%\\Programs\\Microsoft VS Code\\Code.exe'], exe: 'Code.exe' },
  }
  const env = { LOCALAPPDATA: 'C:\\U\\me\\AppData\\Local' }
  const HIT = 'C:\\U\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe'

  it('a known install path wins without ever touching the registry', async () => {
    const reg = vi.fn(noReg)
    const fs: WinFsProbe = { exists: p => p === HIT, readdir: () => [] }
    expect(await findWinAppPath(spec, { env, fs, reg })).toBe(HIT)
    expect(reg).not.toHaveBeenCalled()
  })

  it('falls back to the registry when the app was installed somewhere we do not guess', async () => {
    const CUSTOM = 'D:\\Tools\\VSCode\\Code.exe'
    const reg = async () => `    (Default)    REG_SZ    ${CUSTOM}`
    const fs: WinFsProbe = { exists: p => p === CUSTOM, readdir: () => [] }
    expect(await findWinAppPath(spec, { env, fs, reg })).toBe(CUSTOM)
  })

  it('no path and no registry entry → null', async () => {
    expect(await findWinAppPath(spec, { env, fs: noFs, reg: noReg })).toBeNull()
  })

  it('a spec without a registry key does not attempt a lookup', async () => {
    const reg = vi.fn(noReg)
    const noExe: OpenerSpec = { ...spec, win: { paths: spec.win!.paths } }
    expect(await findWinAppPath(noExe, { env, fs: noFs, reg })).toBeNull()
    expect(reg).not.toHaveBeenCalled()
  })

  it('a macOS-only spec has nothing to look up on Windows', async () => {
    const macOnly: OpenerSpec = { id: 'finder', name: 'Finder', openMode: 'folder-only', mac: { bundleIds: ['com.apple.finder'] } }
    expect(await findWinAppPath(macOnly, { env, fs: { exists: () => true, readdir: () => [] }, reg: noReg })).toBeNull()
  })
})

describe('scanOpeners', () => {
  it('macOS: returns only detected openers, carrying openMode + icon', async () => {
    const findBundle = async (id: string) => (id === 'com.microsoft.VSCode' ? process.cwd() : null)
    const icon = async (p: string) => `data:icon:${p}`
    const list = await scanOpeners({ platform: 'darwin', icon, findBundle })
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      id: 'vscode', name: 'VS Code', openMode: 'together', appPath: process.cwd(), icon: `data:icon:${process.cwd()}`,
    })
  })

  it('macOS: never reports a Windows-only opener', async () => {
    const list = await scanOpeners({ platform: 'darwin', findBundle: async () => process.cwd() })
    expect(list.map(o => o.id)).not.toContain('explorer')
    expect(list.map(o => o.id)).toContain('finder')
  })

  it('Windows: never reports a macOS-only opener', async () => {
    const fs: WinFsProbe = { exists: () => true, readdir: () => ['1'] }
    const list = await scanOpeners({ platform: 'win32', env: WIN_ENV, fs, reg: noReg })
    const ids = list.map(o => o.id)
    expect(ids).not.toContain('finder')
    expect(ids).not.toContain('xcode')
    expect(ids).not.toContain('iterm')
    expect(ids).toContain('explorer')
  })

  it('Windows: carries the executable path and the arg style the launcher needs', async () => {
    const WT = 'C:\\U\\me\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe'
    const fs: WinFsProbe = { exists: p => p === WT, readdir: () => [] }
    const list = await scanOpeners({ platform: 'win32', env: WIN_ENV, fs, reg: noReg })
    expect(list).toEqual([{ id: 'wt', name: 'Windows Terminal', openMode: 'folder-only', appPath: WT, argStyle: 'cwd-flag', icon: undefined }])
  })
})

const WIN_ENV = {
  LOCALAPPDATA: 'C:\\U\\me\\AppData\\Local',
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  SystemRoot: 'C:\\Windows',
}

describe('detectOpeners cache versioning', () => {
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'openers-')); (globalThis as any).__OPENERS_SYS__ = tmp })
  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  it('re-scans a pre-icon cache (no version) so icons self-heal', async () => {
    const { detectOpeners, openersCacheFile } = await import('./detect')
    writeFileSync(openersCacheFile(), JSON.stringify({ apps: [{ id: 'vscode', name: 'VS Code', openMode: 'together', appPath: '/x' }] }))
    const icon = vi.fn(async () => 'data:image/png;base64,AAAA')
    await detectOpeners(icon, false, { platform: 'darwin', findBundle: async () => process.cwd() })
    expect(icon).toHaveBeenCalled()
  })

  it('trusts a version-tagged cache without re-scanning', async () => {
    const { detectOpeners, openersCacheFile, OPENERS_CACHE_VERSION } = await import('./detect')
    writeFileSync(openersCacheFile(), JSON.stringify({ v: OPENERS_CACHE_VERSION, apps: [{ id: 'vscode', name: 'VS Code', openMode: 'together', appPath: '/x', icon: 'data:image/png;base64,BBBB' }] }))
    const icon = vi.fn(async () => 'data:image/png;base64,AAAA')
    const list = await detectOpeners(icon, false, { platform: 'darwin' })
    expect(icon).not.toHaveBeenCalled()
    expect(list[0].icon).toBe('data:image/png;base64,BBBB')
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

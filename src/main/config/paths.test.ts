import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { SYS_DIR, sysDirName } from './paths'
import { buildSysDirName } from './sysDirName'

// Side-by-side test package: the app data dir name. Pure string work, no directory is touched.
describe('SYS_DIR', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })

  it('with __MFF_SYS_DIR_NAME__ unset SYS_DIR is ~/.myFlowForge', () => {
    expect(typeof (globalThis as Record<string, unknown>).__MFF_SYS_DIR_NAME__).toBe('undefined')
    expect(SYS_DIR).toBe(join(homedir(), '.myFlowForge'))
  })

  it('sysDirName accepts a dot name and falls back for anything else', () => {
    expect(sysDirName('.myFlowForge-test')).toBe('.myFlowForge-test')
    expect(sysDirName('.mff_2.b')).toBe('.mff_2.b')
    for (const bad of [undefined, null, 3, '', 'myFlowForge-test', '../x', '/abs', '.a/b', '.a\\b', '.', '..', '...', '.x\n', ' .x', '.x y', '.测试']) {
      expect(sysDirName(bad)).toBe('.myFlowForge')
    }
  })

  it('a name that case-folds to .myFlowForge is refused at runtime', () => {
    for (const bad of ['.MyFlowForge', '.myflowforge', '.MYFLOWFORGE']) expect(sysDirName(bad)).toBe('.myFlowForge')
  })

  it('buildSysDirName: unset or empty keeps the default; a valid name passes; anything else fails the build naming the variable', () => {
    expect(buildSysDirName(undefined)).toBeUndefined()
    expect(buildSysDirName('')).toBeUndefined()
    expect(buildSysDirName('.myFlowForge-test')).toBe('.myFlowForge-test')
    for (const bad of ['../x', '/abs', '..', 'noDot', '.a/b', '.测试', '.myFlowForge', '.MyFlowForge', '.myflowforge']) {
      expect(() => buildSysDirName(bad), bad).toThrow(/MFF_SYS_DIR_NAME/)
    }
  })

  it('a build-time name moves SYS_DIR and sysFile', async () => {
    vi.stubGlobal('__MFF_SYS_DIR_NAME__', '.myFlowForge-test')
    vi.resetModules()
    const p = await import('./paths')
    expect(p.SYS_DIR).toBe(join(homedir(), '.myFlowForge-test'))
    expect(p.sysFile('settings.json')).toBe(join(homedir(), '.myFlowForge-test', 'settings.json'))
  })

  it.each(['../x', '/abs', '..'])('a build-time name %s falls back to .myFlowForge', async (name) => {
    vi.stubGlobal('__MFF_SYS_DIR_NAME__', name)
    vi.resetModules()
    const p = await import('./paths')
    expect(p.SYS_DIR).toBe(join(homedir(), '.myFlowForge'))
  })

  it('electron.vite.config.ts validates MFF_SYS_DIR_NAME and defines __MFF_SYS_DIR_NAME__ for main only', () => {
    const cfg = readFileSync(join(__dirname, '..', '..', '..', 'electron.vite.config.ts'), 'utf8')
    expect(cfg).toMatch(/buildSysDirName\(process\.env\.MFF_SYS_DIR_NAME\)/)
    expect(cfg.match(/__MFF_SYS_DIR_NAME__/g)?.length).toBe(1)
    const main = cfg.slice(cfg.indexOf('main: {'), cfg.indexOf('preload: {'))
    expect(main).toContain('__MFF_SYS_DIR_NAME__')
  })
})

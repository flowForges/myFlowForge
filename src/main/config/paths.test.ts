import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { dataDir } from '@mffai/protocol'
import { MFFAI_DIR, SYS_DIR, sysDirName } from './paths'
import { buildSysDirName } from './sysDirName'

// 08 §18 / 评审修订 R12:测试包的 app 数据目录与 mff-ai 数据目录。只算字符串,不碰任何目录
describe('SYS_DIR / MFFAI_DIR (Task 15)', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules() })

  it('with __MFF_SYS_DIR_NAME__ unset SYS_DIR is ~/.myFlowForge', () => {
    expect(typeof (globalThis as Record<string, unknown>).__MFF_SYS_DIR_NAME__).toBe('undefined')
    expect(SYS_DIR).toBe(join(homedir(), '.myFlowForge'))
  })

  it('MFFAI_DIR is <SYS_DIR>/mff-ai and equals dataDir() for the default; MFFAI_DATA_DIR still wins', () => {
    vi.stubEnv('MFFAI_DATA_DIR', '')
    expect(MFFAI_DIR()).toBe(join(SYS_DIR, 'mff-ai'))
    expect(MFFAI_DIR()).toBe(dataDir())
    vi.stubEnv('MFFAI_DATA_DIR', '/tmp/mffai-paths-never-created/mff-ai')
    expect(MFFAI_DIR()).toBe('/tmp/mffai-paths-never-created/mff-ai')
  })

  it('sysDirName accepts a dot name and falls back for anything else', () => {
    expect(sysDirName('.myFlowForge-test')).toBe('.myFlowForge-test')
    expect(sysDirName('.mff_2.b')).toBe('.mff_2.b')
    for (const bad of [undefined, null, 3, '', 'myFlowForge-test', '../x', '/abs', '.a/b', '.a\\b', '.', '..', '...', '.x\n', ' .x', '.x y', '.测试']) {
      expect(sysDirName(bad)).toBe('.myFlowForge')
    }
  })

  it('a name that case-folds to .myFlowForge is refused at runtime (it would be the real app dir on a case-insensitive disk)', () => {
    for (const bad of ['.MyFlowForge', '.myflowforge', '.MYFLOWFORGE']) expect(sysDirName(bad)).toBe('.myFlowForge')
  })

  it('buildSysDirName: unset or empty keeps the default; a valid name passes; anything else fails the build with the variable named', () => {
    expect(buildSysDirName(undefined)).toBeUndefined()
    expect(buildSysDirName('')).toBeUndefined()
    expect(buildSysDirName('.myFlowForge-test')).toBe('.myFlowForge-test')
    for (const bad of ['../x', '/abs', '..', 'noDot', '.a/b', '.测试', '.myFlowForge', '.MyFlowForge', '.myflowforge']) {
      expect(() => buildSysDirName(bad), bad).toThrow(/MFF_SYS_DIR_NAME/)
    }
  })

  it('electron.vite.config.ts validates MFF_SYS_DIR_NAME through buildSysDirName', () => {
    const cfg = readFileSync(join(__dirname, '..', '..', '..', 'electron.vite.config.ts'), 'utf8')
    expect(cfg).toMatch(/buildSysDirName\(process\.env\.MFF_SYS_DIR_NAME\)/)
  })

  it('a build-time name moves SYS_DIR and MFFAI_DIR together', async () => {
    vi.stubGlobal('__MFF_SYS_DIR_NAME__', '.myFlowForge-test')
    vi.stubEnv('MFFAI_DATA_DIR', '')
    vi.resetModules()
    const p = await import('./paths')
    expect(p.SYS_DIR).toBe(join(homedir(), '.myFlowForge-test'))
    expect(p.MFFAI_DIR()).toBe(join(homedir(), '.myFlowForge-test', 'mff-ai'))
    expect(p.sysFile('settings.json')).toBe(join(homedir(), '.myFlowForge-test', 'settings.json'))
  })

  it.each(['../x', '/abs', '..'])('a build-time name %s falls back to .myFlowForge', async (name) => {
    vi.stubGlobal('__MFF_SYS_DIR_NAME__', name)
    vi.resetModules()
    const p = await import('./paths')
    expect(p.SYS_DIR).toBe(join(homedir(), '.myFlowForge'))
  })

  it('index.ts hands MFFAI_DIR() to the host and to registerMffaiIpc', () => {
    const src = readFileSync(join(__dirname, '..', 'index.ts'), 'utf8')
    const init = src.slice(src.indexOf('h.init({'), src.indexOf('mffaiHost = h'))
    expect(init).toContain('dataDir: MFFAI_DIR()')
    const reg = src.slice(src.indexOf('registerMffaiIpc({'), src.indexOf('if (mffaiInitial.enabled)'))
    expect(reg).toContain('dataDir: MFFAI_DIR()')
  })

  it('electron.vite.config.ts defines __MFF_SYS_DIR_NAME__ for main only, from MFF_SYS_DIR_NAME', () => {
    const cfg = readFileSync(join(__dirname, '..', '..', '..', 'electron.vite.config.ts'), 'utf8')
    expect(cfg.match(/__MFF_SYS_DIR_NAME__/g)?.length).toBe(1)
    const main = cfg.slice(cfg.indexOf('main: {'), cfg.indexOf('preload: {'))
    expect(main).toContain('__MFF_SYS_DIR_NAME__')
    expect(main).toContain('process.env.MFF_SYS_DIR_NAME')
  })
})

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from '../protocol/index'
import { acpDataDir } from './acpDataDir'

// mffaiAcp.js 没有 MFFAI_DATA_DIR 时的回退:跟 app 一样跟着构建期的目录名走(测试包 → ~/.myFlowForge-test/mff-ai)
describe('acpDataDir', () => {
  const home = '/h'
  it('MFFAI_DATA_DIR wins', () => {
    expect(acpDataDir({ MFFAI_DATA_DIR: '/x/mff-ai' }, '.myFlowForge-test', home)).toBe('/x/mff-ai')
  })
  it('no build-time name → the release dataDir()', () => {
    expect(acpDataDir({}, undefined, home)).toBe(dataDir(home))
    expect(acpDataDir({ MFFAI_DATA_DIR: '' }, undefined, home)).toBe(join(home, '.myFlowForge', 'mff-ai'))
  })
  it('a build-time name moves it to <home>/<name>/mff-ai', () => {
    expect(acpDataDir({}, '.myFlowForge-test', home)).toBe(join(home, '.myFlowForge-test', 'mff-ai'))
  })
  it('a name that is not a plain dot name falls back to the release dir', () => {
    for (const bad of ['../x', '/abs', '..', 'noDot', '.a/b', '', '.myflowforge']) expect(acpDataDir({}, bad, home), bad).toBe(dataDir(home))
  })
  it('acp.ts reads the build-time constant through acpDataDir', () => {
    const src = readFileSync(join(__dirname, 'acp.ts'), 'utf8')
    expect(src).toMatch(/declare const __MFF_SYS_DIR_NAME__/)
    expect(src).toMatch(/runtimePaths\(acpDataDir\(process\.env, typeof __MFF_SYS_DIR_NAME__ === 'string' \? __MFF_SYS_DIR_NAME__ : undefined\)\)/)
  })
})

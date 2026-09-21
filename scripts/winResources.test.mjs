import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { applyWinResources, readWinResources, iconHashesFromIco, versionParts } = require('./winResources.cjs')

// ★真 PE 文件当夹具:node-pty 自带的两个架构的 winpty-agent.exe(几百 KB,依赖里本来就有)。
//  用真文件而不是手搓字节,测的才是 resedit 在真实 exe 上的行为。
const FIX = {
  x64: 'node_modules/node-pty/prebuilds/win32-x64/winpty-agent.exe',
  arm64: 'node_modules/node-pty/prebuilds/win32-arm64/winpty-agent.exe',
}
const ICO = 'build/icon.ico'
const OPTS = {
  icoPath: ICO, version: '1.2.1', productName: 'myFlowForge', companyName: 'zghua',
  description: 'A desktop cockpit', copyright: 'Copyright © 2026 zghua', exeName: 'myFlowForge.exe',
}

describe('versionParts', () => {
  it('Windows 版本号只有四段数字,预发布后缀丢掉', () => {
    expect(versionParts('1.2.1')).toEqual([1, 2, 1, 0])
    expect(versionParts('1.3.0-beta.4')).toEqual([1, 3, 0, 0])
  })
  it('解析不了就报错,不写一个错的版本号进去', () => {
    expect(() => versionParts('latest')).toThrow(/解析不了/)
  })
})

describe('applyWinResources / readWinResources', () => {
  let dir
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'winres-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
  const copy = (arch) => { const p = join(dir, `${arch}.exe`); copyFileSync(FIX[arch], p); return p }

  it('★架构从 PE 头读,两个架构都认得', () => {
    expect(readWinResources(copy('x64')).machine).toBe('x64')
    expect(readWinResources(copy('arm64')).machine).toBe('arm64')
  })

  it('写入之后回读:版本号、产品名、公司名、原始文件名都对', () => {
    const exe = copy('x64')
    applyWinResources(exe, OPTS)
    const r = readWinResources(exe)
    expect(r.fileVersion).toBe('1.2.1.0')
    expect(r.strings.length).toBeGreaterThan(0)
    for (const s of r.strings) {
      expect(s.ProductName).toBe('myFlowForge')
      expect(s.CompanyName).toBe('zghua')
      expect(s.OriginalFilename).toBe('myFlowForge.exe')
      expect(s.FileVersion).toBe('1.2.1.0')
    }
  })

  /** ★比对的是图片本身。资源管理器取第一个图标组 —— 旧图标没清掉的话,显示的仍是原来那个。 */
  it('★图标与 build/icon.ico 逐张相同,旧图标一张不剩', () => {
    const exe = copy('x64')
    applyWinResources(exe, OPTS)
    expect(readWinResources(exe).iconHashes).toEqual(iconHashesFromIco(ICO))
  })

  it('写资源不改架构(arm64 进 arm64 出)', () => {
    const exe = copy('arm64')
    applyWinResources(exe, OPTS)
    const r = readWinResources(exe)
    expect(r.machine).toBe('arm64')
    expect(r.fileVersion).toBe('1.2.1.0')
  })

  it('写两次结果一样(打包重跑不会越写越多)', () => {
    const exe = copy('x64')
    applyWinResources(exe, OPTS)
    const once = readWinResources(exe)
    applyWinResources(exe, OPTS)
    expect(readWinResources(exe)).toEqual(once)
  })
})

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { parseShasums, zipName, binaryInside, ensureElectronDist } from './electronDist.mjs'

const VER = '42.4.0'
const sha = (s) => createHash('sha256').update(s).digest('hex')

describe('parseShasums', () => {
  const text = [
    `${'a'.repeat(64)} *electron-v42.4.0-win32-x64-symbols.zip`,
    `${'b'.repeat(64)} *electron-v42.4.0-win32-x64.zip`,
    `${'c'.repeat(64)}  electron-v42.4.0-darwin-arm64.zip`,
  ].join('\r\n')

  it('按整个文件名匹配', () => {
    expect(parseShasums(text, 'electron-v42.4.0-win32-x64.zip')).toBe('b'.repeat(64))
    expect(parseShasums(text, 'electron-v42.4.0-darwin-arm64.zip')).toBe('c'.repeat(64))
  })

  /** ★`...-win32-x64.zip` 是 `...-win32-x64-symbols.zip` 的前缀:子串匹配会拿到别人的哈希,校验就形同虚设。 */
  it('★不会把前缀相同的另一个文件的哈希拿过来', () => {
    expect(parseShasums(`${'a'.repeat(64)} *electron-v42.4.0-win32-x64-symbols.zip`, 'electron-v42.4.0-win32-x64.zip')).toBeNull()
  })

  it('没有这一项就返回 null', () => {
    expect(parseShasums(text, 'electron-v42.4.0-linux-x64.zip')).toBeNull()
  })
})

describe('命名', () => {
  it('zip 名与官方一致', () => {
    expect(zipName(VER, 'win32', 'arm64')).toBe('electron-v42.4.0-win32-arm64.zip')
  })
  it('用来判断解压完整的那个文件', () => {
    expect(binaryInside('win32')).toBe('electron.exe')
    expect(binaryInside('darwin')).toBe(join('Electron.app', 'Contents', 'MacOS', 'Electron'))
  })
})

describe('ensureElectronDist', () => {
  let root
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'edist-')) })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  /** 假的「镜像」:按 URL 结尾返回内容。zipBody 就是 zip 的全部字节(测试里不需要真 zip)。 */
  function fakeIo({ zipBody = 'REAL-ZIP', sumsFor = zipBody, extractMakesBinary = true } = {}) {
    const file = zipName(VER, 'win32', 'x64')
    const io = {
      download: vi.fn((url, out) => {
        mkdirSync(dirname(out), { recursive: true })
        if (url.endsWith('SHASUMS256.txt')) writeFileSync(out, `${sha(sumsFor)} *${file}\n`)
        else writeFileSync(out, zipBody)
      }),
      extract: vi.fn((_zip, dir) => {
        if (extractMakesBinary) writeFileSync(join(dir, 'electron.exe'), 'MZ')
      }),
    }
    return io
  }
  const call = (io) => ensureElectronDist({ version: VER, platform: 'win32', arch: 'x64', cacheRoot: root, io })

  it('下载 → 校验 → 解压,返回目录并留下校验标记', () => {
    const io = fakeIo()
    const dir = call(io)
    expect(dir).toBe(join(root, VER, 'win32-x64'))
    expect(existsSync(join(dir, 'electron.exe'))).toBe(true)
    expect(readFileSync(join(dir, '.verified-sha256'), 'utf8').trim()).toBe(sha('REAL-ZIP'))
    expect(io.download).toHaveBeenCalledTimes(2)   // 校验和 + zip
  })

  it('第二次直接命中缓存,一个字节都不下', () => {
    call(fakeIo())
    const io = fakeIo()
    call(io)
    expect(io.download).not.toHaveBeenCalled()
    expect(io.extract).not.toHaveBeenCalled()
  })

  /**
   * ★★这正是当初把 electronDist 钉死的原因:代理后面下载会被弄坏。
   *  现在它必须**当场失败**,而且把坏文件删掉,免得下一次把它当缓存复用。
   */
  it('★下载被弄坏:当场失败、报出两个哈希、删掉坏文件', () => {
    const io = fakeIo({ zipBody: 'CORRUPTED-BY-PROXY', sumsFor: 'REAL-ZIP' })
    expect(() => call(io)).toThrow(/校验失败[\s\S]*官方: [0-9a-f]{64}[\s\S]*实际: [0-9a-f]{64}/)
    expect(existsSync(join(root, VER, zipName(VER, 'win32', 'x64')))).toBe(false)
    expect(existsSync(join(root, VER, 'win32-x64', '.verified-sha256'))).toBe(false)
  })

  it('★解压出来没有 electron.exe:失败,且不留校验标记', () => {
    const io = fakeIo({ extractMakesBinary: false })
    expect(() => call(io)).toThrow(/找不到 electron\.exe/)
    expect(existsSync(join(root, VER, 'win32-x64', '.verified-sha256'))).toBe(false)
  })

  /** ★只看「目录在不在」的缓存,会把一次被打断的解压残骸当成好的一直用下去。 */
  it('★标记和官方哈希对不上(上次没做完)就重新解压', () => {
    call(fakeIo())
    writeFileSync(join(root, VER, 'win32-x64', '.verified-sha256'), 'stale\n')
    const io = fakeIo()
    call(io)
    expect(io.extract).toHaveBeenCalledTimes(1)
  })

  it('校验和里没有这一项:失败,并删掉缓存的校验和文件好让下次重拉', () => {
    const io = fakeIo()
    io.download.mockImplementation((url, out) => {
      mkdirSync(dirname(out), { recursive: true })
      writeFileSync(out, `${'0'.repeat(64)} *something-else.zip\n`)
    })
    expect(() => call(io)).toThrow(/官方校验和里没有/)
    expect(existsSync(join(root, VER, 'SHASUMS256.txt'))).toBe(false)
  })

  it('拒绝不认识的平台和架构', () => {
    expect(() => ensureElectronDist({ version: VER, platform: 'linux', arch: 'x64', cacheRoot: root, io: fakeIo() })).toThrow(/不支持的平台/)
    expect(() => ensureElectronDist({ version: VER, platform: 'win32', arch: 'ia32', cacheRoot: root, io: fakeIo() })).toThrow(/不支持的架构/)
  })
})

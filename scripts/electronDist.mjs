#!/usr/bin/env node
/**
 * 取一份**目标平台 + 架构**的 Electron,按官方校验和验过,返回解压后的目录。
 *
 * ★★为什么需要它 —— `electron-builder.yml` 以前把 `electronDist` 钉死成 `node_modules/electron/dist`,
 *  也就是**打包这台机器自己**的那份 Electron。目标和本机一样时没事;一旦不一样就打出坏包,
 *  而且有两种坏法:
 *   · mac 上打 Windows:包里没有 `electron.exe`,在改名那步 `ENOENT` 挂掉(2026-09-21 踩的);
 *   · Intel mac 上打 arm64:**构建全绿**,产出一个名字写着 arm64、里面是 x86_64 的 dmg(以前真发出去过)。
 *  当初钉死它,是为了躲「electron-builder 自己下载时,框架包在代理后面被弄坏」
 *  (`extra bytes at beginning of zipfile`)。**校验和才是那件事真正的解法**:坏了就当场报出来,
 *  而不是换一种方式绕开下载 —— 绕开的代价就是上面那两种坏包。
 *
 * 用法:
 *   node scripts/electronDist.mjs <platform> <arch>     # darwin|win32  x64|arm64
 *   → stdout 打印目录(给 `-c.electronDist=` 用),过程日志走 stderr
 *
 * ★跨平台:Windows 虚拟机里的 `npm run dist:win` 也走这里 —— 所以是 node,不是 bash。
 *  下载用 curl(Win10 起自带 curl.exe;两边都认 https_proxy),解压在 Windows 上用 tar(bsdtar 认 zip)。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, renameSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const MIRROR = 'https://npmmirror.com/mirrors/electron'
export const PLATFORMS = ['darwin', 'win32']
export const ARCHES = ['x64', 'arm64']

export const zipName = (version, platform, arch) => `electron-v${version}-${platform}-${arch}.zip`

/** 解压后用来判断「这份 dist 是完整的」的那个文件。 */
export function binaryInside(platform) {
  if (platform === 'darwin') return join('Electron.app', 'Contents', 'MacOS', 'Electron')
  if (platform === 'win32') return 'electron.exe'
  throw new Error(`不支持的平台: ${platform}`)
}

/**
 * 从官方 `SHASUMS256.txt` 里找某个文件的哈希。格式是 `<64位hex> *<文件名>`(星号表示二进制模式,可省)。
 * ★按**整行文件名**匹配,不能用 includes —— `electron-v42-win32-x64.zip` 是
 *  `electron-v42-win32-x64-symbols.zip` 这类文件名的前缀,子串匹配会拿到别人的哈希。
 */
export function parseShasums(text, file) {
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^([0-9a-f]{64}) [ *]?(.+)$/i.exec(line.trim())
    if (m && m[2] === file) return m[1].toLowerCase()
  }
  return null
}

export const sha256File = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

const log = (msg) => process.stderr.write(`[electronDist] ${msg}\n`)

const defaultIo = {
  download(url, out) {
    // 先落到临时名,成功再改名:下载到一半断掉时,不会留下一个「名字对、内容半截」的缓存。
    const tmp = `${out}.part`
    execFileSync('curl', ['-fsSL', '--retry', '3', '--max-time', '900', url, '-o', tmp], { stdio: ['ignore', 'ignore', 'inherit'] })
    renameSync(tmp, out)
  },
  extract(zip, dir) {
    // ★macOS 上用 unzip:Electron.app 里的 framework 全靠符号链接,unzip 会原样保留。
    if (process.platform === 'win32') execFileSync('tar', ['-xf', zip, '-C', dir], { stdio: 'inherit' })
    else execFileSync('unzip', ['-q', '-o', zip, '-d', dir], { stdio: 'inherit' })
  },
}

/**
 * ★缓存命中的条件是「目录里的 .verified-sha256 等于**官方**哈希,且二进制在」——
 *  不是「目录存在」。只看目录存在的话,一次解压到一半被打断的残骸会被当成好的一直复用下去。
 */
export function ensureElectronDist({ version, platform, arch, cacheRoot, io = defaultIo }) {
  if (!PLATFORMS.includes(platform)) throw new Error(`不支持的平台: ${platform}(只认 ${PLATFORMS.join(' / ')})`)
  if (!ARCHES.includes(arch)) throw new Error(`不支持的架构: ${arch}(只认 ${ARCHES.join(' / ')})`)

  const verDir = join(cacheRoot, version)
  mkdirSync(verDir, { recursive: true })
  const file = zipName(version, platform, arch)

  const sumsPath = join(verDir, 'SHASUMS256.txt')
  if (!existsSync(sumsPath)) {
    log(`↓ ${version} 的官方校验和`)
    io.download(`${MIRROR}/${version}/SHASUMS256.txt`, sumsPath)
  }
  const expected = parseShasums(readFileSync(sumsPath, 'utf8'), file)
  if (!expected) {
    // 校验和文件里没有这一项 = 要么版本号不对,要么校验和文件本身是坏的。删掉让下次重拉。
    rmSync(sumsPath, { force: true })
    throw new Error(`官方校验和里没有 ${file} —— 版本号对吗?(已删掉缓存的 SHASUMS256.txt,重跑会重新拉)`)
  }

  const dir = join(verDir, `${platform}-${arch}`)
  const marker = join(dir, '.verified-sha256')
  const bin = join(dir, binaryInside(platform))
  if (existsSync(marker) && readFileSync(marker, 'utf8').trim() === expected && existsSync(bin)) {
    log(`✓ 缓存命中 ${platform}-${arch}(已校验)`)
    return dir
  }

  const zip = join(verDir, file)
  if (!existsSync(zip) || sha256File(zip) !== expected) {
    log(`↓ ${file}`)
    io.download(`${MIRROR}/${version}/${file}`, zip)
  }
  const got = sha256File(zip)
  if (got !== expected) {
    rmSync(zip, { force: true })
    throw new Error(
      `${file} 校验失败 —— 下载被弄坏了(代理?),已删掉,重跑会重新下。\n` +
      `  官方: ${expected}\n  实际: ${got}`,
    )
  }
  log(`✓ ${file} 与官方校验和一致`)

  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  io.extract(zip, dir)
  if (!existsSync(bin)) throw new Error(`解压后找不到 ${binaryInside(platform)} —— ${zip} 的内容不是预期的 Electron`)
  writeFileSync(marker, `${expected}\n`)
  return dir
}

export function electronVersion() {
  const require = createRequire(import.meta.url)
  return require('electron/package.json').version
}

export const defaultCacheRoot = () => join(homedir(), '.cache', 'myflowforge-electron')

// ── CLI ──────────────────────────────────────────────────────────────────────────
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [platform, arch] = process.argv.slice(2)
  try {
    const dir = ensureElectronDist({ version: electronVersion(), platform, arch, cacheRoot: defaultCacheRoot() })
    process.stdout.write(`${dir}\n`)
  } catch (e) {
    log(`✗ ${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
  }
}

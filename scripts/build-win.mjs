#!/usr/bin/env node
/**
 * 打 Windows 安装包 —— `npm run dist:win`(x64) / `npm run dist:win-arm64`。
 *
 * ★mac 上和 Windows 虚拟机里跑的是**同一份**(所以是 node 不是 bash):
 *   1. 编译(electron-vite build)
 *   2. 取**目标架构**的 Windows 版 Electron,按官方校验和验过(scripts/electronDist.mjs)
 *   3. electron-builder 打包,`-c.electronDist` 指向第 2 步那份;图标/版本信息由 afterPack 用 resedit 写
 *   4. **验收闸**:回读产物,任何一项不对就以非零退出
 *
 * ★★第 4 步是这个脚本存在的主要理由。这个项目反复栽在「命令成功了、包是坏的」上:
 *  electron-builder 在 rcedit 失败时会重试后继续、在 electronDist 给错架构时照样打出一个包 ——
 *  退出码都是 0。所以验收不看日志,只看产物本身。
 */
import { execFileSync, execSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { ensureElectronDist, electronVersion, defaultCacheRoot } from './electronDist.mjs'

const require = createRequire(import.meta.url)
const { readWinResources, iconHashesFromIco, versionParts } = require('./winResources.cjs')

const arch = process.argv[2] ?? 'x64'
if (!['x64', 'arm64'].includes(arch)) {
  console.error(`✗ 只认 x64 / arm64,收到 ${arch}`)
  process.exit(1)
}

const version = JSON.parse(readFileSync('package.json', 'utf8')).version
const product = /^productName:\s*(.+)$/m.exec(readFileSync('electron-builder.yml', 'utf8'))?.[1].trim()
if (!product) { console.error('✗ electron-builder.yml 里找不到 productName'); process.exit(1) }

/** ★Windows 上 npm/npx 是 .cmd,新版 node 不许不经 shell 直接 spawn .cmd(会报 EINVAL)。 */
function run(bin, args) {
  if (process.platform !== 'win32') return execFileSync(bin, args, { stdio: 'inherit' })
  const q = (a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)
  return execSync([bin, ...args].map(q).join(' '), { stdio: 'inherit' })
}

console.log(`▸ ${product} ${version} · Windows ${arch}`)
console.log('▸ 编译(electron-vite build)…')
run('npm', ['run', 'build'])

const dist = ensureElectronDist({ version: electronVersion(), platform: 'win32', arch, cacheRoot: defaultCacheRoot() })
console.log(`▸ electronDist = ${dist}`)
run('npx', ['electron-builder', '--win', `--${arch}`, `-c.electronDist=${dist}`])

// ── 验收闸 ─────────────────────────────────────────────────────────────────────────
console.log('\n▸ 验收(回读产物,不看日志)')
const fails = []
const check = (ok, what, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${what}${detail ? ` —— ${detail}` : ''}`)
  if (!ok) fails.push(what)
}

const unpacked = join('release', arch === 'x64' ? 'win-unpacked' : `win-${arch}-unpacked`)
const exe = join(unpacked, `${product}.exe`)
const installer = join('release', `${product}-${version}-${arch}-setup.exe`)

check(existsSync(exe), `主程序存在 ${exe}`)
if (existsSync(exe)) {
  const r = readWinResources(exe)
  // ★架构只认 PE 头。以前 Intel mac 上打 arm64 就是「名字对、里面是 x86_64」。
  check(r.machine === arch, '主程序架构', `PE 头 = ${r.machine}`)
  const want = versionParts(version).join('.')
  check(r.fileVersion === want, '版本号', `${r.fileVersion}(应为 ${want})`)
  const names = r.strings.map((s) => s.ProductName)
  check(names.length > 0 && names.every((n) => n === product), '产品名', JSON.stringify(names))
  const leaked = r.strings.flatMap((s) => Object.entries(s)).filter(([, v]) => /\bElectron\b/.test(String(v)))
  check(leaked.length === 0, '属性里没有残留的 "Electron"', leaked.map(([k]) => k).join(', '))
  const icons = iconHashesFromIco('build/icon.ico')
  check(JSON.stringify(r.iconHashes) === JSON.stringify(icons), '图标与 build/icon.ico 逐张相同', `${r.iconHashes.length}/${icons.length} 张`)
}

// node-pty 的预编译件必须有**这个架构**的那一份 —— 没有的话终端打不开,而且是装上之后运行时才炸。
const ptyDir = join(unpacked, 'resources', 'app', 'node_modules', 'node-pty', 'prebuilds', `win32-${arch}`)
check(existsSync(ptyDir), `node-pty 预编译件 win32-${arch}`)

check(existsSync(installer), `安装器存在 ${installer}`)
if (existsSync(installer)) {
  const mb = statSync(installer).size / 1024 / 1024
  check(mb > 50, '安装器体积', `${mb.toFixed(1)} MB`)
}

if (fails.length) {
  console.error(`\n✗ 验收没过(${fails.length} 项)—— 这个包不能发。`)
  process.exit(1)
}
console.log(`\n✓ ${installer}`)

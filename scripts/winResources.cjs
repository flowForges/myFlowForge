// Windows exe 的图标和版本信息 —— 用纯 JS 写,不再经过 wine。
//
// ★★为什么不用 electron-builder 自带的那一步:它在非 Windows 主机上是「下载一份 wine,再用 wine 跑
//  rcedit.exe」。2026-09-21 在 mac 上打 1.2.1 时,那份 wine 第一次启动就超时
//  (`⨯ cannot execute cause=context deadline exceeded`),靠 electron-builder 的自动重试才过;
//  而且每台新机器都要先从 GitHub 拉 25MB 的 wine + winCodeSign。一个**靠重试才能通**的步骤,
//  迟早会在某次「全部重试都超时」时挂掉。
//  electron-builder 自己就依赖 resedit(纯 JS 的 PE 资源编辑器),这里直接用它:任何主机、零下载、确定性。
//
// ★配套:electron-builder.yml 里 `win.signAndEditExecutable: false`,由 afterPack 调这里的 applyWinResources。
//  那个开关同时也关掉了 electron-builder 的 Authenticode 签名 —— 以后买了代码签名证书,
//  要在 afterPack 里、**写完资源之后**再签(先签再改资源,签名当场作废)。
const { readFileSync, writeFileSync } = require('node:fs')
const { createHash } = require('node:crypto')
const ResEdit = require('resedit')

const LANG_EN_US = 1033
const CODEPAGE_UNICODE = 1200

/** `1.2.1` / `1.2.1-beta.3` → [1,2,1,0]。★Windows 的版本号只能是四段数字,预发布后缀放不进去。 */
function versionParts(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version))
  if (!m) throw new Error(`版本号解析不了: ${version}`)
  return [Number(m[1]), Number(m[2]), Number(m[3]), 0]
}

/** PE 头里的机器类型。★验收架构只能看这个 —— 文件名说明不了任何事。 */
const MACHINE = { 0x8664: 'x64', 0xaa64: 'arm64', 0x014c: 'ia32' }
function peMachine(buf) {
  if (buf.readUInt16LE(0) !== 0x5a4d) throw new Error('不是 PE 文件(没有 MZ 头)')
  const pe = buf.readUInt32LE(0x3c)
  if (buf.readUInt32LE(pe) !== 0x00004550) throw new Error('不是 PE 文件(没有 PE 签名)')
  const m = buf.readUInt16LE(pe + 4)
  return MACHINE[m] ?? `0x${m.toString(16)}`
}

// ★ignoreCert:Electron 官方的 electron.exe 是签过名的。改资源必然让那个签名作废
//  (rcedit 也一样),不忽略的话 resedit 会拒绝解析。
const load = (buf) => {
  const exe = ResEdit.NtExecutable.from(buf, { ignoreCert: true })
  return { exe, res: ResEdit.NtExecutableResource.from(exe) }
}

const sha1 = (bin) => createHash('sha1').update(Buffer.from(bin)).digest('hex')

/** 图标组里每张图的哈希(排序后)。用来和 .ico 文件逐张比对。 */
function iconHashesFromEntries(entries) {
  // RT_ICON = 3。★比对图片本身,不比对图标组的 id —— 那个值换一台构建机都可能不同。
  return entries.filter((e) => e.type === 3).map((e) => sha1(e.bin)).sort()
}
function iconHashesFromIco(icoPath) {
  const ico = ResEdit.Data.IconFile.from(readFileSync(icoPath))
  return ico.icons.map((i) => sha1(i.data.bin ?? i.data.generate())).sort()
}

/**
 * 把图标和版本信息写进 exe(原地改写)。
 * @param {string} exePath
 * @param {{icoPath:string, version:string, productName:string, companyName:string,
 *          description:string, copyright:string, exeName:string}} o
 */
function applyWinResources(exePath, o) {
  const { exe, res } = load(readFileSync(exePath))

  // ── 图标:**替换**原来那个图标组,不是新增一个 —— 资源管理器取的是第一个图标组,
  //    新增的话 exe 在资源管理器里仍显示 Electron 的原子图标。
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries)
  const gid = groups[0]?.id ?? 1
  const glang = groups[0]?.lang ?? LANG_EN_US
  // 先把旧的图标图片全删掉,否则被替换下来的 RT_ICON 会作为孤儿留在文件里。
  res.entries = res.entries.filter((e) => e.type !== 3 && e.type !== 14)
  const ico = ResEdit.Data.IconFile.from(readFileSync(o.icoPath))
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, gid, glang, ico.icons.map((i) => i.data))

  // ── 版本信息
  const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0] ?? ResEdit.Resource.VersionInfo.createEmpty()
  const [a, b, c, d] = versionParts(o.version)
  const dotted = `${a}.${b}.${c}.${d}`
  vi.setFileVersion(a, b, c, d)
  vi.setProductVersion(a, b, c, d)
  // ★每一种已有的语言都要写。只写一种的话,系统语言恰好匹配到另一张表时,属性里显示的还是 "Electron"。
  const langs = vi.getAllLanguagesForStringValues()
  const targets = langs.length ? langs : [{ lang: LANG_EN_US, codepage: CODEPAGE_UNICODE }]
  for (const lang of targets) {
    vi.setStringValues(lang, {
      FileDescription: o.description,
      ProductName: o.productName,
      CompanyName: o.companyName,
      LegalCopyright: o.copyright,
      InternalName: o.productName,
      OriginalFilename: o.exeName,
      FileVersion: dotted,
      ProductVersion: dotted,
    })
  }
  vi.outputToResourceEntries(res.entries)

  res.outputResource(exe)
  writeFileSync(exePath, Buffer.from(exe.generate()))
}

/** 回读 exe:验收用。 */
function readWinResources(exePath) {
  const buf = readFileSync(exePath)
  const machine = peMachine(buf)
  const { res } = load(buf)
  const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0]
  const f = vi?.fixedInfo
  const fileVersion = f
    ? [f.fileVersionMS >>> 16, f.fileVersionMS & 0xffff, f.fileVersionLS >>> 16, f.fileVersionLS & 0xffff].join('.')
    : null
  const strings = vi ? vi.getAllLanguagesForStringValues().map((l) => vi.getStringValues(l)) : []
  return { machine, fileVersion, strings, iconHashes: iconHashesFromEntries(res.entries) }
}

module.exports = { applyWinResources, readWinResources, iconHashesFromIco, versionParts, peMachine }

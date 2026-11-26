import * as nodeFs from 'node:fs'
import { homedir } from 'node:os'
import { posix, resolve, win32 } from 'node:path'
import { stripFileProtocol, stripHrefSuffix } from '@shared/fileRef'
import { isInside, resolveFileRef } from './fileRef'

export type ImageRefResult = { dataUrl: string } | { error: string }

const IMG_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
}

const REASON: Record<'missing' | 'outside' | 'dir' | 'bad', string> = {
  missing: '文件不存在', outside: '不在工作区内', dir: '这是个目录', bad: '路径无效',
}

const MAX_BYTES = 25_000_000

/**
 * 把一个图片引用(对话正文里的 `![x](…)`、或文件预览里的相对图)读成 data URL。
 *
 * ★★**解析和越界判断一律走 `resolveFileRef`**,不许在这儿自己拼路径。老实现是
 * `join(cwd, file)` + `abs.startsWith(cwd)`,两处都是坏的:
 *  ① `path.join` 对绝对路径**不会短路** —— `join('/ws','/Users/x/a.png')` = `/ws/Users/x/a.png`,
 *    于是模型写绝对路径时永远报「文件不存在」(而模型跑完命令写的就是绝对路径);
 *  ② `startsWith` 会把 `/a/bc` 判成在 `/a/b` 之内。
 * `resolveFileRef` 两条都对(`isAbsolute` 分支 + `isInside` 比到分隔符),而且和对话里
 * **文件链接**用的是同一套守卫 —— 多一套就多一处会漂移的边界。
 *
 * ★这是个能把任意文件读成 base64 交给渲染层的口子,而现在手机和远程主机都连得进来 ⇒
 * `bases` 为空时**什么都不读**,扩展名不在白名单里**不读**。
 */
export type ReadImageOpts = {
  maxBytes?: number
  /**
   * 放行工作区之外的绝对路径 / file:// / ~/。★只有**本机窗口**(client.id === 'local')能开 ——
   * 手机、远程客户端连进来时 handler 不给,于是它们依旧只能读工作区之内的图。
   */
  allowOutside?: boolean
  /** 测试注入用;默认 os.homedir()。 */
  home?: () => string
  /** 测试注入用;默认 process.platform(决定 allowOutside 分支按哪套路径规则拒网络路径)。 */
  platform?: NodeJS.Platform
  /** 测试注入用:替换个别 fs 调用(模拟检查与读取之间被换文件)。 */
  fs?: Partial<ImageFs>
}

type ImageFs = {
  existsSync: (p: string) => boolean
  realpathSync: (p: string) => string
  statSync: (p: string) => nodeFs.Stats
  openSync: (p: string, flags: number) => number
  fstatSync: (fd: number) => nodeFs.Stats
  readSync: (fd: number, buf: Buffer, off: number, len: number, pos: number) => number
  closeSync: (fd: number) => void
}

const NODE_FS: ImageFs = {
  existsSync: p => nodeFs.existsSync(p),
  realpathSync: p => nodeFs.realpathSync(p),
  statSync: p => nodeFs.statSync(p),
  openSync: (p, flags) => nodeFs.openSync(p, flags),
  fstatSync: fd => nodeFs.fstatSync(fd),
  readSync: (fd, buf, off, len, pos) => nodeFs.readSync(fd, buf, off, len, pos),
  closeSync: fd => nodeFs.closeSync(fd),
}

/**
 * ★★allowOutside 分支里**碰 fs 之前**必须拒掉的网络路径。Windows 上 `//host/share/a.png` 会被 resolve 成 UNC
 * `\\host\share\a.png`,existsSync 就去连 SMB(NTLM 哈希外泄);macOS 上 /net/<host>/… 触发 autofs 自动挂载。
 * win32 只放行本地盘符根(`C:\…`);`\\?\` / `\\.\` 设备路径一并拒。
 */
export function isNetworkPath(p: string, platform: NodeJS.Platform): boolean {
  if (/^[\\/]{2}/.test(p)) return true
  if (platform === 'win32') return !/^[A-Za-z]:[\\/]/.test(p)
  if (platform === 'darwin') return /^\/(net|Network)(\/|$)/i.test(p)
  return false
}

const extOfPath = (p: string): string => {
  const base = p.split(/[\\/]/).pop() ?? ''
  const i = base.lastIndexOf('.')
  return i <= 0 ? '' : base.slice(i + 1).toLowerCase()
}

/** 文件头是否真像它扩展名声称的那种图(只看前 32 字节)。 */
export function looksLikeImage(ext: string, head: Buffer): boolean {
  const at = (sig: number[], off = 0) => sig.every((b, i) => head[off + i] === b)
  const ascii = (s: string, off = 0) => head.subarray(off, off + s.length).toString('latin1') === s
  switch (ext) {
    case 'png': return at([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    case 'jpg': case 'jpeg': return at([0xff, 0xd8, 0xff])
    case 'gif': return ascii('GIF87a') || ascii('GIF89a')
    case 'webp': return ascii('RIFF') && ascii('WEBP', 8)
    case 'bmp': return ascii('BM')
    case 'ico': return at([0x00, 0x00, 0x01, 0x00])
    case 'avif': return ascii('ftyp', 4)
    // svg 是文本:去掉 BOM/空白后必须以 `<` 开头(<?xml / <svg / <!-- …)。<img> 里的 svg 不执行脚本。
    case 'svg': return /^\s*</.test(head.toString('utf8').replace(/^\uFEFF/, ''))
    default: return false
  }
}

/**
 * 把一个图片引用(对话正文里的 `![x](…)`、或文件预览里的相对图)读成 data URL。
 *
 * 守卫(按顺序,每一条都是硬拒):
 *  ① 路径里有 NUL → 路径无效;
 *  ② href 的扩展名不在白名单 → 不读;
 *  ③ 解析:相对路径一律走 `resolveFileRef`(和对话里**文件链接**同一套越界判断);绝对 / file:// / ~/
 *     只在 `allowOutside`(本机窗口)时才能落到工作区之外;
 *  ④ realpath 解开符号链接后**再查一遍**:真身的扩展名也得是图片,且(非 allowOutside 时)真身也得在
 *     某个 base 的真身之内 —— 否则 `ws/escape.png → /etc/…` 就是一条越界通道;
 *  ⑤ 必须是普通文件(目录拒),stat 出的体积先过上限再读;
 *  ⑥ 文件头魔数必须对得上扩展名 —— 改了后缀的文本不会被当图读出去。
 */
export function readImageRef(bases: string[], href: string, opts: ReadImageOpts = {}): ImageRefResult {
  if (href.includes('\0')) return { error: REASON.bad }
  let raw = stripHrefSuffix(stripFileProtocol(href)).trim()
  if (raw.includes('\0')) return { error: REASON.bad }
  if (!IMG_MIME[extOfPath(raw)]) return { error: '不是支持的图片格式' }

  const roots = bases.filter(Boolean)
  if (raw === '~' || raw.startsWith('~/')) raw = resolve((opts.home ?? homedir)(), raw.slice(2))

  const fs: ImageFs = { ...NODE_FS, ...opts.fs }
  const platform = opts.platform ?? process.platform
  const P = platform === 'win32' ? win32 : posix
  // file:///C:/x.png 的 pathname 是 `/C:/x.png` —— win32 上先去掉盘符前那条斜杠。
  if (platform === 'win32' && /^\/[A-Za-z]:[\\/]/.test(raw)) raw = raw.slice(1)

  let abs: string
  const outsideBranch = !!opts.allowOutside && P.isAbsolute(raw)
  if (outsideBranch) {
    // 原样和 resolve 后各查一遍:`/tmp/../net/h` resolve 后才露出 /net/。
    if (/^[\\/]{2}/.test(raw)) return { error: REASON.bad }
    abs = P.resolve(raw)
    if (isNetworkPath(abs, platform)) return { error: REASON.bad }
    if (!fs.existsSync(abs)) return { error: REASON.missing }
  } else {
    const r = resolveFileRef(roots, raw)
    if (!r.ok) return { error: REASON[r.reason] }
    abs = r.abs
  }

  let real: string
  try { real = fs.realpathSync(abs) } catch { return { error: REASON.missing } }
  if (real !== abs) {
    if (outsideBranch && isNetworkPath(real, platform)) return { error: REASON.bad }
    if (!IMG_MIME[extOfPath(real)]) return { error: '不是支持的图片格式' }
    if (!outsideBranch) {
      const realRoots = roots.map(b => { try { return fs.realpathSync(b) } catch { return resolve(b) } })
      if (!realRoots.some(b => isInside(b, real))) return { error: REASON.outside }
    }
  }

  // ★检查和读取必须是**同一个文件**:以前 statSync / openSync 读头 / readFileSync 是三次按路径的调用,
  // 中间把真身换成指向 ~/.ssh/id_rsa 的符号链接就能把私钥当 data:image 读出去。现在 O_NOFOLLOW 只打开一次,
  // fstat 的 dev/ino 必须和 statSync(real) 一致,头和体都从这个 fd 读。
  const max = opts.maxBytes ?? MAX_BYTES
  try {
    const st = fs.statSync(real)
    if (st.isDirectory()) return { error: REASON.dir }
    if (!st.isFile()) return { error: REASON.bad }
    if (st.size > max) return { error: '图片过大' }
    const fd = fs.openSync(real, nodeFs.constants.O_RDONLY | (nodeFs.constants.O_NOFOLLOW ?? 0))
    try {
      const fst = fs.fstatSync(fd)
      if (!fst.isFile() || fst.dev !== st.dev || fst.ino !== st.ino) return { error: '读取失败' }
      if (fst.size > max) return { error: '图片过大' }
      // 多读 1 字节:文件在 fstat 之后长大也能察觉到超限。
      const buf = Buffer.alloc(Math.min(fst.size, max) + 1)
      let n = 0
      for (let r; n < buf.length && (r = fs.readSync(fd, buf, n, buf.length - n, n)) > 0;) n += r
      if (n > max) return { error: '图片过大' }
      const body = buf.subarray(0, n)
      if (!looksLikeImage(extOfPath(real), body.subarray(0, 32))) return { error: '不是图片' }
      return { dataUrl: `data:${IMG_MIME[extOfPath(real)]};base64,${body.toString('base64')}` }
    } finally { fs.closeSync(fd) }
  } catch {
    return { error: '读取失败' }
  }
}

/**
 * 按调用方给 readImageRef 的选项。★只有本机窗口能读工作区之外的图:手机 / 远程客户端连进来的调用,
 * 连接 id 是 serveConnection 现场生成的,永远不是 'local' —— 它们拿不到 host 上任意位置的文件。
 */
export function imageOptsFor(client: { id: string; label?: string; fromOverlay?: boolean } | undefined): ReadImageOpts {
  return { allowOutside: client?.id === 'local' }
}

/**
 * 校验调用方传来的 bases。★bases 来自客户端 —— 远程客户端传 `['/']` 就能把整台机器当成「工作区」。
 * 本机窗口原样放行;其它调用方的**每个** base 都必须是绝对路径,且(解开符号链接后)落在某个已登记工作区之内
 * (项目 worktree 都建在工作区目录下),有一个不合格就整次拒(返回 null)。
 */
export function imageBasesFor(
  client: { id: string } | undefined, bases: unknown[], knownRoots: () => string[],
): string[] | null {
  const list = bases.filter((b): b is string => typeof b === 'string' && b !== '')
  if (client?.id === 'local') return list
  if (list.length !== bases.length) return null
  const real = (p: string) => { try { return nodeFs.realpathSync(p) } catch { return resolve(p) } }
  const roots = knownRoots().filter(Boolean).map(real)
  for (const b of list) {
    if (!posix.isAbsolute(b) && !win32.isAbsolute(b)) return null
    if (!roots.some(r => isInside(r, real(b)))) return null
  }
  return list
}

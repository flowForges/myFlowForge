import { closeSync, existsSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
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

  let abs: string
  if (isAbsolute(raw) && opts.allowOutside) {
    abs = resolve(raw)
    if (!existsSync(abs)) return { error: REASON.missing }
  } else {
    const r = resolveFileRef(roots, raw)
    if (!r.ok) return { error: REASON[r.reason] }
    abs = r.abs
  }

  let real: string
  try { real = realpathSync(abs) } catch { return { error: REASON.missing } }
  if (real !== abs) {
    if (!IMG_MIME[extOfPath(real)]) return { error: '不是支持的图片格式' }
    if (!opts.allowOutside || !isAbsolute(raw)) {
      const realRoots = roots.map(b => { try { return realpathSync(b) } catch { return resolve(b) } })
      if (!realRoots.some(b => isInside(b, real))) return { error: REASON.outside }
    }
  }

  try {
    const st = statSync(real)
    if (st.isDirectory()) return { error: REASON.dir }
    if (!st.isFile()) return { error: REASON.bad }
    if (st.size > (opts.maxBytes ?? MAX_BYTES)) return { error: '图片过大' }
    const head = Buffer.alloc(32)
    const fd = openSync(real, 'r')
    try { readSync(fd, head, 0, 32, 0) } finally { closeSync(fd) }
    if (!looksLikeImage(extOfPath(real), head)) return { error: '不是图片' }
    const buf = readFileSync(real)
    if (buf.length > (opts.maxBytes ?? MAX_BYTES)) return { error: '图片过大' }
    return { dataUrl: `data:${IMG_MIME[extOfPath(real)]};base64,${buf.toString('base64')}` }
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

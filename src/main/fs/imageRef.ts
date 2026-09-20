import { readFileSync } from 'node:fs'
import { resolveFileRef } from './fileRef'

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
export function readImageRef(bases: string[], href: string, opts: { maxBytes?: number } = {}): ImageRefResult {
  const ext = (href.split('?')[0].split('#')[0].split('.').pop() || '').toLowerCase()
  const mime = IMG_MIME[ext]
  if (!mime) return { error: '不是支持的图片格式' }

  const r = resolveFileRef(bases, href)
  if (!r.ok) return { error: REASON[r.reason] }

  try {
    const buf = readFileSync(r.abs)
    if (buf.length > (opts.maxBytes ?? MAX_BYTES)) return { error: '图片过大' }
    return { dataUrl: `data:${mime};base64,${buf.toString('base64')}` }
  } catch {
    return { error: '读取失败' }
  }
}

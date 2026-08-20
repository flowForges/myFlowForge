import { existsSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { stripFileProtocol, stripHrefSuffix } from '@shared/fileRef'

export type ResolvedRef =
  | { ok: true; cwd: string; file: string; abs: string }
  | { ok: false; reason: 'missing' | 'outside' | 'dir' | 'bad' }

/** abs 是否落在 base 之内(base 自身算内)。`/a/bc` 不算在 `/a/b` 内 —— 所以比的是 base + 分隔符。 */
export function isInside(base: string, abs: string): boolean {
  const b = resolve(base)
  const a = resolve(abs)
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep)
}

/**
 * 把对话里的一个 href 解析成「哪个 cwd 下的哪个文件」。
 *
 * bases 按优先级给(当前会话 worktree → workspace 根),命中第一个存在的。返回的 file 是相对 cwd 的路径,
 * 因为下游 FilePreview 一律 join(cwd, file) 去读,预览头部显示的也是这个相对路径。
 *
 * 越界是硬拒绝:模型写 `[看这个](../../../../etc/passwd)` 时不能真开出去。所有 base 都容不下 → 'outside'。
 */
export function resolveFileRef(bases: string[], href: string): ResolvedRef {
  const raw = stripHrefSuffix(stripFileProtocol(href)).trim()
  if (!raw) return { ok: false, reason: 'bad' }
  const roots = bases.filter(Boolean)
  if (roots.length === 0) return { ok: false, reason: 'bad' }

  let sawOutside = false
  let sawDir = false
  for (const base of roots) {
    const abs = isAbsolute(raw) ? resolve(raw) : resolve(base, raw)
    if (!isInside(base, abs)) { sawOutside = true; continue }
    if (!existsSync(abs)) continue
    try {
      if (statSync(abs).isDirectory()) { sawDir = true; continue }
    } catch { continue }
    return { ok: true, cwd: resolve(base), file: relative(resolve(base), abs) || raw, abs }
  }
  if (sawDir) return { ok: false, reason: 'dir' }
  if (sawOutside) return { ok: false, reason: 'outside' }
  return { ok: false, reason: 'missing' }
}

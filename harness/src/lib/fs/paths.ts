import { lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { posix, win32 } from 'node:path'

// 工具路径解析与包含判断(spec §7、§10):权限门与各工具共用

/** 路径规则的三种平台:win32 用 path.win32 且不区分大小写,darwin 不区分大小写,其余 posix */
export type Plat = 'posix' | 'darwin' | 'win32'

/** 解析失败 / 被拒的路径形态返回它:含 NUL,任何 fs 调用都会失败,isInside 永远为 false */
export const OUTSIDE = '\0mffai:outside'

const pathOf = (platform: NodeJS.Platform) => (platform === 'win32' ? win32 : posix)

/** win32 只认 `X:\…` 形式;拒绝 `\\?\`、`\\.\`、UNC、盘符后的 `:`(备用数据流)、以 `.` 或空格结尾的段(Windows 会静默去掉) */
function plainWin32(p: string): boolean {
  if (!/^[A-Za-z]:\\/.test(p) || p.includes(':', 2)) return false
  return p.slice(3).split('\\').every(s => s === '' || s === '.' || s === '..' || !/[. ]$/.test(s))
}

/** 是否为本平台可比较的绝对路径(不含 NUL;win32 另见 plainWin32) */
function plainAbs(p: string, platform: NodeJS.Platform): boolean {
  if (p.includes('\0')) return false
  return platform === 'win32' ? plainWin32(win32.normalize(p)) : posix.isAbsolute(p)
}

export interface ResolveOpts {
  platform?: NodeJS.Platform
  realpath?: (p: string) => string
  /** 路径项本身是否存在(不跟随符号链接:悬空链接 / 链接环也算存在,随后 realpath 失败 → 外部);抛错 → 外部 */
  exists?: (p: string) => boolean
}

/** 只有 ENOENT / ENOTDIR 算不存在;EACCES、EIO 等抛出,调用方按外部处理(不越过读不了的段) */
const lexists = (p: string) => {
  try {
    lstatSync(p)
    return true
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return false
    throw e
  }
}

/** 相对 cwd 解析 → 最近存在的祖先 realpath → 拼回不存在的尾部;不接受的形态返回 OUTSIDE */
export function resolveToolPath(cwd: string, p: string, opts: ResolveOpts = {}): string {
  const platform = opts.platform ?? process.platform
  const path = pathOf(platform)
  const realpath = opts.realpath ?? realpathSync.native
  const exists = opts.exists ?? lexists
  if (p.includes('\0') || cwd.includes('\0')) return OUTSIDE
  if (platform === 'win32' && /^[\\/]{2}/.test(p)) return OUTSIDE // UNC、\\?\、\\.\
  const abs = path.resolve(cwd, p)
  if (!plainAbs(abs, platform)) return OUTSIDE
  const tail: string[] = []
  let cur = abs
  let real: string
  try {
    while (!exists(cur)) {
      const up = path.dirname(cur)
      if (up === cur) return OUTSIDE // 连根都不存在
      tail.unshift(path.basename(cur))
      cur = up
    }
    real = realpath(cur)
  } catch {
    return OUTSIDE // 悬空链接、链接环、无权限、lstat 的其他错误
  }
  const out = tail.length ? path.join(real, ...tail) : real
  return plainAbs(out, platform) ? out : OUTSIDE
}

/**
 * 按段折叠。strong(只用于黑名单):折得比文件系统更宽,只会多拒不会漏拒——
 * APFS 把 `ſ` 当 `s`、`ß` 当 `ss`,NTFS 的大写表把 `ſ` 映成 `S`,而 toLowerCase 不动它们。
 * darwin 另把 `/System/Volumes/Data` 前缀(数据卷的 firmlink 别名)折回 `/`。
 */
function segments(p: string, platform: NodeJS.Platform, strong: boolean): string[] {
  const path = pathOf(platform)
  let s = path.normalize(p)
  if (platform === 'darwin') {
    s = s.normalize('NFC')
    s = strong ? s.toUpperCase().toLowerCase() : s.toLowerCase()
  } else if (platform === 'win32') s = strong ? s.toUpperCase() : s.toLowerCase()
  const segs = s.split(path.sep).filter(x => x !== '')
  if (platform === 'darwin' && segs.length >= 3 && segs[0] === 'system' && segs[1] === 'volumes' && segs[2] === 'data') return segs.slice(3)
  return segs
}

function within(child: string, parent: string, platform: NodeJS.Platform, strong: boolean): boolean {
  if (!plainAbs(child, platform) || !plainAbs(parent, platform)) return false
  const c = segments(child, platform, strong)
  const pr = segments(parent, platform, strong)
  return pr.length <= c.length && pr.every((s, i) => s === c[i])
}

/** child 是否等于 parent 或在其下(按段比较;darwin / win32 不区分大小写);任一方不是可比较的绝对路径 → false */
export function isInside(child: string, parent: string, platform: NodeJS.Platform): boolean {
  return within(child, parent, platform, false)
}

const HOME_ROOTS = [
  '.ssh', '.aws', '.gnupg', '.config/gh', '.config/gcloud', '.azure', '.kube', '.docker', '.netrc',
  '.git-credentials', '.npmrc', '.pypirc', '.codex', '.claude', 'Library/Keychains',
]

/** spec §10.1 凭据黑名单(不含 mff-ai 数据目录,由调用方加入) */
export function credentialRoots(home: string, platform: NodeJS.Platform, env: { APPDATA?: string }): string[] {
  const path = pathOf(platform)
  const roots = HOME_ROOTS.map(r => path.join(home, ...r.split('/')))
  if (platform === 'win32' && env.APPDATA) roots.push(...['gh', 'GitHub CLI', 'gcloud'].map(r => path.join(env.APPDATA!, r)))
  return roots
}

const MAX_LINKS = 8

/**
 * 根的 realpath 失败时(路上有悬空链接,如 `~/.ssh → /work/repo/keys` 而 keys 还不存在):
 * 顺着链接读出目标、尽量解析,把途经的每个目标都列进来——否则在 cwd 里写目标会造出这个凭据目录
 */
function danglingTargets(root: string, opts: ResolveOpts): string[] {
  const platform = opts.platform ?? process.platform
  if (opts.exists || opts.realpath || platform !== process.platform) return [] // 注入的假 fs 没有链接
  const path = pathOf(platform)
  const out: string[] = []
  let cur = root
  for (let i = 0; i < MAX_LINKS; i++) {
    const tail: string[] = []
    let anc = cur
    let link: string
    try {
      while (!lexists(anc)) {
        const up = path.dirname(anc)
        if (up === anc) return out
        tail.unshift(path.basename(anc))
        anc = up
      }
      if (!lstatSync(anc).isSymbolicLink()) return out
      link = readlinkSync(anc)
    } catch {
      return out
    }
    cur = path.resolve(path.dirname(anc), link, ...tail)
    out.push(cur)
    const real = resolveToolPath(cur, '.', opts)
    if (real !== OUTSIDE) {
      out.push(real)
      return out
    }
  }
  return out
}

/** 每个根取原样与 realpath 两种形态(家目录在 /var → /private/var、~/.ssh 是符号链接时都要拦住);悬空链接再加其目标 */
export function canonicalRoots(roots: string[], opts: ResolveOpts = {}): string[] {
  const out = new Set<string>()
  for (const r of roots) {
    out.add(r)
    const real = resolveToolPath(r, '.', opts)
    if (real !== OUTSIDE) out.add(real)
    else for (const t of danglingTargets(r, opts)) out.add(t)
  }
  return [...out]
}

/** 是否命中黑名单;不可比较的路径(NUL、win32 的 UNC 等)按命中处理 */
export function isCredentialPath(p: string, roots: string[], platform: NodeJS.Platform): boolean {
  if (!plainAbs(p, platform)) return true
  return roots.some(r => within(p, r, platform, true))
}

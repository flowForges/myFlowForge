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
  if (platform === 'darwin' && isDataAlias(segs)) return segs.slice(3)
  return segs
}

/** 规则引擎(05 spec §4)用:与 isInside / 黑名单同一套按段折叠;调用方先用 isComparablePath 排除不可比较的路径 */
export function foldedSegments(p: string, platform: NodeJS.Platform, strong: boolean): string[] {
  return segments(p, platform, strong)
}

/** 是否为本平台可比较的绝对路径(不含 NUL;win32 只认朴素的 `X:\…`) */
export function isComparablePath(p: string, platform: NodeJS.Platform): boolean {
  return plainAbs(p, platform)
}

/** 数据卷上真正有 firmlink 的目录(/usr 本身在只读系统卷上,只有 /usr/local 是) */
const FIRMLINKED = new Set(['users', 'applications', 'library', 'private', 'opt', 'volumes', 'cores'])

function isDataAlias(segs: string[]): boolean {
  if (segs[0] !== 'system' || segs[1] !== 'volumes' || segs[2] !== 'data') return false
  return FIRMLINKED.has(segs[3]) || (segs[3] === 'usr' && segs[4] === 'local')
}

/** 是否为文件系统根(posix 无段;win32 只剩盘符;darwin 的数据卷根 /System/Volumes/Data 也算);不可比较的路径也算 */
export function isRootLike(p: string, platform: NodeJS.Platform): boolean {
  if (!plainAbs(p, platform)) return true
  const segs = segments(p, platform, false)
  if (platform === 'darwin' && segs.length === 3 && segs[0] === 'system' && segs[1] === 'volumes' && segs[2] === 'data') return true
  return segs.length <= (platform === 'win32' ? 1 : 0)
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
  '.qoder/.auth', // 只有登录态;~/.qoder 其余不是密钥(沙箱里哪些可写由委派的 planExec 定)
]

/** 05 spec §5.1:把凭据挪出家目录的环境变量;dir / file 取值本身,list 按平台分隔符拆,xdg 取其下的 gh、gcloud */
export const RELOCATED_ENV: readonly { name: string; kind: 'dir' | 'file' | 'list' | 'xdg' }[] = [
  { name: 'GNUPGHOME', kind: 'dir' },
  { name: 'DOCKER_CONFIG', kind: 'dir' },
  { name: 'CODEX_HOME', kind: 'dir' },
  { name: 'CLAUDE_CONFIG_DIR', kind: 'dir' },
  { name: 'QODER_CONFIG_DIR', kind: 'dir' }, // 含义没验证(04 spec C16):多拒不漏拒
  { name: 'GH_CONFIG_DIR', kind: 'dir' },
  { name: 'CLOUDSDK_CONFIG', kind: 'dir' },
  { name: 'AZURE_CONFIG_DIR', kind: 'dir' },
  { name: 'AWS_CONFIG_FILE', kind: 'file' },
  { name: 'AWS_SHARED_CREDENTIALS_FILE', kind: 'file' },
  { name: 'GOOGLE_APPLICATION_CREDENTIALS', kind: 'file' },
  { name: 'NPM_CONFIG_USERCONFIG', kind: 'file' },
  { name: 'NETRC', kind: 'file' },
  { name: 'KUBECONFIG', kind: 'list' },
  { name: 'XDG_CONFIG_HOME', kind: 'xdg' },
]

/** 环境快照的类型:只读,改它是编译错误 */
export type EnvSnapshot = Readonly<NodeJS.ProcessEnv>

/**
 * 内核启动时拷一份环境(之后变化不影响判定)。win32 的变量名不区分大小写,
 * 展开后会保留存储时的大小写(`AppData`)→ 一律转大写,查时也按大写
 */
export function snapshotEnv(src: NodeJS.ProcessEnv, platform: NodeJS.Platform): EnvSnapshot {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(src)) out[platform === 'win32' ? k.toUpperCase() : k] = v
  return Object.freeze(out)
}

/** 按名取值;win32 不区分大小写(快照已转大写,未经快照的环境也找得到) */
function envGet(env: EnvSnapshot, name: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== 'win32') return env[name]
  if (env[name] !== undefined) return env[name]
  const key = Object.keys(env).find(k => k.toUpperCase() === name)
  return key === undefined ? undefined : env[key]
}

/**
 * `..` 段先按物理路径走(`/w/link/../gpg`、link → /a/b 时工具实际用的是 /a/gpg):
 * 遇到 `..` 就把已走过的部分 realpath 再取上层。只在本机平台上做;不存在的部分按字面
 */
function physicalDotDot(v: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== process.platform) return undefined
  const path = pathOf(platform)
  const segs = v.split(platform === 'win32' ? /[\\/]/ : '/')
  if (!segs.includes('..')) return undefined
  let cur = path.parse(path.resolve(v)).root
  for (const seg of segs.slice(platform === 'win32' ? 1 : 0)) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      try {
        cur = realpathSync.native(cur)
      } catch {
        // 不存在:字面上取上层
      }
      cur = path.dirname(cur)
    } else cur = path.join(cur, seg)
  }
  return cur
}

/**
 * 取环境变量里的路径:`~`、`~/…`(win32 另认 `~\…`)按 home 展开(gpg、npm、azure-cli 都这样展开);
 * 其余相对值(相对谁都不确定,含 `~user`)、空值、含 NUL 的丢掉。
 * 有 `..` 段时字面形态与物理形态都列上(多拒不漏拒)
 */
function absValues(raw: string | undefined, platform: NodeJS.Platform, list: boolean, home?: string): string[] {
  if (!raw) return []
  const path = pathOf(platform)
  const out: string[] = []
  for (let v of list ? raw.split(path.delimiter) : [raw]) {
    if (v === '' || v.includes('\0')) continue
    if (home !== undefined && (v === '~' || v.startsWith('~/') || (platform === 'win32' && v.startsWith('~\\')))) v = path.join(home, v.slice(1))
    if (!path.isAbsolute(v)) continue
    out.push(v)
    const phys = physicalDotDot(v, platform)
    if (phys !== undefined && phys !== path.resolve(v)) out.push(phys)
  }
  return out
}

/** 环境变量指向的凭据位置(spec §5.1);调用方传启动时的环境快照,给了 home 才展开 `~` */
export function relocatedCredentialRoots(env: EnvSnapshot, platform: NodeJS.Platform, home?: string): string[] {
  return relocatedEntries(env, platform, home).map(e => e.root)
}

function relocatedEntries(env: EnvSnapshot, platform: NodeJS.Platform, home?: string): { name: string; root: string }[] {
  const path = pathOf(platform)
  const out: { name: string; root: string }[] = []
  for (const { name, kind } of RELOCATED_ENV) {
    const vals = absValues(envGet(env, name, platform), platform, kind === 'list', home)
    for (const v of vals) {
      if (kind === 'xdg') out.push({ name, root: path.join(v, 'gh') }, { name, root: path.join(v, 'gcloud') })
      else out.push({ name, root: v })
    }
  }
  return out
}

/**
 * 取值宽到盖住家目录或文件系统根的变量(如 `CODEX_HOME=$HOME`、`DOCKER_CONFIG=/`):照样拒(多拒不漏拒),
 * 只给内核记一行诊断。只回变量名与盖住了什么,不回路径
 */
export function overbroadRelocations(env: EnvSnapshot, home: string, platform: NodeJS.Platform): { name: string; covers: 'home' | 'root' }[] {
  const out: { name: string; covers: 'home' | 'root' }[] = []
  for (const { name, root } of relocatedEntries(env, platform, home)) {
    const covers = isRootLike(root, platform) ? 'root' : within(home, root, platform, true) ? 'home' : undefined
    if (covers && !out.some(o => o.name === name)) out.push({ name, covers })
  }
  return out
}

/** spec §10.1 凭据黑名单 + 05 §5.1 环境变量挪走的位置(不含 mff-ai 数据目录,由调用方加入) */
export function credentialRoots(home: string, platform: NodeJS.Platform, env: EnvSnapshot): string[] {
  const path = pathOf(platform)
  const roots = HOME_ROOTS.map(r => path.join(home, ...r.split('/')))
  const appData = envGet(env, 'APPDATA', platform)
  if (platform === 'win32' && appData) roots.push(...['gh', 'GitHub CLI', 'gcloud'].map(r => path.join(appData, r)))
  roots.push(...relocatedCredentialRoots(env, platform, home))
  return roots
}

const ZSH_FILES = ['.zshrc', '.zprofile', '.zshenv', '.zlogin', '.zlogout']

/**
 * 05 spec §5.2:登录脚本 / 自启动 / git 全局配置,只拒写(写进去下次开终端或登录就执行)。
 * `~/.config/zsh`、`~/.zsh` 是常见的 ZDOTDIR(多在 ~/.zshenv 里设,launchd 起的工作进程环境里没有),静态列上
 */
export const PERSISTENCE_FILES: readonly string[] = [
  '.bashrc', '.bash_profile', '.bash_login', '.bash_logout', '.zshrc', '.zprofile', '.zshenv', '.zlogin', '.zlogout', '.profile',
  '.config/fish', '.gitconfig', '.config/git', 'Library/LaunchAgents', '.config/autostart', '.config/systemd',
  ...['.config/zsh', '.zsh'].flatMap(d => ZSH_FILES.map(f => `${d}/${f}`)),
]

const XDG_PERSISTENCE = ['fish', 'git', 'autostart', 'systemd', 'zsh']

/**
 * 持久化文件的位置;env(启动时的快照)另加被挪走的同类文件:
 * `$ZDOTDIR` 下的 zsh 脚本、`$XDG_CONFIG_HOME` 下的 fish / git / autostart / systemd / zsh 脚本、`$GIT_CONFIG_GLOBAL`
 */
export function persistenceRoots(home: string, platform: NodeJS.Platform, env: EnvSnapshot = {}): string[] {
  const path = pathOf(platform)
  const roots = PERSISTENCE_FILES.map(r => path.join(home, ...r.split('/')))
  const get = (n: string) => absValues(envGet(env, n, platform), platform, false, home)
  for (const v of get('ZDOTDIR')) roots.push(...ZSH_FILES.map(f => path.join(v, f)))
  for (const v of get('XDG_CONFIG_HOME'))
    roots.push(...XDG_PERSISTENCE.flatMap(f => (f === 'zsh' ? ZSH_FILES.map(z => path.join(v, f, z)) : [path.join(v, f)])))
  roots.push(...get('GIT_CONFIG_GLOBAL'))
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

/**
 * 路径里是否有 `.git` 段(与黑名单同样折叠大小写);写进去能改 hooks / config,让只读 git 命令跑任意代码。
 * win32 上 NTFS 忽略段尾的点和空格(`.git.`)、8.3 短名为 `GIT~1`,一并算;不可比较的路径按命中处理
 */
export function hasGitSegment(p: string, platform: NodeJS.Platform): boolean {
  if (!plainAbs(p, platform)) return true
  return segments(p, platform, true).some(seg => {
    const s = seg.toLowerCase()
    if (platform !== 'win32') return s === '.git'
    const trimmed = s.replace(/[. ]+$/, '')
    return trimmed === '.git' || /^git~\d+$/.test(trimmed)
  })
}

/** 是否命中黑名单;不可比较的路径(NUL、win32 的 UNC 等)按命中处理 */
export function isCredentialPath(p: string, roots: string[], platform: NodeJS.Platform): boolean {
  if (!plainAbs(p, platform)) return true
  return roots.some(r => within(p, r, platform, true))
}

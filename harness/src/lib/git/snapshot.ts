// 每轮的 git 快照与回滚(spec §11):快照写在隐藏引用 refs/mffai/…,用临时索引拍,
// 不碰用户的索引、分支、stash、工作区;回滚只写回本轮改过的文件,不跟随链接、不出 cwd、不写 .git
import { spawn } from 'node:child_process'
import { accessSync, constants as fsConstants, lstatSync, readFileSync, realpathSync, rmdirSync, statSync } from 'node:fs'
import { copyFile, lstat, mkdir, mkdtemp, rm, stat, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { FileChange } from '../../protocol/tools'
import { hasGitSegment, isInside, OUTSIDE, resolveToolPath } from '../fs/paths'
import { lexists, mkdirChecked, removeLeaf, replaceFile, replaceSymlink, samePath } from '../fs/safeFs'

export type Git = (
  args: string[],
  o: { cwd: string; env?: Record<string, string>; input?: Buffer; binary?: boolean },
) => Promise<{ code: number; stdout: Buffer; stderr: string }>

const IDENTITY = {
  GIT_AUTHOR_NAME: 'mff-ai',
  GIT_AUTHOR_EMAIL: 'mff-ai@localhost',
  GIT_COMMITTER_NAME: 'mff-ai',
  GIT_COMMITTER_EMAIL: 'mff-ai@localhost',
  GIT_TERMINAL_PROMPT: '0',
  // 部分克隆缺对象时不去 remote.*.url 拉:那个地址可能是沙箱写得到的配置给的
  GIT_NO_LAZY_FETCH: '1',
}

/** 去掉继承的全部 GIT_*(大小写不敏感:Windows 的变量名不分大小写),设 mff-ai 身份、不弹提示 */
export function gitEnv(base: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !k.toUpperCase().startsWith('GIT_')) env[k] = v
  return { ...env, ...IDENTITY }
}

const STDERR_MAX = 64 << 10
/** SIGKILL 之后等 close 的时间(与 runCli 的 AFTER_KILL_MS 同样的道理) */
const HELD_PIPE_MS = 500

/**
 * 默认的 git:`gitEnv(base)` 之上叠 extraEnv(测试注入 GIT_CONFIG_GLOBAL 等)与每次调用的 env。
 * stdout 总是 Buffer(binary 只是提示);超时 → SIGKILL,code = -1,有子进程拿着管道也一样返回;起不来 → reject
 */
export function createGit(opts: { base?: NodeJS.ProcessEnv; extraEnv?: Record<string, string>; timeoutMs?: number } = {}): Git {
  return (args, o) =>
    new Promise((resolve, reject) => {
      const env = { ...gitEnv(opts.base ?? process.env), ...opts.extraEnv, ...o.env }
      const child = spawn('git', args, { cwd: o.cwd, env, stdio: [o.input ? 'pipe' : 'ignore', 'pipe', 'pipe'], windowsHide: true })
      const out: Buffer[] = []
      let err = ''
      let done = false
      let grace: NodeJS.Timeout | undefined
      const finish = (code: number | null) => {
        clearTimeout(timer)
        clearTimeout(grace)
        if (!done) (done = true), resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr: err.slice(0, STDERR_MAX) })
      }
      // 过滤器之类的子进程会继承管道,杀了 git 也等不到 close:放开管道,不等它
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        grace = setTimeout(() => {
          child.stdin?.destroy()
          child.stdout?.destroy()
          child.stderr?.destroy()
          finish(-1)
        }, HELD_PIPE_MS)
      }, opts.timeoutMs ?? 120_000)
      child.stdout!.on('data', (d: Buffer) => out.push(d))
      child.stderr!.on('data', (d: Buffer) => {
        if (err.length < STDERR_MAX) err += d.toString()
      })
      child.on('error', e => {
        clearTimeout(timer)
        clearTimeout(grace)
        if (!done) (done = true), reject(e)
      })
      child.on('close', finish)
      if (o.input) {
        child.stdin!.on('error', () => {}) // git 提前退出 → EPIPE,结果看退出码
        child.stdin!.end(o.input)
      }
    })
}

/** 跑一条 git,非 0 退出 → 抛错(带 stderr 第一行) */
async function run(git: Git, args: string[], o: Parameters<Git>[1]): Promise<Buffer> {
  const r = await git(args, o)
  if (r.code !== 0) throw new Error(`git ${args.find((a, i) => a !== '-c' && args[i - 1] !== '-c')} 失败(${r.code}):${r.stderr.split('\n')[0]}`)
  return r.stdout
}

/**
 * 快照用到的每条 git 都带上:钩子目录指向一个空的临时目录(用户的 post-index-change、
 * reference-transaction 等钩子不跑)、不用 fsmonitor、不写拆分索引(否则会往用户 .git 里加 sharedindex.*)
 */
const guardArgs = (hooks: string) => ['-c', `core.hooksPath=${hooks}`, '-c', 'core.fsmonitor=false', '-c', 'core.splitIndex=false']

/** 建一个临时目录(含空的 hooks/),给 fn 一个带 guardArgs 的 git;结束时整个目录删掉 */
export async function guarded<T>(git: Git, tmpDir: string | undefined, fn: (g: Git, dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpDir ?? tmpdir(), 'mffai-snap-'))
  try {
    const hooks = join(dir, 'hooks')
    await mkdir(hooks)
    const pre = guardArgs(hooks)
    return await fn((args, o) => git([...pre, ...args], o), dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

export interface FileId { dev: number; ino: number }

/**
 * 会话的仓库:建会话时在沙箱外定一次(之后模型才写得到东西),写进 session.created。
 * 沙箱外的每条 git 都用它的 GIT_DIR / GIT_WORK_TREE / GIT_COMMON_DIR,绝不从模型写得到的目录往上找仓库(final review C-1)
 */
export type RepoPin =
  | { kind: 'none' }
  | { kind: 'repo'; top: string; gitDir: string; commonDir: string; ids: { top: FileId; gitDir: FileId; commonDir: FileId } }
export type PinnedRepo = Extract<RepoPin, { kind: 'repo' }>

export const NO_REPO: RepoPin = { kind: 'none' }

const idOf = (p: string): FileId => {
  const st = lstatSync(p)
  return { dev: st.dev, ino: st.ino }
}

/** 三个路径 → 钉子:路径取 realpath,身份取 lstat。路径不在就抛 */
export function pinFromPaths(top: string, gitDir: string, commonDir: string): PinnedRepo {
  const [t, g, c] = [top, gitDir, commonDir].map(p => realpathSync.native(p))
  return { kind: 'repo', top: t, gitDir: g, commonDir: c, ids: { top: idOf(t), gitDir: idOf(g), commonDir: idOf(c) } }
}

/**
 * git 目录在工作树里(又不是 <top>/.git),或在沙箱写得到的状态目录里:这是种出来的形状。
 * 正常的 linked worktree、子模块的 git 目录都在工作树外面(re-review R1-I1)
 */
function plantedShape(top: string, gitDir: string, commonDir: string, untrusted: string[]): boolean {
  const own = join(top, '.git')
  return [gitDir, commonDir].some(d => (isInside(d, top, process.platform) && !samePath(d, own)) || untrusted.some(u => isInside(d, u, process.platform)))
}

/**
 * 建会话时用。不在工作树内(含 .git 目录里、裸仓库)、git 不在、答不上来 → 没有仓库。
 * 上一个会话可能在这个 cwd 里种过仓库,所以形状不对的也算没有;untrusted:沙箱写得到的状态目录(数据目录、~/.qoder)
 */
export async function pinRepo(cwd: string, git: Git, opts: { tmpDir?: string; untrusted?: string[] } = {}): Promise<RepoPin> {
  try {
    return await guarded(git, opts.tmpDir, async g => {
      const r = await g(['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'], { cwd })
      if (r.code !== 0) return NO_REPO
      const [top, gitDir, common] = r.stdout.toString().split('\n')
      // 老 git 不认 --git-common-dir 时原样回显
      if (!top || !gitDir || !common || common.startsWith('-')) return NO_REPO
      const pin = pinFromPaths(top, gitDir, resolve(cwd, common))
      const untrusted = (opts.untrusted ?? []).map(u => resolveToolPath(u, '.')).filter(u => u !== OUTSIDE)
      return plantedShape(pin.top, pin.gitDir, pin.commonDir, [...(opts.untrusted ?? []), ...untrusted]) ? NO_REPO : pin
    })
  } catch {
    return NO_REPO
  }
}

/** 事件里读回来的:形状不对就当没有仓库(不认就不跑 git) */
export function parsePin(raw: unknown): RepoPin {
  const r = raw as PinnedRepo | undefined
  const isId = (x: FileId | undefined) => typeof x?.dev === 'number' && typeof x?.ino === 'number'
  if (r?.kind === 'repo' && [r.top, r.gitDir, r.commonDir].every(p => typeof p === 'string' && isAbsolute(p)) && isId(r.ids?.top) && isId(r.ids?.gitDir) && isId(r.ids?.commonDir)) return r
  return NO_REPO
}

const sameId = (p: string, id: FileId) => {
  const st = lstatSync(p)
  return st.isDirectory() && st.dev === id.dev && st.ino === id.ino
}

/**
 * 钉住的仓库还是原来那个:三个目录的身份没变(换成文件、链接,挪走都不算),common 目录也没被 `commondir` 文件指到别处。
 * 主仓库的 git 目录里不该有 commondir;linked worktree 的要指回 commonDir
 */
export function pinIntact(pin: PinnedRepo): boolean {
  try {
    if (!sameId(pin.top, pin.ids.top) || !sameId(pin.gitDir, pin.ids.gitDir) || !sameId(pin.commonDir, pin.ids.commonDir)) return false
    const link = join(pin.gitDir, 'commondir')
    if (pin.gitDir === pin.commonDir) return !lexists(link)
    return samePath(realpathSync.native(resolve(pin.gitDir, readFileSync(link, 'utf8').trim())), pin.commonDir)
  } catch {
    return false
  }
}

/** 这个 git 的每条命令都只认钉住的仓库。commondir 文件也不看 */
/** 一个会话的全部快照引用都在这下面:回滚用,丢弃 worktree 时也要整个删(内容留在用户的对象库里) */
export const refBase = (sessionId: string) => `refs/mffai/snapshots/${sessionId}`

export const pinnedGit = (git: Git, pin: PinnedRepo): Git => (args, o) =>
  git(args, { ...o, env: { GIT_DIR: pin.gitDir, GIT_WORK_TREE: pin.top, GIT_COMMON_DIR: pin.commonDir, ...o.env } })

/** cwd 在仓库内的前缀,`/` 分隔、以 `/` 结尾;在仓库根时为 '' */
export function repoPrefix(pin: PinnedRepo, cwd: string): string {
  const rel = relative(pin.top, cwd)
  if (rel === '') return ''
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('cwd is outside the pinned repo')
  return `${rel.split(sep).join('/')}/`
}

/** 没有仓库、仓库变了:都不跑 git。不抛的调用方(takeSnapshot)自己先判 */
function usable(pin: RepoPin): PinnedRepo {
  if (pin.kind === 'none') throw new Error('不是 git 工作树')
  if (!pinIntact(pin)) throw new Error('unsafe_repo')
  return pin
}

/** 隔离钩子 + 钉住的仓库 */
function inRepo<T>(git: Git, opts: { pin: RepoPin; tmpDir?: string }, fn: (g: Git, pin: PinnedRepo, dir: string) => Promise<T>): Promise<T> {
  const pin = usable(opts.pin)
  return guarded(pinnedGit(git, pin), opts.tmpDir, (g, dir) => fn(g, pin, dir))
}

async function headOf(g: Git, top: string): Promise<string | undefined> {
  const h = await g(['rev-parse', '-q', '--verify', 'HEAD'], { cwd: top })
  return h.code === 0 ? h.stdout.toString().trim() || undefined : undefined
}

/** 拆成词;引号外有 shell 才懂的字符,或者引号里有展开 → undefined:看不懂的命令不算安全 */
function shellWords(command: string): string[] | undefined {
  const words: string[] = []
  let cur: string | undefined
  let quote: string | undefined
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = undefined
      else if (quote === '"' && /[$`\\]/.test(ch)) return undefined
      else cur += ch
    } else if (ch === "'" || ch === '"') {
      quote = ch
      cur ??= ''
    } else if (/[ \t]/.test(ch)) {
      if (cur !== undefined) words.push(cur)
      cur = undefined
    } else if (/[;&|<>()`$\n\\*?[\]{}~#!]/.test(ch)) return undefined
    else cur = (cur ?? '') + ch
  }
  if (quote) return undefined
  if (cur !== undefined) words.push(cur)
  return words
}

/** 能跑的过滤器。过滤器在沙箱外跑,所以只认这几个程序:见过 tclsh、osascript 这种从 stdin 读程序的,名单拦不完(final review C-1) */
const FILTER_PROGRAMS = new Set(['git-lfs', 'git-crypt'])

export interface FilterContext {
  /** 工作树根:git 跑过滤器时的 cwd */
  top: string
  /** 沙箱写得到的根 */
  roots: string[]
  /** 给 git 的 PATH */
  path: string
}

/**
 * 过滤器命令能不能跑。只有 git-lfs、git-crypt,落在沙箱写不到的地方,才算安全;其余一律不安全,快照就不拍。
 * 看不懂的、相对路径、解析到可写根里的、参数指向可写根或工作树里的文件,都不安全
 */
export function unsafeFilterCommand(command: string, o: FilterContext): boolean {
  const words = shellWords(command)
  if (!words) return true
  if (words.length === 0) return false
  const inRoots = (p: string) => {
    const real = resolveToolPath(o.top, p)
    return real === OUTSIDE || o.roots.some(r => isInside(p, r, process.platform) || isInside(real, resolveToolPath(o.top, r), process.platform))
  }
  const [program, ...args] = words
  if (/\s/.test(program) || program.includes('=') || !FILTER_PROGRAMS.has(basename(program))) return true
  if (program.includes('/')) {
    if (!isAbsolute(program) || inRoots(program)) return true
  } else {
    for (const dir of o.path.split(':')) {
      if (!isAbsolute(dir)) return true // 空条目和 `.` 就是 cwd
      const candidate = join(dir, program)
      try {
        accessSync(candidate, fsConstants.X_OK)
        if (!statSync(candidate).isFile()) continue
      } catch {
        continue
      }
      if (inRoots(candidate)) return true
      break
    }
  }
  return args.some(arg => {
    if (/\s/.test(arg)) return true
    const value = arg.startsWith('-') ? (arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : '') : arg
    if (value === '' || value === '%f') return false
    if (value.includes('/')) return !isAbsolute(value) || inRoots(value)
    return lexists(join(o.top, value))
  })
}

const FILTER_KEY = /^filter\..+\.(clean|smudge|process)$/i

/** 现读 `filter.*`:用户配置、全局配置都算;属性文件 CLI 改得了,所以不看这个过滤器现在用没用上。读不了 = 不安全 */
export async function hasUnsafeFilter(g: Git, pin: PinnedRepo, writableRoots: string[] = []): Promise<boolean> {
  const { top, gitDir, commonDir } = pin
  const config = await g(['config', '-z', '--get-regexp', '^filter\\.'], { cwd: top })
  if (config.code === 1) return false
  if (config.code !== 0) return true
  const roots = [top, gitDir, commonDir, ...(basename(commonDir) === '.git' ? [dirname(commonDir)] : []), ...writableRoots]
  const o: FilterContext = { top, roots, path: process.env.PATH ?? '' }
  return splitZ(config.stdout).some(entry => {
    const nl = entry.indexOf('\n')
    return nl > 0 && FILTER_KEY.test(entry.slice(0, nl)) && unsafeFilterCommand(entry.slice(nl + 1), o)
  })
}

/** 前缀 → 从仓库根算的字面路径规格(前缀里的 `*` 等不当通配) */
const scope = (prefix: string) => (prefix ? `:(top,literal)${prefix}` : ':/')

const splitZ = (b: Buffer) => b.toString().split('\0').filter(s => s !== '')

export interface SnapshotOpts {
  pin: RepoPin
  /** ref 已存在则失败(不覆盖) */
  createOnly?: boolean
  maxFileBytes?: number
  maxTotalBytes?: number
  /** 临时索引与空钩子目录放在这里的独立子目录里,用完即删(默认系统临时目录) */
  tmpDir?: string
  /** 除仓库之外,沙箱还写得到的根:过滤器落在里面就不跑 */
  writableRoots?: string[]
}

/** unsafe_filter:配置里有不认识或沙箱写得到的过滤器;unsafe_repo:钉住的仓库变了。拍不了这一轮就回滚不了 */
export type SnapshotResult = { ref?: string; reason?: 'not_git' | 'too_large' | 'unsafe_filter' | 'unsafe_repo' | 'error' }

export interface GitReadOpts { pin: RepoPin; tmpDir?: string; writableRoots?: string[] }

/** 一次并发 lstat 的个数 */
const STAT_BATCH = 64

/** 未跟踪且未忽略的文件是否超限(单个或合计);列出后被删的不算 */
async function tooLarge(top: string, paths: string[], maxFile: number, maxTotal: number): Promise<boolean> {
  let total = 0
  for (let i = 0; i < paths.length; i += STAT_BATCH) {
    const sizes = await Promise.all(paths.slice(i, i + STAT_BATCH).map(p => lstat(join(top, p)).then(s => s.size, () => 0)))
    for (const size of sizes) {
      total += size
      if (size > maxFile || total > maxTotal) return true
    }
  }
  return false
}

/** 把 cwd 前缀下的工作区(遵守 .gitignore)拍成一个提交,写到 ref;任何失败都不抛,只给 reason */
export async function takeSnapshot(cwd: string, ref: string, git: Git, opts: SnapshotOpts): Promise<SnapshotResult> {
  const maxFile = opts.maxFileBytes ?? 20 << 20
  const maxTotal = opts.maxTotalBytes ?? 200 << 20
  if (opts.pin.kind === 'none') return { reason: 'not_git' }
  if (!pinIntact(opts.pin)) return { reason: 'unsafe_repo' }
  try {
    return await inRepo(git, opts, async (g, pin, dir): Promise<SnapshotResult> => {
      const { top, gitDir } = pin
      const prefix = repoPrefix(pin, cwd)
      const head = await headOf(g, top)
      if (await hasUnsafeFilter(g, pin, opts.writableRoots)) return { reason: 'unsafe_filter' }
      // 未跟踪且未忽略的文件:单个或合计过大 → 不拍(不把大文件塞进用户的对象库)
      const untracked = splitZ(await run(g, ['ls-files', '-o', '--exclude-standard', '-z', '--full-name', '--', scope(prefix)], { cwd: top }))
      if (await tooLarge(top, untracked, maxFile, maxTotal)) return { reason: 'too_large' }
      const index = join(dir, 'index')
      const env = { GIT_INDEX_FILE: index }
      // 复制用户索引(复用 stat 缓存,不用重新哈希全部文件);没有索引 → 从 HEAD 读;没有 HEAD → 空索引。
      // 副本保留原索引的 mtime:git 靠"条目 mtime ≥ 索引 mtime"识别同一时刻内的改动,新 mtime 会让它漏掉同大小的编辑
      const src = join(gitDir, 'index')
      if (lexists(src)) {
        await copyFile(src, index)
        const st = await stat(src)
        await utimes(index, st.atime, st.mtime)
        await clearAssumeUnchanged(g, top, prefix, env)
      } else if (head) await run(g, ['read-tree', head], { cwd: top, env })
      await stripPopulatedGitlinks(g, top, prefix, env)
      await run(g, ['add', '-A', '--', scope(prefix)], { cwd: top, env })
      const tree = (await run(g, ['write-tree'], { cwd: top, env })).toString().trim()
      const commitArgs = ['commit-tree', '--no-gpg-sign', '-m', 'mff-ai snapshot', ...(head ? ['-p', head] : []), tree]
      const commit = (await run(g, commitArgs, { cwd: top })).toString().trim()
      // 空的旧值 = 要求 ref 还不存在
      await run(g, ['update-ref', ref, commit, ...(opts.createOnly ? [''] : [])], { cwd: top })
      return { ref }
    })
  } catch {
    return { reason: 'error' }
  }
}

/**
 * 临时索引里去掉目录里有 `.git` 的 gitlink。否则 add -A 进去跑 `git status`,读的是那个嵌套仓库的配置,
 * 它的 clean 过滤器就在沙箱外跑了(review C1)。去掉之后 add -A 把目录当新的嵌套仓库,按它的 HEAD 记 gitlink,不进去。
 * 没填充的不动:去掉就成了"已删除"
 */
async function stripPopulatedGitlinks(g: Git, top: string, prefix: string, env: Record<string, string>): Promise<void> {
  const listed = splitZ(await run(g, ['ls-files', '-s', '-z', '--full-name', '--', scope(prefix)], { cwd: top, env }))
  const populated = listed.filter(l => l.startsWith('160000 ')).map(l => l.slice(l.indexOf('\t') + 1)).filter(p => lexists(join(top, p, '.git')))
  if (populated.length) await run(g, ['update-index', '-z', '--force-remove', '--stdin'], { cwd: top, env, input: Buffer.from(populated.join('\0') + '\0') })
}

/**
 * 临时索引里去掉 assume-unchanged(否则 add -A 不看这些文件的工作区内容,本轮对它们的改动拍不进来)。
 * skip-worktree 不动:稀疏检出里清掉它会把文件记成已删除
 */
async function clearAssumeUnchanged(g: Git, top: string, prefix: string, env: Record<string, string>): Promise<void> {
  const listed = splitZ(await run(g, ['ls-files', '-v', '-z', '--full-name', '--', scope(prefix)], { cwd: top, env }))
  const paths = listed.filter(l => /^[a-z] /.test(l) && l[0] !== 's').map(l => l.slice(2))
  if (paths.length) await run(g, ['update-index', '-z', '--no-assume-unchanged', '--stdin'], { cwd: top, env, input: Buffer.from(paths.join('\0') + '\0') })
}

const STATUSES = new Set(['A', 'M', 'D', 'T'])

/** from..to 之间 cwd 前缀下变化的文件(路径相对仓库根,`/` 分隔) */
export async function changes(cwd: string, from: string, to: string, git: Git, opts: GitReadOpts): Promise<FileChange[]> {
  return inRepo(git, opts, async (g, pin) => {
    if (await hasUnsafeFilter(g, pin, opts.writableRoots)) throw new Error('unsafe_filter')
    const parts = splitZ(
      await run(g, ['diff', '--name-status', '--no-renames', '--no-ext-diff', '-z', from, to, '--', scope(repoPrefix(pin, cwd))], { cwd: pin.top }),
    )
    const out: FileChange[] = []
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const status = parts[i][0]
      if (!STATUSES.has(status)) throw new Error(`未知的改动状态:${parts[i]}`)
      out.push({ path: parts[i + 1], status: status as FileChange['status'] })
    }
    return out
  })
}

/** from..to 之间 cwd 前缀下任一侧是子模块(gitlink,mode 160000)的路径:回滚写不回它们 */
export async function submodulePaths(cwd: string, from: string, to: string, git: Git, opts: { pin: RepoPin; tmpDir?: string }): Promise<string[]> {
  return inRepo(git, opts, async (g, pin) => {
    const parts = splitZ(
      await run(g, ['diff', '--raw', '--no-renames', '--no-ext-diff', '--no-abbrev', '-z', from, to, '--', scope(repoPrefix(pin, cwd))], { cwd: pin.top }),
    )
    const out: string[] = []
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const [oldMode, newMode] = parts[i].replace(/^:/, '').split(' ')
      if (oldMode === '160000' || newMode === '160000') out.push(parts[i + 1])
    }
    return out
  })
}

/** ls-tree 一次查的路径数(避免参数过长) */
const CHUNK = 200

/** from 里这些路径的 mode 与 sha(不在 from 里的不出现) */
async function entries(git: Git, top: string, from: string, paths: string[]): Promise<Map<string, { mode: string; sha: string }>> {
  const m = new Map<string, { mode: string; sha: string }>()
  for (let i = 0; i < paths.length; i += CHUNK) {
    const chunk = paths.slice(i, i + CHUNK)
    const out = await run(git, ['ls-tree', '-r', '-z', '--full-tree', from, '--', ...chunk], { cwd: top, env: { GIT_LITERAL_PATHSPECS: '1' } })
    for (const line of splitZ(out)) {
      const tab = line.indexOf('\t')
      const [mode, , sha] = line.slice(0, tab).split(' ')
      m.set(line.slice(tab + 1), { mode, sha })
    }
  }
  return m
}

/** `cat-file --batch`:一次取出全部原始内容(二进制安全),按输入顺序返回(只用于符号链接:不做检出转换) */
async function catRaw(git: Git, top: string, shas: string[]): Promise<Buffer[]> {
  if (!shas.length) return []
  const out = await run(git, ['cat-file', '--batch'], { cwd: top, input: Buffer.from(shas.join('\n') + '\n'), binary: true })
  const res: Buffer[] = []
  let off = 0
  for (const sha of shas) {
    const nl = out.indexOf(0x0a, off)
    if (nl < 0) throw new Error(`读不到对象:${sha}`)
    const [got, type, size] = out.subarray(off, nl).toString().split(' ')
    if (got !== sha || type !== 'blob') throw new Error(`读不到对象:${sha}`)
    const n = Number(size)
    res.push(out.subarray(nl + 1, nl + 1 + n))
    off = nl + 1 + n + 1
  }
  return res
}

/**
 * 文件内容按该路径的属性做检出转换(换行符、smudge 过滤器),与 git checkout 写出的一致。
 * 逐个跑:`cat-file --batch --filters` 的头里给的是转换前的大小,没法按它切分输出
 */
async function catFiltered(git: Git, top: string, items: { sha: string; path: string }[]): Promise<Buffer[]> {
  const res: Buffer[] = []
  for (const it of items) res.push(await run(git, ['cat-file', '--filters', `--path=${it.path}`, it.sha], { cwd: top, binary: true }))
  return res
}

/**
 * 仓库内相对路径 → 要操作的绝对路径:不含 `.` / `..` / 空段、不在 .git 下;
 * 父目录 realpath 后必须仍在 cwd 内(中途有链接指向外面 → 抛错)。末段不解析(由调用方不跟随地处理)
 */
function target(realCwd: string, top: string, rel: string): string {
  const segs = rel.split('/')
  if (segs.some(s => s === '' || s === '.' || s === '..')) throw new Error(`不接受的路径:${rel}`)
  const abs = join(top, ...segs)
  const parent = resolveToolPath(realCwd, dirname(abs))
  if (parent === OUTSIDE || !isInside(parent, realCwd, process.platform)) throw new Error(`路径不在工作目录内:${rel}`)
  const p = join(parent, basename(abs))
  if (!isInside(p, realCwd, process.platform) || samePath(p, realCwd)) throw new Error(`路径不在工作目录内:${rel}`)
  if (hasGitSegment(p, process.platform)) throw new Error(`不写 .git 下的文件:${rel}`)
  return p
}

/** 父目录建好后再核对一次:realpath 回自己且仍在 cwd 内 */
function parentStillInside(p: string, realCwd: string): void {
  const dir = dirname(p)
  if (!samePath(realpathSync.native(dir), dir) || !isInside(dir, realCwd, process.platform)) throw new Error(`路径在检查之后发生了变化:${p}`)
}

/** 删掉文件后,向上删因此变空的目录(不含 cwd 本身) */
function pruneEmptyDirs(from: string, realCwd: string): void {
  let d = from
  while (isInside(d, realCwd, process.platform) && !samePath(d, realCwd)) {
    try {
      rmdirSync(d)
    } catch {
      return
    }
    d = dirname(d)
  }
}

/**
 * 把 files 按 from 的内容写回:from 里没有的删除,其余按 from 的内容与权限位写回(符号链接按链接重建)。
 * 先从 git 取齐全部内容再动文件;逐个处理,失败的(含无法写回的子模块)汇总后抛出
 */
export async function restore(cwd: string, from: string, files: FileChange[], git: Git, opts: GitReadOpts): Promise<void> {
  return inRepo(git, opts, async (g, info) => {
    // cat-file --filters 会跑 smudge
    if (await hasUnsafeFilter(g, info, opts.writableRoots)) throw new Error('unsafe_filter')
    const realCwd = realpathSync.native(cwd)
    const targets = files.map(f => {
      return { f, p: target(realCwd, info.top, f.path) }
    })
    const ents = await entries(g, info.top, from, targets.filter(t => t.f.status !== 'A').map(t => t.f.path))
    // 先删后写:start 里是文件、本轮换成了目录(foo → foo/x)时,删掉 foo/x 之后 foo 才能写回
    const removals = targets.filter(t => t.f.status === 'A' || !ents.has(t.f.path))
    const writes = targets.filter(t => !removals.includes(t)).map(t => ({ ...t, e: ents.get(t.f.path)! }))
    const errors: string[] = []
    for (const w of writes) if (w.e.mode === '160000') errors.push(`${w.f.path}: 子模块未回滚`)
    const files_ = writes.filter(w => w.e.mode === '100644' || w.e.mode === '100755')
    const links = writes.filter(w => w.e.mode === '120000')
    const fileData = await catFiltered(g, info.top, files_.map(w => ({ sha: w.e.sha, path: w.f.path })))
    const linkData = await catRaw(g, info.top, links.map(w => w.e.sha))
    for (const { f, p } of removals) {
      try {
        if (!lexists(p)) continue
        parentStillInside(p, realCwd)
        if (lstatSync(p).isDirectory()) throw new Error('是目录')
        removeLeaf(p)
        pruneEmptyDirs(dirname(p), realCwd)
      } catch (e) {
        errors.push(`${f.path}: ${(e as Error).message}`)
      }
    }
    const put = (list: typeof writes, data: Buffer[], write: (p: string, buf: Buffer, mode: string) => void) =>
      list.forEach(({ f, p, e }, i) => {
        try {
          mkdirChecked(dirname(p))
          parentStillInside(p, realCwd)
          write(p, data[i], e.mode)
        } catch (err) {
          errors.push(`${f.path}: ${(err as Error).message}`)
        }
      })
    put(files_, fileData, (p, buf, mode) => replaceFile(p, buf, mode === '100755'))
    put(links, linkData, (p, buf) => replaceSymlink(p, buf.toString()))
    if (errors.length) throw new Error(`回滚有 ${errors.length} 个文件失败:\n${errors.join('\n')}`)
  })
}

/** 引用在不在 */
export async function refExists(ref: string, git: Git, opts: { pin: RepoPin; tmpDir?: string }): Promise<boolean> {
  return inRepo(git, opts, async (g, pin) => (await g(['rev-parse', '-q', '--verify', ref], { cwd: pin.top })).code === 0)
}

/** 一个会话(prefixRef 下)只留最近 keepTurns 轮的引用;按提交时间从新到旧,同一轮的 start / end / pre-rollback 算一轮 */
export async function pruneRefs(prefixRef: string, keepTurns: number, git: Git, opts: { pin: RepoPin; tmpDir?: string }): Promise<void> {
  return inRepo(git, opts, async (g, { top }) => {
    const base = prefixRef.replace(/\/+$/, '') + '/'
    const out = await run(g, ['for-each-ref', '--sort=-committerdate', '--format=%(refname)', base], { cwd: top })
    const kept = new Set<string>()
    const drop: string[] = []
    for (const ref of out.toString().split('\n').filter(Boolean)) {
      const turn = ref.slice(base.length).replace(/-(start|end|pre-rollback(?:-\d+)?)$/, '')
      if (kept.has(turn)) continue
      if (kept.size < keepTurns) kept.add(turn)
      else drop.push(ref)
    }
    if (drop.length) await run(g, ['update-ref', '--stdin'], { cwd: top, input: Buffer.from(drop.map(r => `delete ${r}\n`).join('')) })
  })
}

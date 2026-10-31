// 每轮的 git 快照与回滚(spec §11):快照写在隐藏引用 refs/mffai/…,用临时索引拍,
// 不碰用户的索引、分支、stash、工作区;回滚只写回本轮改过的文件,不跟随链接、不出 cwd、不写 .git
import { spawn } from 'node:child_process'
import { lstatSync, realpathSync, rmdirSync } from 'node:fs'
import { copyFile, lstat, mkdir, mkdtemp, rm, stat, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
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
}

/** 去掉继承的全部 GIT_*(大小写不敏感:Windows 的变量名不分大小写),设 mff-ai 身份、不弹提示 */
export function gitEnv(base: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !k.toUpperCase().startsWith('GIT_')) env[k] = v
  return { ...env, ...IDENTITY }
}

const STDERR_MAX = 64 << 10

/**
 * 默认的 git:`gitEnv(base)` 之上叠 extraEnv(测试注入 GIT_CONFIG_GLOBAL 等)与每次调用的 env。
 * stdout 总是 Buffer(binary 只是提示);超时 → SIGKILL,code = -1;起不来 → reject
 */
export function createGit(opts: { base?: NodeJS.ProcessEnv; extraEnv?: Record<string, string>; timeoutMs?: number } = {}): Git {
  return (args, o) =>
    new Promise((resolve, reject) => {
      const env = { ...gitEnv(opts.base ?? process.env), ...opts.extraEnv, ...o.env }
      const child = spawn('git', args, { cwd: o.cwd, env, stdio: [o.input ? 'pipe' : 'ignore', 'pipe', 'pipe'], windowsHide: true })
      const out: Buffer[] = []
      let err = ''
      let done = false
      const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 120_000)
      child.stdout!.on('data', (d: Buffer) => out.push(d))
      child.stderr!.on('data', (d: Buffer) => {
        if (err.length < STDERR_MAX) err += d.toString()
      })
      child.on('error', e => {
        clearTimeout(timer)
        if (!done) (done = true), reject(e)
      })
      child.on('close', code => {
        clearTimeout(timer)
        if (!done) (done = true), resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr: err.slice(0, STDERR_MAX) })
      })
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
async function guarded<T>(git: Git, tmpDir: string | undefined, fn: (g: Git, dir: string) => Promise<T>): Promise<T> {
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

export interface RepoInfo {
  top: string
  /** cwd 在仓库内的前缀,`/` 分隔、以 `/` 结尾;在仓库根时为 '' */
  prefix: string
  gitDir: string
  head?: string
}

async function readRepoInfo(cwd: string, git: Git): Promise<RepoInfo | undefined> {
  const r = await git(['rev-parse', '--show-toplevel', '--show-prefix', '--absolute-git-dir'], { cwd })
  if (r.code !== 0) return undefined
  const [top, prefix, gitDir] = r.stdout.toString().split('\n')
  if (!top || !gitDir) return undefined
  const h = await git(['rev-parse', '-q', '--verify', 'HEAD'], { cwd })
  const head = h.code === 0 ? h.stdout.toString().trim() || undefined : undefined
  return { top, prefix: prefix ?? '', gitDir, head }
}

/** cwd 所在的工作树;不在工作树内(含 .git 目录里、裸仓库)→ undefined */
export function repoInfo(cwd: string, git: Git, opts: { tmpDir?: string } = {}): Promise<RepoInfo | undefined> {
  return guarded(git, opts.tmpDir, g => readRepoInfo(cwd, g))
}

/** 前缀 → 从仓库根算的字面路径规格(前缀里的 `*` 等不当通配) */
const scope = (prefix: string) => (prefix ? `:(top,literal)${prefix}` : ':/')

const splitZ = (b: Buffer) => b.toString().split('\0').filter(s => s !== '')

export interface SnapshotOpts {
  maxFileBytes?: number
  maxTotalBytes?: number
  /** 临时索引与空钩子目录放在这里的独立子目录里,用完即删(默认系统临时目录) */
  tmpDir?: string
}

export type SnapshotResult = { ref?: string; reason?: 'not_git' | 'too_large' | 'error' }

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
export async function takeSnapshot(cwd: string, ref: string, git: Git, opts: SnapshotOpts = {}): Promise<SnapshotResult> {
  const maxFile = opts.maxFileBytes ?? 20 << 20
  const maxTotal = opts.maxTotalBytes ?? 200 << 20
  try {
    return await guarded(git, opts.tmpDir, async (g, dir): Promise<SnapshotResult> => {
      const info = await readRepoInfo(cwd, g)
      if (!info) return { reason: 'not_git' }
      const { top, prefix, gitDir, head } = info
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
      await run(g, ['add', '-A', '--', scope(prefix)], { cwd: top, env })
      const tree = (await run(g, ['write-tree'], { cwd: top, env })).toString().trim()
      const commitArgs = ['commit-tree', '--no-gpg-sign', '-m', 'mff-ai snapshot', ...(head ? ['-p', head] : []), tree]
      const commit = (await run(g, commitArgs, { cwd: top })).toString().trim()
      await run(g, ['update-ref', ref, commit], { cwd: top })
      return { ref }
    })
  } catch {
    return { reason: 'error' }
  }
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
export function changes(cwd: string, from: string, to: string, git: Git, opts: { tmpDir?: string } = {}): Promise<FileChange[]> {
  return guarded(git, opts.tmpDir, async g => {
    const info = await readRepoInfo(cwd, g)
    if (!info) throw new Error(`不是 git 工作树:${cwd}`)
    const parts = splitZ(
      await run(g, ['diff', '--name-status', '--no-renames', '--no-ext-diff', '-z', from, to, '--', scope(info.prefix)], { cwd: info.top }),
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
export function restore(cwd: string, from: string, files: FileChange[], git: Git, opts: { tmpDir?: string } = {}): Promise<void> {
  return guarded(git, opts.tmpDir, async g => {
    const info = await readRepoInfo(cwd, g)
    if (!info) throw new Error(`不是 git 工作树:${cwd}`)
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

/** 一个会话(prefixRef 下)只留最近 keepTurns 轮的引用;按提交时间从新到旧,同一轮的 start / end / pre-rollback 算一轮 */
export function pruneRefs(cwd: string, prefixRef: string, keepTurns: number, git: Git, opts: { tmpDir?: string } = {}): Promise<void> {
  return guarded(git, opts.tmpDir, async g => {
    const base = prefixRef.replace(/\/+$/, '') + '/'
    const out = await run(g, ['for-each-ref', '--sort=-committerdate', '--format=%(refname)', base], { cwd })
    const kept = new Set<string>()
    const drop: string[] = []
    for (const ref of out.toString().split('\n').filter(Boolean)) {
      const turn = ref.slice(base.length).replace(/-(start|end|pre-rollback)$/, '')
      if (kept.has(turn)) continue
      if (kept.size < keepTurns) kept.add(turn)
      else drop.push(ref)
    }
    if (drop.length) await run(g, ['update-ref', '--stdin'], { cwd, input: Buffer.from(drop.map(r => `delete ${r}\n`).join('')) })
  })
}

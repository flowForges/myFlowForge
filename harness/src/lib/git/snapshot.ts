// 每轮的 git 快照与回滚(spec §11):快照写在隐藏引用 refs/mffai/…,用临时索引拍,
// 不碰用户的索引、分支、stash、工作区;回滚只写回本轮改过的文件,不跟随链接、不出 cwd、不写 .git
import { spawn } from 'node:child_process'
import { copyFileSync, lstatSync, mkdtempSync, realpathSync, rmdirSync, rmSync } from 'node:fs'
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
  if (r.code !== 0) throw new Error(`git ${args[0]} 失败(${r.code}):${r.stderr.split('\n')[0]}`)
  return r.stdout
}

export interface RepoInfo {
  top: string
  /** cwd 在仓库内的前缀,`/` 分隔、以 `/` 结尾;在仓库根时为 '' */
  prefix: string
  gitDir: string
  head?: string
}

/** cwd 所在的工作树;不在工作树内(含 .git 目录里、裸仓库)→ undefined */
export async function repoInfo(cwd: string, git: Git): Promise<RepoInfo | undefined> {
  const r = await git(['rev-parse', '--show-toplevel', '--show-prefix', '--absolute-git-dir'], { cwd })
  if (r.code !== 0) return undefined
  const [top, prefix, gitDir] = r.stdout.toString().split('\n')
  if (!top || !gitDir) return undefined
  const h = await git(['rev-parse', '-q', '--verify', 'HEAD'], { cwd })
  const head = h.code === 0 ? h.stdout.toString().trim() || undefined : undefined
  return { top, prefix: prefix ?? '', gitDir, head }
}

/** 前缀 → 从仓库根算的字面路径规格(前缀里的 `*` 等不当通配) */
const scope = (prefix: string) => (prefix ? `:(top,literal)${prefix}` : ':/')

const splitZ = (b: Buffer) => b.toString().split('\0').filter(s => s !== '')

export interface SnapshotOpts {
  maxFileBytes?: number
  maxTotalBytes?: number
  /** 临时索引放在这里的独立子目录里,用完即删(默认系统临时目录) */
  tmpDir?: string
}

export type SnapshotResult = { ref?: string; reason?: 'not_git' | 'too_large' | 'error' }

/** 把 cwd 前缀下的工作区(遵守 .gitignore)拍成一个提交,写到 ref;任何失败都不抛,只给 reason */
export async function takeSnapshot(cwd: string, ref: string, git: Git, opts: SnapshotOpts = {}): Promise<SnapshotResult> {
  const maxFile = opts.maxFileBytes ?? 20 << 20
  const maxTotal = opts.maxTotalBytes ?? 200 << 20
  let info: RepoInfo | undefined
  try {
    info = await repoInfo(cwd, git)
  } catch {
    return { reason: 'error' }
  }
  if (!info) return { reason: 'not_git' }
  const { top, prefix, gitDir, head } = info
  let dir: string | undefined
  try {
    // 未跟踪且未忽略的文件:单个或合计过大 → 不拍(不把大文件塞进用户的对象库)
    const untracked = splitZ(await run(git, ['ls-files', '-o', '--exclude-standard', '-z', '--full-name', '--', scope(prefix)], { cwd: top }))
    let total = 0
    for (const p of untracked) {
      let size = 0
      try {
        size = lstatSync(join(top, p)).size
      } catch {
        continue // 列出后被删了,add 时也不会有
      }
      total += size
      if (size > maxFile || total > maxTotal) return { reason: 'too_large' }
    }
    dir = mkdtempSync(join(opts.tmpDir ?? tmpdir(), 'mffai-snap-'))
    const index = join(dir, 'index')
    const env = { GIT_INDEX_FILE: index }
    // 复制用户索引(复用 stat 缓存,不用重新哈希全部文件);没有索引 → 从 HEAD 读;没有 HEAD → 空索引
    if (lexists(join(gitDir, 'index'))) copyFileSync(join(gitDir, 'index'), index)
    else if (head) await run(git, ['read-tree', head], { cwd: top, env })
    await run(git, ['add', '-A', '--', scope(prefix)], { cwd: top, env })
    const tree = (await run(git, ['write-tree'], { cwd: top, env })).toString().trim()
    const commitArgs = ['commit-tree', '--no-gpg-sign', '-m', 'mff-ai snapshot', ...(head ? ['-p', head] : []), tree]
    const commit = (await run(git, commitArgs, { cwd: top })).toString().trim()
    await run(git, ['update-ref', ref, commit], { cwd: top })
    return { ref }
  } catch {
    return { reason: 'error' }
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
}

const STATUSES = new Set(['A', 'M', 'D', 'T'])

/** from..to 之间 cwd 前缀下变化的文件(路径相对仓库根,`/` 分隔) */
export async function changes(cwd: string, from: string, to: string, git: Git): Promise<FileChange[]> {
  const info = await repoInfo(cwd, git)
  if (!info) throw new Error(`不是 git 工作树:${cwd}`)
  const parts = splitZ(
    await run(git, ['diff', '--name-status', '--no-renames', '--no-ext-diff', '-z', from, to, '--', scope(info.prefix)], { cwd: info.top }),
  )
  const out: FileChange[] = []
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = parts[i][0]
    if (!STATUSES.has(status)) throw new Error(`未知的改动状态:${parts[i]}`)
    out.push({ path: parts[i + 1], status: status as FileChange['status'] })
  }
  return out
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

/** `cat-file --batch`:一次取出全部 blob(二进制安全) */
async function blobs(git: Git, top: string, shas: string[]): Promise<Map<string, Buffer>> {
  const m = new Map<string, Buffer>()
  const want = [...new Set(shas)]
  if (!want.length) return m
  const out = await run(git, ['cat-file', '--batch'], { cwd: top, input: Buffer.from(want.join('\n') + '\n'), binary: true })
  let off = 0
  for (const sha of want) {
    const nl = out.indexOf(0x0a, off)
    const [got, type, size] = out.subarray(off, nl).toString().split(' ')
    if (got !== sha || type !== 'blob') throw new Error(`读不到对象:${sha}`)
    const n = Number(size)
    m.set(sha, out.subarray(nl + 1, nl + 1 + n))
    off = nl + 1 + n + 1
  }
  return m
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
 * 先从 git 取齐全部内容再动文件;逐个处理,失败的汇总后抛出
 */
export async function restore(cwd: string, from: string, files: FileChange[], git: Git): Promise<void> {
  const info = await repoInfo(cwd, git)
  if (!info) throw new Error(`不是 git 工作树:${cwd}`)
  const realCwd = realpathSync.native(cwd)
  const targets = files.map(f => ({ f, p: target(realCwd, info.top, f.path) }))
  const want = targets.filter(t => t.f.status !== 'A').map(t => t.f.path)
  const ents = await entries(git, info.top, from, want)
  const data = await blobs(
    git,
    info.top,
    [...ents.values()].filter(e => e.mode !== '160000').map(e => e.sha),
  )
  const errors: string[] = []
  // 先删后写:start 里是文件、本轮换成了目录(foo → foo/x)时,删掉 foo/x 之后 foo 才能写回
  const removals = targets.filter(t => t.f.status === 'A' || !ents.has(t.f.path))
  const writes = targets.filter(t => !removals.includes(t))
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
  for (const { f, p } of writes) {
    const e = ents.get(f.path)!
    if (e.mode === '160000') continue // 子模块:不在本仓库的对象里,无法写回
    try {
      mkdirChecked(dirname(p))
      parentStillInside(p, realCwd)
      const buf = data.get(e.sha)!
      if (e.mode === '120000') replaceSymlink(p, buf.toString())
      else replaceFile(p, buf, e.mode === '100755')
    } catch (err) {
      errors.push(`${f.path}: ${(err as Error).message}`)
    }
  }
  if (errors.length) throw new Error(`回滚有 ${errors.length} 个文件失败:\n${errors.join('\n')}`)
}

/** 一个会话(prefixRef 下)只留最近 keepTurns 轮的引用;按提交时间从新到旧,同一轮的 start / end / pre-rollback 算一轮 */
export async function pruneRefs(cwd: string, prefixRef: string, keepTurns: number, git: Git): Promise<void> {
  const base = prefixRef.replace(/\/+$/, '') + '/'
  const out = await run(git, ['for-each-ref', '--sort=-committerdate', '--format=%(refname)', base], { cwd })
  const kept = new Set<string>()
  const drop: string[] = []
  for (const ref of out.toString().split('\n').filter(Boolean)) {
    const turn = ref.slice(base.length).replace(/-(start|end|pre-rollback)$/, '')
    if (kept.has(turn)) continue
    if (kept.size < keepTurns) kept.add(turn)
    else drop.push(ref)
  }
  if (drop.length) await run(git, ['update-ref', '--stdin'], { cwd, input: Buffer.from(drop.map(r => `delete ${r}\n`).join('')) })
}

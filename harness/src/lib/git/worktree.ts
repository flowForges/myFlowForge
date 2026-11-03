// 委派运行的 worktree(04 spec §10):在沙箱外建和删,走 snapshot 那套隔离 git,不跑用户钩子,不动用户的索引、分支、stash
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isInside, OUTSIDE, resolveToolPath } from '../fs/paths'
import { lexists, samePath } from '../fs/safeFs'
import { guarded, repoInfo, type Git, type RepoInfo } from './snapshot'

/** 根下最多保留这么多个;不自动删,可能是用户要的 */
export const MAX_WORKTREES = 20

/** `.git` 文件只有一行路径,再大就不是 git 写的 */
const GIT_FILE_MAX = 8192

export interface WorktreeOpts {
  /** 配置的根:路径不在它下面一律拒绝,按 realpath 判 */
  root: string
  tmpDir?: string
}

function assertUnderRoot(root: string, path: string): void {
  const realRoot = resolveToolPath(root, '.')
  const real = isAbsolute(path) ? resolveToolPath(root, path) : OUTSIDE
  // 只有 <根>/<会话>/<运行> 一种形状:<根>/<会话> 会带走那个会话所有的 worktree
  if (realRoot === OUTSIDE || real === OUTSIDE || !isInside(real, realRoot, process.platform) || relative(realRoot, real).split(sep).length !== 2) {
    throw new Error('worktree path is not under the worktree root')
  }
}

const firstLine = (s: string) => s.split('\n')[0]

/** `git worktree add --detach`。path 可以是空目录(reserveWorktree 占的位) */
export async function addWorktree(repoCwd: string, path: string, commit: string, git: Git, o: WorktreeOpts): Promise<void> {
  assertUnderRoot(o.root, path)
  if (commit.startsWith('-')) throw new Error('bad commit')
  await guarded(git, o.tmpDir, async g => {
    // submodule.recurse 开着时检出会去拉子模块;快照里只有 gitlink,不要
    const r = await g(['-c', 'submodule.recurse=false', 'worktree', 'add', '--detach', path, commit], { cwd: repoCwd })
    if (r.code !== 0) throw new Error(`git worktree add failed (${r.code}): ${firstLine(r.stderr)}`)
  })
}

/**
 * `git worktree remove --force --force`(两次才删得掉 CLI 锁上的)。
 * git 不肯(`.git` 被改过、仓库没了)时直接删目录:路径已确认在根下,rm 不跟随链接;目录没了之后再 remove 一次,清掉自己的条目。
 * 不用 `git worktree prune`:它会带走用户自己指向缺失路径的条目(没插的移动硬盘)
 */
export async function removeWorktree(repoCwd: string, path: string, git: Git, o: WorktreeOpts): Promise<void> {
  assertUnderRoot(o.root, path)
  await guarded(git, o.tmpDir, async g => {
    const remove = async () => {
      try {
        return (await g(['worktree', 'remove', '--force', '--force', path], { cwd: repoCwd })).code === 0
      } catch {
        return false // repoCwd 不在了
      }
    }
    if (await remove()) return
    rmSync(path, { recursive: true, force: true })
    await remove()
  })
  try {
    rmdirSync(dirname(path))
  } catch {
    // 还有别的运行,或者删不了:不影响结果
  }
}

/**
 * 根和会话的仓库不能重叠:否则运行的可写根盖得到别的 worktree,快照把它们当嵌套仓库收进去,用户 `git status` 也看得见。
 * 根不存在也能判,按 realpath
 */
export function rootConflict(root: string, repo: Pick<SessionRepo, 'top' | 'commonDir'>, cwd: string): boolean {
  const real = resolveToolPath(root, '.')
  if (real === OUTSIDE) return true
  const inside = (a: string, b: string) => isInside(a, b, process.platform)
  return inside(real, repo.top) || inside(real, repo.commonDir) || inside(resolveToolPath(cwd, '.'), real)
}

/**
 * 删掉 worktree 里 `deny read` 根的副本。根的父目录中途是链接就不动(返回它):CLI 种的链接不能让我们删到外面去。
 * 只管严格在 worktree 里面的根;末段是链接时 rm 只删链接
 */
export function removeInWorktree(path: string, roots: string[]): string[] {
  const refused: string[] = []
  for (const root of roots) {
    if (root === path || !isInside(root, path, process.platform)) continue
    const parent = dirname(root)
    try {
      if (!samePath(realpathSync.native(parent), parent)) {
        refused.push(root)
        continue
      }
    } catch {
      if (!lexists(parent)) continue // 副本本来就不在
      refused.push(root)
      continue
    }
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      refused.push(root)
    }
  }
  return refused
}

/**
 * 占位:`<根>/<sessionId>/<runId>`,0700,根按 realpath(沙箱和 Codex 的权限档都要真实路径)。
 * 已有 MAX_WORKTREES 个 → undefined。同步完成:并发的运行不会一起超过上限
 */
export function reserveWorktree(root: string, sessionId: string, runId: string, max = MAX_WORKTREES): string | undefined {
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const real = realpathSync(root)
  const path = join(real, sessionId, runId)
  assertUnderRoot(real, path)
  let count = 0
  for (const s of readdirSync(real, { withFileTypes: true })) {
    if (s.isDirectory()) count += readdirSync(join(real, s.name), { withFileTypes: true }).filter(e => e.isDirectory()).length
  }
  if (count >= max) return undefined
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  mkdirSync(path, { mode: 0o700 })
  return path
}

export interface SessionRepo extends RepoInfo {
  commonDir: string
}

/** cwd 所在仓库,外加共用的 git 目录(cwd 本身可能就是一个 linked worktree);不在仓库里 → undefined */
export async function sessionRepo(cwd: string, git: Git, opts: { tmpDir?: string } = {}): Promise<SessionRepo | undefined> {
  const info = await repoInfo(cwd, git, opts)
  if (!info) return undefined
  const line = await guarded(git, opts.tmpDir, async g => {
    const r = await g(['rev-parse', '--git-common-dir'], { cwd })
    return r.code === 0 ? firstLine(r.stdout.toString()) : ''
  })
  if (!line || line.startsWith('-')) return undefined
  return { ...info, commonDir: realpathSync.native(resolve(cwd, line)) }
}

/**
 * worktree 运行只读的 git 目录:共用的那个整个,外加会话自己的(会话是 linked worktree 时)。
 * 05 把它们算作可写根;列举写不完(objects、shallow、rebase-merge、别的 worktree 的 HEAD……都伤得到用户)。
 * 代价:沙箱里的 CLI 在 worktree 里 add、commit 不了,与 Codex 一样;改动靠快照 diff 拿到
 */
export function userGitState(repo: Pick<SessionRepo, 'commonDir' | 'gitDir'>): string[] {
  return repo.gitDir === repo.commonDir ? [repo.commonDir] : [repo.commonDir, repo.gitDir]
}

/**
 * 沙箱外对 worktree 跑 git 之前:它的 `.git` 还是我们建的那个,而且指回这个仓库;path 和 cwd 之间没有新冒出来的 `.git`。
 * 否则 git 会认 CLI 准备的仓库,里面配置的 clean 过滤器就在沙箱外跑了
 */
export async function worktreeIntact(repoCwd: string, path: string, cwd: string, git: Git, opts: { tmpDir?: string } = {}): Promise<boolean> {
  try {
    const file = join(path, '.git')
    const st = lstatSync(file)
    if (!st.isFile() || st.size > GIT_FILE_MAX) return false
    for (let d = cwd; d !== path; d = dirname(d)) {
      if (d === dirname(d) || !isInside(d, path, process.platform)) return false
      if (lexists(join(d, '.git'))) return false
    }
    const m = /^gitdir: (.+)\n?$/.exec(readFileSync(file, 'utf8'))
    if (!m) return false
    const repo = await sessionRepo(repoCwd, git, opts)
    if (!repo) return false
    // 两个文件都可能是相对路径(worktree.useRelativePaths)
    const admin = realpathSync.native(resolve(path, m[1]))
    if (!samePath(dirname(admin), realpathSync.native(join(repo.commonDir, 'worktrees')))) return false
    if (!samePath(realpathSync.native(resolve(admin, readFileSync(join(admin, 'commondir'), 'utf8').trim())), repo.commonDir)) return false
    return samePath(realpathSync.native(resolve(admin, readFileSync(join(admin, 'gitdir'), 'utf8').trim())), realpathSync.native(file))
  } catch {
    return false
  }
}

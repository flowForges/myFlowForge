// 委派运行的 worktree(04 spec §10):在沙箱外建和删,走 snapshot 那套隔离 git,不跑用户钩子,不动用户的索引、分支、stash
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
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
  if (realRoot === OUTSIDE || real === OUTSIDE || !isInside(real, realRoot, process.platform) || real === realRoot) {
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
 * `git worktree remove --force --force`(两次才删得掉 CLI 锁上的),再 prune。
 * git 不肯(`.git` 被改过、仓库没了)时直接删目录:路径已确认在根下,rm 不跟随链接。
 * 目录还在才算失败;同时把它留在里面的空 session 目录清掉
 */
export async function removeWorktree(repoCwd: string, path: string, git: Git, o: WorktreeOpts): Promise<void> {
  assertUnderRoot(o.root, path)
  await guarded(git, o.tmpDir, async g => {
    const quiet = async (args: string[]) => {
      try {
        return (await g(args, { cwd: repoCwd })).code === 0
      } catch {
        return false // repoCwd 不在了
      }
    }
    if (lexists(path)) {
      const removed = await quiet(['worktree', 'remove', '--force', '--force', path])
      if (!removed || lexists(path)) rmSync(path, { recursive: true, force: true })
    }
    await quiet(['worktree', 'prune'])
  })
  try {
    rmdirSync(dirname(path))
  } catch {
    // 还有别的运行,或者删不了:不影响结果
  }
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
  if (dirname(dirname(path)) !== real) throw new Error('worktree path is not under the worktree root')
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
 * worktree 运行不该写到的用户状态。沙箱把整个共用 git 目录算作可写根(05),`git stash`、`git branch -f` 在 worktree 里
 * 写的都是这些。objects 和 worktrees/<id> 不在内:worktree 的游离 HEAD 上提交用不到别的
 */
export function userGitState(repo: Pick<SessionRepo, 'commonDir' | 'gitDir'>): string[] {
  const common = ['HEAD', 'index', 'packed-refs', 'refs', 'logs/HEAD', 'logs/refs'].map(p => join(repo.commonDir, p))
  const own = repo.gitDir === repo.commonDir ? [] : ['HEAD', 'index', 'logs/HEAD'].map(p => join(repo.gitDir, p))
  return [...common, ...own]
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
    return samePath(realpathSync.native(resolve(admin, readFileSync(join(admin, 'gitdir'), 'utf8').trim())), realpathSync.native(file))
  } catch {
    return false
  }
}

// IM 会话的 worktree(07 spec §8.1):一条 IM 消息是一条远程提示,会话的 cwd 本身就得是 worktree。
// 基于 HEAD,不基于快照:没提交的改动和未跟踪的文件不进远程会话。建不了就失败,绝不退回在地。渠道中立,给 1b 复用
import { lstatSync, mkdirSync, readdirSync, realpathSync, rmdirSync } from 'node:fs'
import { basename, dirname, join, relative, sep } from 'node:path'
import { isInside, OUTSIDE, resolveToolPath } from '../fs/paths'
import { lexists } from '../fs/safeFs'
import { guarded, hasUnsafeFilter, pinnedGit, pinRepo, repoPrefix, type Git, type PinnedRepo, type RepoPin } from './snapshot'
import { addWorktree, MAX_WORKTREES, removeInWorktree, removeWorktree, reserveWorktree, rootConflict, worktreePin, worktreeRootOf } from './worktree'

/** 和 04 的根分开:rootConflict 拒绝 cwd 在那个根里的会话,名额也不互相挤占 */
export const imWorktreeRootOf = (dataDir: string) => `${dataDir}-im-worktrees`

export type ImWorktreeError = 'not_git' | 'no_commits' | 'unsafe_repo' | 'root_conflict' | 'worktree_limit' | 'worktree_failed'

export type ImWorktreeResult = { ok: true; id: string; path: string; cwd: string; top: string } | { ok: false; error: ImWorktreeError }

/**
 * IM 会话不该读到的用户检出(07 §8.1):建 worktree 的那个项目的顶层(建的时候记下的,linked worktree、子模块、独立 git 目录从 common 目录都推不出来),
 * 以及 common 目录推得出来的主检出(旧会话没有记录时也靠它)。worktree 只基于 HEAD,未跟踪的 `.env` 只在这些地方
 */
export function imHiddenTops(pin: RepoPin | undefined, projectTop: string | undefined): string[] {
  if (pin?.kind !== 'repo') return []
  const main = basename(pin.commonDir) === '.git' ? dirname(pin.commonDir) : undefined
  return [...new Set([projectTop, main])].filter((t): t is string => t !== undefined && t !== dirname(t))
}

/** cwd 真的在 IM 根下的某个 worktree 里(<根>/<聊天>/<id> 或更深)。两边都按 realpath:数据目录在链接下时,字符串比较会悄悄走 04 的嵌套 worktree */
export function isImCwd(dataDir: string, cwd: string): boolean {
  const root = resolveToolPath(imWorktreeRootOf(dataDir), '.')
  const real = resolveToolPath(cwd, '.')
  if (root === OUTSIDE || real === OUTSIDE || !isInside(real, root, process.platform)) return false
  return relative(root, real).split(sep).filter(Boolean).length >= 2
}

/** group、id 拼进路径,只收单独一段 */
const SEGMENT = /^[A-Za-z0-9_-]+$/

/** cwd 在 worktree 里的位置;HEAD 里没有就建,落到树外面(HEAD 里那一段是链接)就抛 */
function enter(pin: PinnedRepo, path: string, project: string): string {
  const cwd = join(path, repoPrefix(pin, realpathSync.native(project)))
  // 在沙箱外建目录:先看最深的已有祖先,HEAD 里的链接或模型换进来的链接不能让目录建到树外面。悬空链接算已有,realpath 抛错
  let existing = cwd
  while (!lexists(existing)) existing = dirname(existing)
  if (!isInside(realpathSync.native(existing), path, process.platform)) throw new Error('worktree cwd left the worktree')
  mkdirSync(cwd, { recursive: true })
  const real = realpathSync.native(cwd)
  if (!isInside(real, path, process.platform)) throw new Error('worktree cwd left the worktree')
  return real
}

export interface CreateImWorktreeOpts {
  dataDir: string
  /** 项目路径,调用方已过 validateCwd(内核的环境快照,这里没有) */
  project: string
  /** c<聊天哈希> */
  group: string
  /** wt_<updateId>:worktree 不在内核回执里,重投的 /project 靠它认出已建的那个 */
  id: string
  git: Git
  tmpDir: string
  untrusted: string[]
  /** 沙箱写得到的其他根(系统临时目录、~/.qoder,见 loop-default 的 writableRootsFor):过滤器落在里面就不跑。数据目录和两个 worktree 根这里自己算 */
  writableRoots: string[]
  /** 这棵 worktree 里 `deny read` 根的副本。worktree 路径要预留之后才有,所以是回调 */
  denyReadOf(path: string, top: string): string[]
}

export async function createImWorktree(o: CreateImWorktreeOpts): Promise<ImWorktreeResult> {
  const { dataDir, project, group, id, git, tmpDir } = o
  const fail = (error: ImWorktreeError): ImWorktreeResult => ({ ok: false, error })
  if (!SEGMENT.test(group) || !SEGMENT.test(id)) return fail('worktree_failed')
  const root = imWorktreeRootOf(dataDir)
  const otherRoot = worktreeRootOf(dataDir)
  let path: string | undefined
  let repo: PinnedRepo | undefined
  try {
    const pin = await pinRepo(project, git, { tmpDir, untrusted: [...o.untrusted, root, otherRoot] })
    if (pin.kind === 'none') return fail('not_git')
    repo = pin
    const inPin = <T>(fn: (g: Git) => Promise<T>) => guarded(pinnedGit(git, pin), tmpDir, fn)
    const head = await inPin(g => g(['rev-parse', '--verify', '-q', 'HEAD^{commit}'], { cwd: pin.top }))
    const sha = head.code === 0 ? head.stdout.toString().trim() : ''
    if (!sha) return fail('no_commits')
    if (rootConflict(root, pin, project)) return fail('root_conflict')
    // 基于 HEAD 跳过了快照那道检查;检出时 smudge 在沙箱外跑,由一条远程消息触发
    if (await inPin(g => hasUnsafeFilter(g, pin, [dataDir, root, otherRoot, tmpDir, ...o.writableRoots]))) return fail('unsafe_repo')

    const existing = held(root, group, id, pin)
    if (existing === 'foreign') return fail('worktree_failed')
    if (existing && existing !== 'empty') {
      // 崩溃可能发生在删副本之前
      removeInWorktree(existing.path, o.denyReadOf(existing.path, pin.top))
      return { ok: true, id, path: existing.path, cwd: enter(pin, existing.path, project), top: pin.top }
    }
    // 空占位是上次崩溃留下的:删掉,下面照常占(名额照常算)。同一 id 的并发由 chats 的运行器排队
    if (existing === 'empty') rmdirSync(join(realpathSync.native(root), group, id))
    path = reserveWorktree(root, group, id, MAX_WORKTREES)
    if (!path) return fail('worktree_limit')
    await addWorktree(pin, path, sha, git, { tmpDir, root })
    removeInWorktree(path, o.denyReadOf(path, pin.top))
    return { ok: true, id, path, cwd: enter(pin, path, project), top: pin.top }
  } catch {
    if (path) await cleanup(root, path, repo, git, tmpDir)
    return fail('worktree_failed')
  }
}

/** 已有的 <根>/<group>/<id>:没有、崩溃留下的空占位、就是这个项目的 worktree,还是别的东西(不用也不删) */
function held(root: string, group: string, id: string, pin: PinnedRepo): undefined | 'empty' | 'foreign' | { path: string } {
  let real: string
  let isDir: boolean
  try {
    real = join(realpathSync.native(root), group, id)
    isDir = lstatSync(real).isDirectory() // 链接不算目录,不跟随
  } catch {
    return undefined
  }
  if (!isDir) return 'foreign'
  if (readdirSync(real).length === 0) return 'empty'
  // `.git` 要指回这个项目的 common 目录
  return worktreePin(pin, real, real) ? { path: real } : 'foreign'
}

/** 预留之后的失败:占位、git 条目都不留。根空了也不留 */
async function cleanup(root: string, path: string, pin: RepoPin | undefined, git: Git, tmpDir: string): Promise<void> {
  try {
    await removeWorktree(pin, path, git, { tmpDir, root })
    rmdirSync(realpathSync.native(root))
  } catch {
    // 根里还有别的,或者删不了:启动时的对账会收拾(§8.1)
  }
}

export interface RemoveImWorktreeOpts {
  dataDir: string
  path: string
  /** 项目的钉子,或会话的(链接形态):都能找到 common 目录 */
  pin: RepoPin | undefined
  git: Git
  tmpDir: string
}

export function removeImWorktree(o: RemoveImWorktreeOpts): Promise<void> {
  return removeWorktree(o.pin, o.path, o.git, { tmpDir: o.tmpDir, root: imWorktreeRootOf(o.dataDir) })
}

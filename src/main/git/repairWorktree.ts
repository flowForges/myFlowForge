import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { git } from './gitRunner'

/**
 * 「删掉 ~/.myFlowForge 之后工作区里所有项目的 git 全失效」的检测与就地修复。
 *
 * 病因:每个项目目录都是 `~/.myFlowForge/repos/<id>.git` 这个 bare mirror 的 **git worktree** ——
 * 项目里的 `.git` 是一个**文件**,内容是 `gitdir: <mirror>/worktrees/<name>`。真正的仓库(对象库、
 * refs、HEAD)在工作区**之外**。删掉 ~/.myFlowForge,这个指针就悬空:文件都在,git 没了
 * (`fatal: not a git repository: …`)。重装 app 也不会重建它。
 *
 * 更糟的是重新添加工作区也救不回来 —— 拉取守卫只判断 `.git` **存不存在**(见 workspaceSetup),
 * 而悬空的 `.git` 文件仍然存在,于是被当成"这里已经有仓库了"直接跳过。
 * (不幸中的万幸:也正因为跳过了,addWorktree 开头那句 rmSync 没有执行,用户的文件才没被删。)
 *
 * 修复策略 = 就地重建成一个**普通仓库**:git init → 加回 origin → fetch → reset --mixed origin/<base>。
 * `--mixed` 只重置索引与 HEAD,**一个工作区文件都不碰**,所以用户未提交的改动会原样保留,
 * 只是从"git 不认识"变回"已修改"。
 *
 * ⚠️ 找不回来的只有**本地 commit**:那些 commit 对象只存在于被删掉的 mirror 里。
 * 已推送到远端的、以及磁盘上的文件内容,都能完整恢复。
 */

export type RepoHealth =
  /** 一切正常。 */
  | { state: 'ok' }
  /** 压根不是 git 仓库(没有 .git),不属于本模块要修的情况。 */
  | { state: 'not-a-repo' }
  /** .git 是个指向已消失的 gitdir 的悬空指针 —— 正是本模块要修的病。 */
  | { state: 'dangling'; gitdir: string }
  /** 有 .git 但 git 就是用不了,原因未知(权限/损坏)。不自动修,交给用户。 */
  | { state: 'broken'; detail: string }

/** 从 `.git` 文件里读出 `gitdir: <path>`。`.git` 是目录(普通仓库)时返回 null。 */
export function readGitdirPointer(cwd: string): string | null {
  const dot = join(cwd, '.git')
  try {
    if (!statSync(dot).isFile()) return null
    const m = readFileSync(dot, 'utf8').match(/^\s*gitdir:\s*(.+?)\s*$/m)
    return m ? m[1] : null
  } catch { return null }
}

/** 单个项目目录的 git 健康检查。不写盘。 */
export async function diagnoseRepo(cwd: string): Promise<RepoHealth> {
  if (!existsSync(join(cwd, '.git'))) return { state: 'not-a-repo' }
  try {
    await git(['rev-parse', '--git-dir'], { cwd })
    return { state: 'ok' }
  } catch (e) {
    const gitdir = readGitdirPointer(cwd)
    // 悬空的判定要"证据确凿"才认:.git 是文件、指向一个具体路径、而那个路径确实不存在。
    if (gitdir && !existsSync(gitdir)) return { state: 'dangling', gitdir }
    return { state: 'broken', detail: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * 「这里已经有一个可用的 git 仓库了,别去重新拉取覆盖它」。
 *
 * 拉取守卫写的是 `existsSync(join(path, name, '.git'))` —— 只判断存不存在。悬空的 worktree 里
 * `.git` 文件**仍然存在**,于是被当成健康仓库跳过重建,用户怎么重新添加工作区都好不了。
 *
 * ⚠️ 但**绝不能**因此把守卫改成「无效就去重建」:addWorktree 开头有一句无条件的
 * `rmSync(worktreePath)`,那会**连同用户几天的代码一起删掉**。正确做法是守卫依旧跳过(保住文件),
 * 另外走 repairDanglingRepo 就地修复。本函数只用于**判断/上报**,不用于决定要不要重新拉取。
 */
export async function hasUsableRepo(dir: string): Promise<boolean> {
  return (await diagnoseRepo(dir)).state === 'ok'
}

export interface RepairArgs {
  cwd: string
  repoUrl: string
  /** 远端基线分支(origin/<base>),用来 reset。 */
  baseBranch: string
  /** 本地分支名。缺省用 Forge 的命名约定 forge/<目录名>。 */
  branch?: string
  proxy?: string
}
export type RepairResult =
  | { ok: true; branch: string; baseBranch: string }
  | { ok: false; error: string }

/**
 * 就地修复一个悬空的 worktree。**只在 diagnoseRepo 判定为 dangling 时调用** ——
 * 对健康仓库执行会白白丢掉它原本的 git 元数据。
 */
export async function repairDanglingRepo(args: RepairArgs): Promise<RepairResult> {
  const { cwd, repoUrl, proxy } = args
  if (!repoUrl.trim()) return { ok: false, error: '缺少仓库地址,无法恢复(工作区配置里没有 repoUrl)' }

  const health = await diagnoseRepo(cwd)
  if (health.state === 'ok') return { ok: false, error: '这个项目的 git 是正常的,无需修复' }
  if (health.state !== 'dangling') return { ok: false, error: '不是「指针悬空」这种情况,不做自动修复以免弄坏现场' }

  const name = cwd.split(/[/\\]/).filter(Boolean).pop() || 'project'
  const branch = args.branch?.trim() || `forge/${name}`
  const base = args.baseBranch.trim() || 'main'

  try {
    // 只删那个悬空的指针文件。工作区里的代码一律不碰。
    rmSync(join(cwd, '.git'), { force: true })
    await git(['init', '-b', branch, '.'], { cwd })
    await git(['remote', 'add', 'origin', repoUrl], { cwd })
    await git(['fetch', 'origin'], { cwd, proxy })
    // --mixed:重置索引 + HEAD,工作区文件不动 → 用户这几天的改动全部保留为「已修改」
    try {
      await git(['reset', '--mixed', `origin/${base}`], { cwd })
    } catch {
      // 基线分支名对不上(改过默认分支等)时退到 FETCH_HEAD,总比留个空 HEAD 强。
      await git(['reset', '--mixed', 'FETCH_HEAD'], { cwd })
    }
    // 上游必须在 reset **之后**设 —— 之前这个分支还没有任何提交,set-upstream 会失败。
    await git(['branch', `--set-upstream-to=origin/${base}`, branch], { cwd }).catch(() => {})
    return { ok: true, branch, baseBranch: base }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

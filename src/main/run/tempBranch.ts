import { git } from '../git/gitRunner'

/**
 * Git orchestration for a workflow run's local temp branch.
 *
 * Design: each run writes code on a local branch `forge/run-<runId>` branched
 * off the project's configured target branch. Only after the whole run finishes
 * and the user confirms does it merge back to the target branch (--no-ff, so the
 * run's history stays visible as a single mergeable unit); a discarded run (the
 * finalize gate's 丢弃本次) deletes the temp branch and the target stays clean.
 *
 * An ABORTED run (mid-run 终止, or 终止 while parked at the finalize gate) is
 * different: per product decision it PARKS instead of discarding — the agent's
 * in-progress work is committed onto the temp branch (kept, not deleted) and the
 * target is simply checked back out clean, so the work stays recoverable on
 * `forge/run-<runId>` instead of being destroyed (see parkTempBranch below).
 *
 * A user may start a run with an already-dirty working tree. The temp branch is
 * created off `base` with `checkout -b` (which carries the dirty tree along —
 * git only refuses that when it would overwrite work, not when switching to a
 * brand-new branch), then immediately committed as a "pre-run snapshot" on the
 * temp branch (see createTempBranch below) so stage agents can actually read the
 * code the user just wrote, instead of it being stashed away out of sight.
 *
 * This module is pure git orchestration — no engine wiring here (see P4-2/P4-3).
 */

export type GitRunner = (cwd: string, args: string[]) => Promise<string>

const defaultGitRunner: GitRunner = (cwd, args) => git(args, { cwd })

export function tempBranchName(runId: string): string {
  return `forge/run-${runId}`
}

function readableGitError(action: string, err: unknown): Error {
  const detail = err instanceof Error ? err.message : String(err)
  return new Error(`${action}: ${detail}`)
}

/**
 * True iff `cwd`'s working tree is clean — `git status --porcelain` empty output.
 *
 * createRunTempBranches no longer gates on this (a dirty tree is the normal, supported path — see
 * createTempBranch's pre-run snapshot below). Kept for callers that just want to know, read-only —
 * currently unused in production (Task 8 replaced the launch gate's dirty-tree notice with
 * run2Handlers.ts's run2:base-info, which counts dirty lines itself via `git status --porcelain`
 * rather than calling this); left exported since it's still exercised directly in tests and is a
 * reasonable public primitive for future callers.
 */
export async function isCleanTree(cwd: string, run: GitRunner = defaultGitRunner): Promise<boolean> {
  const status = await run(cwd, ['status', '--porcelain'])
  return status.trim().length === 0
}

/**
 * 该工作树**当前实际所在**的分支名。不猜、不回落到任何存盘的分支字段。
 *
 * 这正是 2026-08-17 那个 bug 的修法：运行分支原先以工作区创建时存下的 ws.projects[].branch 为基准，
 * 而那个字段在用户切分支后从不回写，于是「在 branch1 上开发」的用户被从 main 切出去、又被合回 main。
 *
 * Task 8 审查修正：以前这里 try/catch 把「detached HEAD」和「读不出来」两种完全不同的情况一起归一成
 * ''，调用方（createRunTempBranches）没法分辨，只能一律说「detached HEAD，请 git switch」——对一个
 * 项目目录压根不存在、或不是 git 仓库的用户，这是指错了的指令。现在只有 detached HEAD（git 回字面量
 * "HEAD"）才归一成 ''；其它一切失败（目录不存在、不是仓库、git 未装、权限不足……）原样往外抛，让调用
 * 方拿到真实的 git 报错自己措辞，而不是被这个函数的归一动作提前抹平。
 */
export async function currentBranch(cwd: string, run: GitRunner = defaultGitRunner): Promise<string> {
  const out = (await run(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  return out === 'HEAD' ? '' : out
}

/**
 * 建 run 的临时分支，并把用户**未提交的改动**原样带进来。
 *
 * 旧做法是先 `git stash` 把用户的改动藏走，让 temp 分支从干净树长出来 —— 代价是阶段 agent
 * 根本读不到用户刚写的逻辑（用户实测反馈的正是这条）。现在改成：脏树天然被 `checkout -b`
 * 带过来，随即在 temp 分支上提交成一个「运行前快照」。这样 agent 读得到，且这份快照有了
 * 一个稳定的 commit 副本 —— 后续 discard/park 的 `checkout -f`/`clean -fd` 再怎么清，
 * 用户的改动都还在 `snapshotSha` 这个提交里，靠 restoreSnapshotDetailed 一字不差地还原回去。
 *
 * 快照提交的 parent 恒等于 `base` 当时的 HEAD，这是 restoreSnapshotDetailed 的 cherry-pick 能干净
 * 应用的前提。工作树本来就干净时不产生任何提交，snapshotSha 为 null。
 */
export interface TempBranchCreated {
  branch: string
  /** 运行前快照提交的 SHA；启动时工作树干净则为 null。 */
  snapshotSha: string | null
}

export async function createTempBranch(
  cwd: string,
  base: string,
  runId: string,
  run: GitRunner = defaultGitRunner
): Promise<TempBranchCreated> {
  const branch = tempBranchName(runId)
  try {
    await run(cwd, ['checkout', '-b', branch, base])
  } catch (err) {
    throw readableGitError(`Failed to create temp branch "${branch}" from base "${base}"`, err)
  }
  try {
    await run(cwd, ['add', '-A'])
    const status = await run(cwd, ['status', '--porcelain'])
    if (status.trim().length === 0) return { branch, snapshotSha: null }
    await run(cwd, ['commit', '-m', 'forge: 运行前快照'])
    const sha = (await run(cwd, ['rev-parse', 'HEAD'])).trim()
    return { branch, snapshotSha: sha }
  } catch (err) {
    throw readableGitError(`Failed to commit pre-run snapshot onto temp branch "${branch}"`, err)
  }
}

/**
 * 合并临时分支失败（绝大多数是冲突）。带上渲染层拼「可直接粘贴的手工合并命令」所需要的一切，
 * 免得 UI 去正则抠一句 git 的英文报错。
 */
export class TempBranchMergeError extends Error {
  constructor(
    message: string,
    readonly conflictFiles: string[],
    readonly tempBranch: string,
    readonly target: string,
  ) {
    super(message)
    this.name = 'TempBranchMergeError'
  }
}

/** Checkout `target`, merge the temp branch in with --no-ff, then delete the temp branch. */
export async function mergeTempBranch(
  cwd: string,
  target: string,
  runId: string,
  run: GitRunner = defaultGitRunner
): Promise<void> {
  const branch = tempBranchName(runId)
  // The agent(s) wrote their changes into the working tree while checked out on `branch` —
  // nothing has committed them yet (createTempBranch/agents only ever `checkout -b`/edit files).
  // Commit them onto the temp branch HERE, BEFORE switching away, or the switch to `target` below
  // would carry the uncommitted edits over onto the target's working tree instead of merging real
  // history (the exact bug this function used to have: `checkout target` on a dirty tree "moves"
  // the edits, then `merge` finds temp and target identical → "Already up to date", no merge
  // commit, and the target's working tree is left dirty with the run's changes).
  try {
    await run(cwd, ['add', '-A'])
    // `git status --porcelain` (not diff --cached --quiet's exit-code trick) so this is trivial to
    // drive with a fake GitRunner in unit tests: empty output = clean, anything else = staged work.
    const status = await run(cwd, ['status', '--porcelain'])
    if (status.trim().length > 0) {
      await run(cwd, ['commit', '-m', `forge: run ${runId}`])
    }
  } catch (err) {
    throw readableGitError(`Failed to commit run "${runId}" changes onto temp branch "${branch}"`, err)
  }
  try {
    await run(cwd, ['checkout', target])
  } catch (err) {
    throw readableGitError(`Failed to merge temp branch "${branch}" into target "${target}"`, err)
  }
  try {
    await run(cwd, ['merge', '--no-ff', branch])
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    // 冲突文件必须在 merge --abort **之前**读 —— abort 会把 MERGE_HEAD 和 U(unmerged) 状态一起
    // 清掉，之后 --diff-filter=U 恒空。读失败不阻断（用户拿不到文件清单也还是要看到那句"没丢"）。
    let conflictFiles: string[] = []
    try {
      const out = await run(cwd, ['diff', '--name-only', '--diff-filter=U'])
      conflictFiles = out.split('\n').map((l) => l.trim()).filter(Boolean)
    } catch { /* 拿不到就算了 */ }
    // 把 target 恢复到合并前那个干净提交：绝不把用户的真实仓库留在「合并进行中」的中间态。
    let abortNote = ''
    try {
      await run(cwd, ['merge', '--abort'])
    } catch (abortErr) {
      abortNote = `（且 git merge --abort 也失败，${target} 可能仍处于合并中: ${abortErr instanceof Error ? abortErr.message : String(abortErr)}）`
    }
    // 分支绝不删 —— 本次运行的全部改动都在 branch 上，它现在是唯一副本。
    throw new TempBranchMergeError(`${detail}${abortNote}`, conflictFiles, branch, target)
  }
  try {
    await run(cwd, ['branch', '-D', branch])
  } catch (err) {
    throw readableGitError(`合并后清理临时分支失败 (${branch} → ${target})`, err)
  }
}

/**
 * 把「运行前快照」还原成 target 分支上的**未提交改动**（用户交出去时是什么样，还回来就是什么样）。
 *
 * 调用前提：工作树已经干净（discard 走 `checkout -f` + `clean -fd`，park 走 commit + checkout）。
 * `cherry-pick -n` 只应用不提交，随后 `git reset` 取消暂存 —— 新文件回到未跟踪、改动回到未暂存，
 * 这就是运行前的外观。已知精度损失：运行前**已 staged** 的改动会变成未 staged，内容一字不丢。
 *
 * 快照的 parent 恒等于 target 当时的 HEAD，所以正常情况必然干净应用。cherry-pick 失败的原因不止
 * 「运行期间 target 上有新提交」一种——快照 sha 被 gc 掉、权限、磁盘满、git 本身缺失都会走到这里，
 * 所以失败原因由 restoreSnapshotDetailed 如实带出，不在此处替用户猜测/断言成因。
 */
async function restoreSnapshotDetailed(
  cwd: string,
  snapshotSha: string | null,
  run: GitRunner
): Promise<{ result: 'restored' | 'none' | 'conflict'; detail?: string }> {
  if (!snapshotSha) return { result: 'none' }
  try {
    await run(cwd, ['cherry-pick', '-n', snapshotSha])
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    console.error(`[run2] 还原运行前快照失败 (cherry-pick -n ${snapshotSha}): ${detail}`)
    try {
      await run(cwd, ['cherry-pick', '--abort'])
    } catch (abortErr) {
      const abortDetail = abortErr instanceof Error ? abortErr.message : String(abortErr)
      console.warn(`[run2] cherry-pick --abort 也失败（还原快照 ${snapshotSha} 之后）: ${abortDetail}`)
    }
    return { result: 'conflict', detail }
  }
  await run(cwd, ['reset'])
  return { result: 'restored' }
}

/**
 * Checkout `target` and force-delete the temp branch, discarding all run changes.
 *
 * Uses `checkout -f` (not a plain `checkout`): the agent(s) left uncommitted edits in the working
 * tree on `branch`, and a plain checkout would carry those edits over onto `target`'s working tree
 * instead of discarding them (the exact "discard doesn't discard" bug this function used to have).
 * Force is safe here — createTempBranch's own pre-run snapshot commit leaves the temp branch's tree
 * clean the instant it's created (any pre-existing dirty state is captured in that commit, not left
 * sitting uncommitted), so every uncommitted change present now belongs to this run's own writes and
 * is exactly what the caller asked to discard. If the run's changes were separately committed onto
 * `branch` (e.g. by mergeTempBranch elsewhere), the
 * `branch -D` below drops those commits too since they're never reachable from `target`.
 *
 * `checkout -f` alone is NOT enough, though: it only resets git's modifications to TRACKED files —
 * a brand-new file the agent wrote (never `git add`ed) is untracked, and switching branches leaves
 * untracked files sitting in the working tree untouched (confirmed empirically against real git —
 * see tempBranch.integration.test.ts). `git clean -fd` after the checkout removes exactly those
 * leftover untracked files/dirs, so a NEW file the agent created doesn't survive a discard.
 */
export async function discardTempBranch(
  cwd: string,
  target: string,
  runId: string,
  snapshotSha: string | null = null,
  run: GitRunner = defaultGitRunner
): Promise<void> {
  const branch = tempBranchName(runId)
  try {
    await run(cwd, ['checkout', '-f', target])
    await run(cwd, ['clean', '-fd'])
  } catch (err) {
    throw readableGitError(`Failed to discard temp branch "${branch}" (target "${target}")`, err)
  }
  // 顺序不变式：快照是用户未提交改动的**唯一副本**，它只存在于 branch 上的那个提交里。
  // 还原没成功就把 branch 删了 = 用户的改动被永久销毁。所以 branch -D 必须排在还原之后，
  // 且还原失败时直接抛错、分支原地留着，让用户能手工把它捞回来。
  const { result: restored, detail } = await restoreSnapshotDetailed(cwd, snapshotSha, run)
  if (restored === 'conflict') {
    throw new Error(
      // 具体原因不止「运行期间 target 上有新提交」一种，别替用户断言成因——把 restoreSnapshotDetailed
      // 如实带出的 git 报错原样放在通用说明旁边，用户和后续排查都看得到真实原因。
      `已放弃本次运行的改动，但你运行前那些未提交的改动没能自动还原：${detail}。`
      + `它们完整保存在分支 ${branch} 的提交 ${snapshotSha} 里，没有丢失。`
      + `该分支已为你保留，可执行：git cherry-pick -n ${snapshotSha}`
    )
  }
  try {
    await run(cwd, ['branch', '-D', branch])
  } catch (err) {
    throw readableGitError(`Failed to delete temp branch "${branch}" (target "${target}")`, err)
  }
}

/**
 * Finding 4 (Important — abort semantics), USER DECISION option B (preserve): an ABORTED run must
 * NOT destroy the agent's in-progress work the way discardTempBranch does. Instead: commit whatever
 * is dirty on the temp branch (same commit-before-switch step as mergeTempBranch, so nothing carries
 * over onto `target`'s working tree — see mergeTempBranch's doc for why that matters), then check
 * `target` back out. UNLIKE mergeTempBranch/discardTempBranch, this never merges, never deletes the
 * temp branch, and never runs `clean -fd` — the temp branch (with its commit, if any) is left exactly
 * as-is so the work stays recoverable on `forge/run-<runId>` after the abort.
 */
export async function parkTempBranch(
  cwd: string,
  target: string,
  runId: string,
  snapshotSha: string | null = null,
  run: GitRunner = defaultGitRunner
): Promise<void> {
  const branch = tempBranchName(runId)
  try {
    await run(cwd, ['add', '-A'])
    const status = await run(cwd, ['status', '--porcelain'])
    if (status.trim().length > 0) {
      await run(cwd, ['commit', '-m', `forge: run ${runId} (aborted)`])
    }
  } catch (err) {
    throw readableGitError(`Failed to commit run "${runId}" changes onto temp branch "${branch}" before parking`, err)
  }
  try {
    await run(cwd, ['checkout', target])
  } catch (err) {
    throw readableGitError(`Failed to checkout target "${target}" while parking temp branch "${branch}"`, err)
  }
  // park 从不删分支，所以这里的还原失败不致命：快照就在保留着的 branch 上。只警告，不让一次
  // 终止变成一个带堆栈的失败。
  const { result: restored, detail } = await restoreSnapshotDetailed(cwd, snapshotSha, run)
  if (restored === 'conflict') {
    console.warn(`[run2] ${target}: 运行前快照未能自动还原（${detail}），改动保留在 ${branch} 的 ${snapshotSha}（分支已保留）`)
  }
}

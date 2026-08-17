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
 * createTempBranch's pre-run snapshot below). Kept for callers that just want to know: the launch
 * gate's dirty-tree notice (run2Handlers.ts's run2:check-dirty) uses it read-only, to tell the user
 * up front which projects have uncommitted changes that are about to ride along into the run.
 */
export async function isCleanTree(cwd: string, run: GitRunner = defaultGitRunner): Promise<boolean> {
  const status = await run(cwd, ['status', '--porcelain'])
  return status.trim().length === 0
}

/**
 * 建 run 的临时分支，并把用户**未提交的改动**原样带进来。
 *
 * 旧做法是先 `git stash` 把用户的改动藏走，让 temp 分支从干净树长出来 —— 代价是阶段 agent
 * 根本读不到用户刚写的逻辑（用户实测反馈的正是这条）。现在改成：脏树天然被 `checkout -b`
 * 带过来，随即在 temp 分支上提交成一个「运行前快照」。这样 agent 读得到，且这份快照有了
 * 一个稳定的 commit 副本 —— 后续 discard/park 的 `checkout -f`/`clean -fd` 再怎么清，
 * 用户的改动都还在 `snapshotSha` 这个提交里，靠 restoreSnapshot 一字不差地还原回去。
 *
 * 快照提交的 parent 恒等于 `base` 当时的 HEAD，这是 restoreSnapshot 的 cherry-pick 能干净
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
    // A failed merge (most commonly a conflict) leaves `target`'s working tree mid-merge —
    // MERGE_HEAD set, conflict markers written into the user's real files. Never leave the
    // user's project repo in that state: best-effort abort the merge BEFORE surfacing the
    // error, so `target` is restored to the clean commit it was on pre-merge. If the abort
    // itself fails (e.g. no merge in progress for some other reason), fold that into the
    // error message rather than swallowing it — the caller still needs to know the repo may
    // be in an unexpected state.
    let detail = err instanceof Error ? err.message : String(err)
    try {
      await run(cwd, ['merge', '--abort'])
    } catch (abortErr) {
      const abortDetail = abortErr instanceof Error ? abortErr.message : String(abortErr)
      detail += ` (且 git merge --abort 也失败，目标分支可能仍处于合并中: ${abortDetail})`
    }
    throw readableGitError(`Failed to merge temp branch "${branch}" into target "${target}"`, detail)
  }
  try {
    await run(cwd, ['branch', '-D', branch])
  } catch (err) {
    throw readableGitError(`合并后清理临时分支失败 (${branch} → ${target})`, err)
  }
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
  run: GitRunner = defaultGitRunner
): Promise<void> {
  const branch = tempBranchName(runId)
  try {
    await run(cwd, ['checkout', '-f', target])
    await run(cwd, ['clean', '-fd'])
    await run(cwd, ['branch', '-D', branch])
  } catch (err) {
    throw readableGitError(`Failed to discard temp branch "${branch}" (target "${target}")`, err)
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
}

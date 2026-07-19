import { git } from '../git/gitRunner'

/**
 * Git orchestration for a workflow run's local temp branch.
 *
 * Design: each run writes code on a local branch `forge/run-<runId>` branched
 * off the project's configured target branch. Only after the whole run finishes
 * and the user confirms does it merge back to the target branch (--no-ff, so the
 * run's history stays visible as a single mergeable unit); a discarded/aborted
 * run just deletes the temp branch and the target stays clean.
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

/** Checkout a new temp branch `forge/run-<runId>` off `base`. Returns the branch name. */
export async function createTempBranch(
  cwd: string,
  base: string,
  runId: string,
  git: GitRunner = defaultGitRunner
): Promise<string> {
  const branch = tempBranchName(runId)
  try {
    await git(cwd, ['checkout', '-b', branch, base])
  } catch (err) {
    throw readableGitError(`Failed to create temp branch "${branch}" from base "${base}"`, err)
  }
  return branch
}

/** Checkout `target`, merge the temp branch in with --no-ff, then delete the temp branch. */
export async function mergeTempBranch(
  cwd: string,
  target: string,
  runId: string,
  git: GitRunner = defaultGitRunner
): Promise<void> {
  const branch = tempBranchName(runId)
  try {
    await git(cwd, ['checkout', target])
  } catch (err) {
    throw readableGitError(`Failed to merge temp branch "${branch}" into target "${target}"`, err)
  }
  try {
    await git(cwd, ['merge', '--no-ff', branch])
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
      await git(cwd, ['merge', '--abort'])
    } catch (abortErr) {
      const abortDetail = abortErr instanceof Error ? abortErr.message : String(abortErr)
      detail += ` (且 git merge --abort 也失败，目标分支可能仍处于合并中: ${abortDetail})`
    }
    throw readableGitError(`Failed to merge temp branch "${branch}" into target "${target}"`, detail)
  }
  await git(cwd, ['branch', '-D', branch])
}

/** Checkout `target` and force-delete the temp branch, discarding all run changes. */
export async function discardTempBranch(
  cwd: string,
  target: string,
  runId: string,
  git: GitRunner = defaultGitRunner
): Promise<void> {
  const branch = tempBranchName(runId)
  try {
    await git(cwd, ['checkout', target])
    await git(cwd, ['branch', '-D', branch])
  } catch (err) {
    throw readableGitError(`Failed to discard temp branch "${branch}" (target "${target}")`, err)
  }
}

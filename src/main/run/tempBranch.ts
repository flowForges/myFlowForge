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
    await git(cwd, ['merge', '--no-ff', branch])
  } catch (err) {
    throw readableGitError(`Failed to merge temp branch "${branch}" into target "${target}"`, err)
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

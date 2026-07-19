// src/main/run/tempBranch.integration.test.ts
//
// Real-git integration coverage for tempBranch.ts. The unit tests in tempBranch.test.ts use a
// FAKE GitRunner (bare arg-sequence assertions) and — as a real reviewer discovered empirically —
// that let a critical bug slip past four separate reviews: nothing ever committed the agent's
// working-tree edits, so `discardTempBranch`'s `checkout <target>` actually CARRIED the
// uncommitted changes onto the target branch instead of discarding them, and `mergeTempBranch`
// recorded no history at all. A fake runner can't catch this class of bug — it never actually
// dirties a working tree or asks real git what state the repo ended up in. This file does: a
// throwaway temp repo, the REAL default GitRunner (no injection), real file edits, and assertions
// against real `git status`/`git log`/the real filesystem.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git } from '../git/gitRunner'
import { createTempBranch, mergeTempBranch, discardTempBranch, tempBranchName } from './tempBranch'

// Detected once at collection time (synchronous, so describe.skipIf can use it directly) — if a
// dev/CI box genuinely has no git binary, skip with a clear reason rather than failing every test
// in a way that looks like a code bug.
let gitAvailable = true
try {
  execSync('git --version', { stdio: 'ignore' })
} catch {
  gitAvailable = false
}
if (!gitAvailable) {
  // eslint-disable-next-line no-console
  console.warn('[tempBranch.integration.test] real `git` binary not found on PATH — skipping real-git integration tests.')
}

async function initRepo(): Promise<string> {
  const repo = mkdtempSync(join(tmpdir(), 'tempbranch-it-'))
  await git(['init', '-b', 'main'], { cwd: repo })
  // Repo-local config (not global) so this never depends on / pollutes the machine's real git
  // identity, and disable gpgsign so a dev machine with commit signing forced globally doesn't
  // hang these tests on a signing prompt.
  await git(['config', 'user.email', 'forge-test@example.com'], { cwd: repo })
  await git(['config', 'user.name', 'Forge Test'], { cwd: repo })
  await git(['config', 'commit.gpgsign', 'false'], { cwd: repo })
  writeFileSync(join(repo, 'existing.txt'), 'hello\n')
  await git(['add', '-A'], { cwd: repo })
  await git(['commit', '-m', 'init'], { cwd: repo })
  return repo
}

async function currentBranch(repo: string): Promise<string> {
  return (await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo })).trim()
}
async function porcelainStatus(repo: string): Promise<string> {
  return (await git(['status', '--porcelain'], { cwd: repo })).trim()
}
async function branchExists(repo: string, branch: string): Promise<boolean> {
  const out = await git(['branch', '--list', branch], { cwd: repo })
  return out.trim().length > 0
}

describe.skipIf(!gitAvailable)('tempBranch (real git integration)', () => {
  let repo: string
  beforeEach(async () => { repo = await initRepo() })
  afterEach(() => rmSync(repo, { recursive: true, force: true }))

  it('mergeTempBranch: commits the agent\'s working-tree changes onto the temp branch, then merges a real commit into target — target ends clean, has the file, temp branch is gone', async () => {
    await createTempBranch(repo, 'main', 'run-merge')
    expect(await currentBranch(repo)).toBe(tempBranchName('run-merge'))

    // Simulate the agent writing files on the temp branch — a new file + an edit to an existing one.
    writeFileSync(join(repo, 'new.txt'), 'brand new\n')
    writeFileSync(join(repo, 'existing.txt'), 'hello\nedited by agent\n')

    await mergeTempBranch(repo, 'main', 'run-merge')

    expect(await currentBranch(repo)).toBe('main')
    // The new file must actually be on target...
    expect(existsSync(join(repo, 'new.txt'))).toBe(true)
    expect(readFileSync(join(repo, 'new.txt'), 'utf8')).toBe('brand new\n')
    expect(readFileSync(join(repo, 'existing.txt'), 'utf8')).toContain('edited by agent')
    // ...AS A REAL COMMIT, not an incidental uncommitted working-tree mutation (the bug: target's
    // working tree ends up dirty with the run's edits instead of them landing in history).
    expect(await porcelainStatus(repo)).toBe('')
    const mergeLog = await git(['log', '--merges', '--oneline', '-1'], { cwd: repo })
    expect(mergeLog.trim().length).toBeGreaterThan(0) // a real merge commit exists in target's history
    const fileLog = await git(['log', '--oneline', '--', 'new.txt'], { cwd: repo })
    expect(fileLog.trim().length).toBeGreaterThan(0) // new.txt is actually tracked in history
    expect(await branchExists(repo, tempBranchName('run-merge'))).toBe(false)
  }, 20000)

  it('mergeTempBranch: agent made zero changes — merge still succeeds (no "nothing to commit" error) and target stays clean', async () => {
    await createTempBranch(repo, 'main', 'run-nochange')
    await expect(mergeTempBranch(repo, 'main', 'run-nochange')).resolves.toBeUndefined()
    expect(await currentBranch(repo)).toBe('main')
    expect(await porcelainStatus(repo)).toBe('')
    expect(await branchExists(repo, tempBranchName('run-nochange'))).toBe(false)
  }, 20000)

  it('discardTempBranch: target does NOT get the file, is clean, temp branch is gone — the discard actually discards', async () => {
    await createTempBranch(repo, 'main', 'run-discard')
    writeFileSync(join(repo, 'should-not-survive.txt'), 'oops\n')
    writeFileSync(join(repo, 'existing.txt'), 'hello\nshould also not survive\n')

    await discardTempBranch(repo, 'main', 'run-discard')

    expect(await currentBranch(repo)).toBe('main')
    // Neither the new file NOR the edit to the existing file survives onto target.
    expect(existsSync(join(repo, 'should-not-survive.txt'))).toBe(false)
    expect(readFileSync(join(repo, 'existing.txt'), 'utf8')).toBe('hello\n')
    expect(await porcelainStatus(repo)).toBe('')
    expect(await branchExists(repo, tempBranchName('run-discard'))).toBe(false)
  }, 20000)

  it('abort cleanup (reuses discardTempBranch semantics): target ends clean, no new file, temp branch gone', async () => {
    // Controller.abortCleanup() calls discardTempBranch (or the injected equivalent) directly —
    // there is no separate git codepath for "abort" vs. "discard", by design (see controller.ts's
    // abortCleanup doc). Exercising discardTempBranch here again, framed as the abort scenario,
    // is exactly what that reuse means in practice.
    await createTempBranch(repo, 'main', 'run-abort')
    writeFileSync(join(repo, 'mid-run-work.txt'), 'partial work when aborted\n')

    await discardTempBranch(repo, 'main', 'run-abort')

    expect(await currentBranch(repo)).toBe('main')
    expect(existsSync(join(repo, 'mid-run-work.txt'))).toBe(false)
    expect(await porcelainStatus(repo)).toBe('')
    expect(await branchExists(repo, tempBranchName('run-abort'))).toBe(false)
  }, 20000)

  it('regression: after a discard, a SECOND createTempBranch from target succeeds — no "本地更改未提交" wedge blocking the next run', async () => {
    await createTempBranch(repo, 'main', 'run-a')
    writeFileSync(join(repo, 'leftover.txt'), 'x\n')
    await discardTempBranch(repo, 'main', 'run-a')

    // Before the fix: target's working tree was left dirty (leftover.txt carried over uncommitted),
    // so this next checkout -b would throw "error: Your local changes ... would be overwritten" /
    // "本地更改未提交" (see launch.test.ts:220's pre-existing regression coverage for that symptom).
    await expect(createTempBranch(repo, 'main', 'run-b')).resolves.toBe(tempBranchName('run-b'))
    expect(await currentBranch(repo)).toBe(tempBranchName('run-b'))
    expect(await porcelainStatus(repo)).toBe('')
  }, 20000)
})

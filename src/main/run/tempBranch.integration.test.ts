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
import { createTempBranch, mergeTempBranch, discardTempBranch, isCleanTree, parkTempBranch, tempBranchName, stashRun, popRunStash } from './tempBranch'
import { createRunTempBranches } from './launch'
import type { Workspace } from '../config/schema'

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

  // Finding 4 (Important — abort semantics), USER DECISION option B: abort no longer discards the
  // agent's in-progress work — it PARKS it. This replaces the old "abort cleanup (reuses
  // discardTempBranch semantics)" test, which asserted the pre-fix (data-destroying) behavior.
  it('parkTempBranch (abort): target ends clean and does NOT get the file, but the temp branch is KEPT with a real commit of the work', async () => {
    await createTempBranch(repo, 'main', 'run-abort')
    writeFileSync(join(repo, 'mid-run-work.txt'), 'partial work when aborted\n')
    writeFileSync(join(repo, 'existing.txt'), 'hello\nedited mid-run\n')

    await parkTempBranch(repo, 'main', 'run-abort')

    // Target: clean, no trace of the run's in-progress work.
    expect(await currentBranch(repo)).toBe('main')
    expect(existsSync(join(repo, 'mid-run-work.txt'))).toBe(false)
    expect(readFileSync(join(repo, 'existing.txt'), 'utf8')).toBe('hello\n')
    expect(await porcelainStatus(repo)).toBe('')

    // Temp branch: STILL EXISTS (not deleted) and carries a real commit with the work — recoverable.
    expect(await branchExists(repo, tempBranchName('run-abort'))).toBe(true)
    await git(['checkout', tempBranchName('run-abort')], { cwd: repo })
    expect(existsSync(join(repo, 'mid-run-work.txt'))).toBe(true)
    expect(readFileSync(join(repo, 'mid-run-work.txt'), 'utf8')).toBe('partial work when aborted\n')
    expect(readFileSync(join(repo, 'existing.txt'), 'utf8')).toContain('edited mid-run')
    const parkLog = await git(['log', '--oneline', '-1'], { cwd: repo })
    expect(parkLog).toContain('(aborted)')
    expect(await porcelainStatus(repo)).toBe('') // the park's commit left the temp branch clean too
  }, 20000)

  it('parkTempBranch: agent made zero changes — still checks out target cleanly, temp branch kept with no extra commit', async () => {
    await createTempBranch(repo, 'main', 'run-abort-noop')
    const beforeLog = await git(['log', '--oneline'], { cwd: repo })

    await expect(parkTempBranch(repo, 'main', 'run-abort-noop')).resolves.toBeUndefined()

    expect(await currentBranch(repo)).toBe('main')
    expect(await porcelainStatus(repo)).toBe('')
    expect(await branchExists(repo, tempBranchName('run-abort-noop'))).toBe(true)
    await git(['checkout', tempBranchName('run-abort-noop')], { cwd: repo })
    const afterLog = await git(['log', '--oneline'], { cwd: repo })
    expect(afterLog.trim()).toBe(beforeLog.trim()) // no "nothing to commit" error, no spurious commit
  }, 20000)

  it('isCleanTree: true on a freshly-checked-out repo, false once a tracked edit or untracked file appears', async () => {
    expect(await isCleanTree(repo)).toBe(true)
    writeFileSync(join(repo, 'existing.txt'), 'hello\nedited\n')
    expect(await isCleanTree(repo)).toBe(false)
    await git(['checkout', '--', 'existing.txt'], { cwd: repo })
    expect(await isCleanTree(repo)).toBe(true)
    writeFileSync(join(repo, 'untracked.txt'), 'new\n')
    expect(await isCleanTree(repo)).toBe(false)
  }, 20000)
})

describe.skipIf(!gitAvailable)('createRunTempBranches dirty-tree stash + restore (real git)', () => {
  let repoA: string
  let repoB: string
  beforeEach(async () => {
    repoA = await initRepo()
    repoB = await initRepo()
  })
  afterEach(() => {
    rmSync(repoA, { recursive: true, force: true })
    rmSync(repoB, { recursive: true, force: true })
  })

  function fixtureWs(): Workspace {
    return {
      name: 'pay', path: '/irrelevant', workflowId: '', stages: [],
      workflows: [],
      projects: [
        { repoId: 'api', name: 'api', branch: 'main' },
        { repoId: 'web', name: 'web', branch: 'main' },
      ] as any,
      status: 'idle', plugins: [], stepPlugins: [],
    } as any
  }

  it('a pre-existing UNTRACKED file is STASHED (not rejected): the run proceeds and every project gets its temp branch', async () => {
    writeFileSync(join(repoB, 'unrelated-untracked.txt'), 'not part of this run\n')

    const res = await createRunTempBranches(
      fixtureWs(),
      [{ name: 'api', cwd: repoA }, { name: 'web', cwd: repoB }],
      'run-dirty',
    )

    expect(res.stashed).toEqual(['web'])                                    // the dirty project was stashed
    expect(await branchExists(repoA, tempBranchName('run-dirty'))).toBe(true)
    expect(await branchExists(repoB, tempBranchName('run-dirty'))).toBe(true)
    expect(await currentBranch(repoB)).toBe(tempBranchName('run-dirty'))
    // During the run the user's untracked file is stashed away (clean tree); it's restored at finalize.
    expect(existsSync(join(repoB, 'unrelated-untracked.txt'))).toBe(false)
    expect(await porcelainStatus(repoB)).toBe('')
  }, 20000)

  it('a pre-existing TRACKED-FILE edit is STASHED too: the run proceeds, the edit set aside (restored at finalize)', async () => {
    writeFileSync(join(repoA, 'existing.txt'), 'hello\nunrelated pending edit\n')

    const res = await createRunTempBranches(
      fixtureWs(),
      [{ name: 'api', cwd: repoA }, { name: 'web', cwd: repoB }],
      'run-dirty2',
    )

    expect(res.stashed).toEqual(['api'])
    expect(await branchExists(repoA, tempBranchName('run-dirty2'))).toBe(true)
    // The edit is stashed → the temp branch's tree is clean; it comes back at finalize (see cycle tests).
    expect(await porcelainStatus(repoA)).toBe('')
    expect(readFileSync(join(repoA, 'existing.txt'), 'utf8')).not.toContain('unrelated pending edit')
  }, 20000)

  it('when every project IS clean, createRunTempBranches proceeds and checks out the real temp branch in each', async () => {
    await createRunTempBranches(
      fixtureWs(),
      [{ name: 'api', cwd: repoA }, { name: 'web', cwd: repoB }],
      'run-clean',
    )
    expect(await currentBranch(repoA)).toBe(tempBranchName('run-clean'))
    expect(await currentBranch(repoB)).toBe(tempBranchName('run-clean'))
  }, 20000)

  // ---- Dirty-tree stash/restore (user decision): start a run with uncommitted changes safely ----

  it('stashRun stashes tracked + untracked changes (tree clean after); popRunStash restores them', async () => {
    writeFileSync(join(repoA, 'existing.txt'), 'hello\nuser edit\n')   // tracked edit
    writeFileSync(join(repoA, 'user-new.txt'), 'user untracked\n')     // untracked new file
    expect(await porcelainStatus(repoA)).not.toBe('')

    expect(await stashRun(repoA, 'run-s')).toBe(true)
    expect(await porcelainStatus(repoA)).toBe('')                      // clean → temp branch can be created
    expect(existsSync(join(repoA, 'user-new.txt'))).toBe(false)        // untracked change is stashed away too

    expect(await popRunStash(repoA, 'run-s')).toBe('popped')
    expect(readFileSync(join(repoA, 'existing.txt'), 'utf8')).toContain('user edit')
    expect(existsSync(join(repoA, 'user-new.txt'))).toBe(true)
    expect(await stashRun(repoA, 'noop')).toBe(true)                   // still dirty → nothing was lost
  }, 20000)

  it('MERGE cycle: a dirty tree is stashed, the run merges its own work, and the user\'s uncommitted changes come back', async () => {
    writeFileSync(join(repoA, 'existing.txt'), 'hello\nuser edit\n')
    writeFileSync(join(repoA, 'user-new.txt'), 'user untracked\n')

    await stashRun(repoA, 'run-m')                                     // stash the user's work
    await createTempBranch(repoA, 'main', 'run-m')                     // temp branch off a CLEAN tree
    writeFileSync(join(repoA, 'agent.txt'), 'agent work\n')            // the run writes its own file
    await mergeTempBranch(repoA, 'main', 'run-m')                      // merge the run into main
    expect(await popRunStash(repoA, 'run-m')).toBe('popped')           // restore the user's work

    expect(await currentBranch(repoA)).toBe('main')
    // The run's work is committed & merged onto main …
    expect(await git(['log', '--oneline'], { cwd: repoA })).toContain('run run-m')
    expect(existsSync(join(repoA, 'agent.txt'))).toBe(true)
    // … and the user's uncommitted changes are back, still uncommitted, NOT swallowed by the run.
    expect(readFileSync(join(repoA, 'existing.txt'), 'utf8')).toContain('user edit')
    expect(existsSync(join(repoA, 'user-new.txt'))).toBe(true)
    expect(await porcelainStatus(repoA)).not.toBe('')                 // user's edits show as uncommitted
  }, 20000)

  it('DISCARD cycle: the run\'s work is thrown away by clean -fd but the user\'s stashed changes survive (the whole point)', async () => {
    writeFileSync(join(repoA, 'existing.txt'), 'hello\nuser edit\n')
    writeFileSync(join(repoA, 'user-new.txt'), 'user untracked\n')

    await stashRun(repoA, 'run-d')
    await createTempBranch(repoA, 'main', 'run-d')
    writeFileSync(join(repoA, 'agent.txt'), 'agent work\n')            // run's untracked file
    await discardTempBranch(repoA, 'main', 'run-d')                   // checkout -f + clean -fd wipes the run
    expect(await popRunStash(repoA, 'run-d')).toBe('popped')

    expect(await currentBranch(repoA)).toBe('main')
    expect(existsSync(join(repoA, 'agent.txt'))).toBe(false)          // run's work discarded …
    // … but the user's uncommitted work is intact (it was stashed BEFORE clean -fd ran).
    expect(readFileSync(join(repoA, 'existing.txt'), 'utf8')).toContain('user edit')
    expect(existsSync(join(repoA, 'user-new.txt'))).toBe(true)
  }, 20000)
})

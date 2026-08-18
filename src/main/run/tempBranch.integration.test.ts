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
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git } from '../git/gitRunner'
import { createTempBranch, mergeTempBranch, discardTempBranch, isCleanTree, parkTempBranch, tempBranchName, TempBranchMergeError } from './tempBranch'
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
    await expect(createTempBranch(repo, 'main', 'run-b')).resolves.toEqual({ branch: tempBranchName('run-b'), snapshotSha: null })
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

// 【Task 1 审查转交 · 用户裁决 2026-08-17】Task 1 删掉了 6 个真 git 的 stash 集成测试；快照机制
// （createTempBranch 的"运行前快照"提交取代 git stash，见 tempBranch.ts 顶部注释）此前只有假
// GitRunner 覆盖过八轮评审。这组补的正是这个缺口：真实分支切换、真实脏树、真实合并冲突。
async function initRepoWithTrackedFile(): Promise<string> {
  // 这组用例都要"改一个已跟踪文件"这个前提（模拟用户已经在项目里工作过，不是刚 init 的空仓库）；
  // 顶层 initRepo() 只提交了 existing.txt，这里额外提交一份 tracked.txt 给这组测试专用，不动
  // 上面那组既有用例的初始状态。
  const repo = await initRepo()
  writeFileSync(join(repo, 'tracked.txt'), 'original\n')
  await git(['add', '-A'], { cwd: repo })
  await git(['commit', '-m', 'add tracked.txt'], { cwd: repo })
  return repo
}

describe.skipIf(!gitAvailable)('真 git · 从当前分支切出并保住未提交改动', () => {
  let repo: string
  let wsRoot: string
  beforeEach(async () => {
    repo = await initRepoWithTrackedFile()
    // createRunTempBranches 不读 ws.path（cwd 全部来自显式传入的 projects 数组），占位即可。
    wsRoot = repo
  })
  afterEach(() => rmSync(repo, { recursive: true, force: true }))

  it('脏树 → 启动 → park：未提交改动逐字节还原，工作树与运行前一致', async () => {
    // 起点：branch1，一个已跟踪文件被改、一个新文件未跟踪
    execSync('git switch -c branch1', { cwd: repo, stdio: 'ignore' })
    writeFileSync(join(repo, 'tracked.txt'), 'user edit\n')
    writeFileSync(join(repo, 'brand-new.txt'), 'user new file\n')
    const before = execSync('git status --porcelain', { cwd: repo }).toString()

    const { snapshotSha } = await createTempBranch(repo, 'branch1', 'r1')
    expect(snapshotSha).toBeTruthy()
    // agent 在临时分支上写点东西
    writeFileSync(join(repo, 'agent.txt'), 'agent output\n')

    await parkTempBranch(repo, 'branch1', 'r1', snapshotSha)

    expect(execSync('git rev-parse --abbrev-ref HEAD', { cwd: repo }).toString().trim()).toBe('branch1')
    expect(readFileSync(join(repo, 'tracked.txt'), 'utf8')).toBe('user edit\n')
    expect(readFileSync(join(repo, 'brand-new.txt'), 'utf8')).toBe('user new file\n')
    expect(execSync('git status --porcelain', { cwd: repo }).toString()).toBe(before)
    // agent 的改动留在临时分支上，没有跟到 branch1
    expect(existsSync(join(repo, 'agent.txt'))).toBe(false)
    expect(execSync('git branch --list forge/run-r1', { cwd: repo }).toString().trim()).not.toBe('')
  }, 20000)

  it('脏树 → 启动 → 合并：branch1 拿到快照提交与 run 提交，工作树干净', async () => {
    execSync('git switch -c branch1', { cwd: repo, stdio: 'ignore' })
    writeFileSync(join(repo, 'tracked.txt'), 'user edit\n')

    const { snapshotSha } = await createTempBranch(repo, 'branch1', 'r1')
    expect(snapshotSha).toBeTruthy()
    writeFileSync(join(repo, 'agent.txt'), 'agent output\n')

    await mergeTempBranch(repo, 'branch1', 'r1')

    const log = execSync('git log --oneline -5', { cwd: repo }).toString()
    expect(log).toMatch(/运行前快照/)
    expect(log).toMatch(/run r1/)
    expect(execSync('git status --porcelain', { cwd: repo }).toString().trim()).toBe('')
    expect(readFileSync(join(repo, 'agent.txt'), 'utf8')).toBe('agent output\n')
  }, 20000)

  it('运行期间 branch1 上另有提交 → 合并冲突：branch1 干净、临时分支仍在、改动可手工合', async () => {
    execSync('git switch -c branch1', { cwd: repo, stdio: 'ignore' })
    const { snapshotSha } = await createTempBranch(repo, 'branch1', 'r1')
    expect(snapshotSha).toBeNull()
    writeFileSync(join(repo, 'tracked.txt'), 'agent version\n')

    // 制造真实分叉：先把 agent 在临时分支上的改动提交掉（mergeTempBranch 内部本来也会做这步
    // add -A && commit，这里提前手工做一遍，是为了在调用它之前就让两边各自往前走一步，而不是
    // 靠 mergeTempBranch 自己那步 —— 否则 branch1 上没有新提交，不会有真正的冲突）。
    execSync('git add -A', { cwd: repo, stdio: 'ignore' })
    execSync('git commit -m agent', { cwd: repo, stdio: 'ignore' })

    // 用户在自己的分支上，对同一个文件另提交一版。
    execSync('git switch branch1', { cwd: repo, stdio: 'ignore' })
    writeFileSync(join(repo, 'tracked.txt'), 'user diverged version\n')
    execSync('git add -A', { cwd: repo, stdio: 'ignore' })
    execSync('git commit -m "user diverges"', { cwd: repo, stdio: 'ignore' })

    execSync(`git switch ${tempBranchName('r1')}`, { cwd: repo, stdio: 'ignore' })

    let err: unknown
    try { await mergeTempBranch(repo, 'branch1', 'r1') } catch (e) { err = e }

    expect(err).toBeInstanceOf(TempBranchMergeError)
    expect((err as TempBranchMergeError).conflictFiles).toContain('tracked.txt')
    // branch1 必须干净：绝不留在「合并进行中」
    expect(existsSync(join(repo, '.git', 'MERGE_HEAD'))).toBe(false)
    expect(execSync('git status --porcelain', { cwd: repo }).toString().trim()).toBe('')
    // 临时分支必须还在 —— 本次运行的改动全在上面
    expect(execSync('git branch --list forge/run-r1', { cwd: repo }).toString().trim()).not.toBe('')
  }, 20000)

  // 【Task 1 审查转交 · 用户裁决 2026-08-17】Task 1 删掉了 6 个真 git 的 stash 集成测试，新的
  // 快照机制一度只有假 GitRunner 覆盖。上面两条已补回"脏树带过去"和"快照活过合并"，这条补的是
  // 审查点名的第三个缺口：临时分支现在**总是**带着一个真实的、未合并的提交，`branch -D` 是否
  // 真的能强删掉它（普通 `branch -d` 会拒绝，假 GitRunner 永远发现不了这个区别）。
  it('discard：强删一条含真实未合并提交的临时分支，且用户改动完好回到工作树', async () => {
    execSync('git switch -c branch1', { cwd: repo, stdio: 'ignore' })
    writeFileSync(join(repo, 'tracked.txt'), 'user edit\n')
    writeFileSync(join(repo, 'brand-new.txt'), 'user new file\n')
    const before = execSync('git status --porcelain', { cwd: repo }).toString()

    const { snapshotSha } = await createTempBranch(repo, 'branch1', 'r1')
    expect(snapshotSha).toBeTruthy()
    // 快照此刻是 forge/run-r1 上一个真实的、branch1 完全够不着的提交
    expect(execSync('git branch --contains ' + snapshotSha, { cwd: repo }).toString()).not.toMatch(/branch1/)
    writeFileSync(join(repo, 'agent.txt'), 'agent output\n')

    await discardTempBranch(repo, 'branch1', 'r1', snapshotSha)

    expect(execSync('git branch --list forge/run-r1', { cwd: repo }).toString().trim()).toBe('')
    expect(readFileSync(join(repo, 'tracked.txt'), 'utf8')).toBe('user edit\n')
    expect(readFileSync(join(repo, 'brand-new.txt'), 'utf8')).toBe('user new file\n')
    expect(execSync('git status --porcelain', { cwd: repo }).toString()).toBe(before)
    expect(existsSync(join(repo, 'agent.txt'))).toBe(false)
  }, 20000)

  it('createRunTempBranches 在真仓库里用实测 HEAD，不用工作区存盘的分支', async () => {
    execSync('git switch -c branch1', { cwd: repo, stdio: 'ignore' })
    const ws = { path: wsRoot, projects: [{ name: 'proj', branch: 'main' }] } as unknown as Workspace
    const got = await createRunTempBranches(ws, [{ name: 'proj', cwd: repo }], 'r1')
    expect(got.targets).toEqual({ proj: 'branch1' })
  }, 20000)

  // ——————————————————————————————————————————————————————————————————————————————————————
  // 2026-08-17 全分支终审 C1(Critical,评审者用真 git 复现过):快照提交会跑用户仓库的钩子和签名配置
  // (gitRunner 原样传用户环境、不加 --no-verify),一个 pre-commit 钩子挂掉,createTempBranch 就在
  // 第二段抛错,而 HEAD 此刻已经停在临时分支上、回滚循环又不含正在失败的这个项目 —— 下一次启动实测
  // HEAD 拿到 forge/run-<旧 id>,整轮工作最后合进一条没人要的分支。假 GitRunner 证不了这条(它既不
  // 真跑钩子,也不真移动 HEAD),所以这里写一个真的、退出码非零的 pre-commit 钩子进临时仓库。
  // ——————————————————————————————————————————————————————————————————————————————————————
  function installFailingPreCommitHook(repoDir: string): void {
    const hook = join(repoDir, '.git', 'hooks', 'pre-commit')
    writeFileSync(hook, '#!/bin/sh\necho "lint failed" >&2\nexit 1\n', { mode: 0o755 })
  }

  it('C1c:pre-commit 钩子挂掉时,运行前快照照样提交得上去(--no-verify)', async () => {
    execSync('git switch -c branch1', { cwd: repo, stdio: 'ignore' })
    writeFileSync(join(repo, 'tracked.txt'), 'user edit\n')
    installFailingPreCommitHook(repo)

    const { snapshotSha } = await createTempBranch(repo, 'branch1', 'r9')

    expect(snapshotSha).toBeTruthy()
    expect(execSync('git rev-parse --abbrev-ref HEAD', { cwd: repo }).toString().trim()).toBe('forge/run-r9')
    expect(execSync('git log --oneline -1', { cwd: repo }).toString()).toMatch(/运行前快照/)
    // 用户的改动确实进了那个提交,不是被跳过了。
    expect(execSync('git show --stat --oneline HEAD', { cwd: repo }).toString()).toMatch(/tracked\.txt/)
  }, 20000)

  it('C1b:快照提交仍然失败时(签名配置坏掉),HEAD 不许被留在临时分支上', async () => {
    execSync('git switch -c branch1', { cwd: repo, stdio: 'ignore' })
    writeFileSync(join(repo, 'tracked.txt'), 'user edit\n')
    writeFileSync(join(repo, 'brand-new.txt'), 'user new file\n')
    const before = execSync('git status --porcelain', { cwd: repo }).toString()
    // 让提交注定失败,而且**不是**靠钩子 —— C1c 的 --no-verify 已经把钩子那条路绕过去了,这里要的是
    // 另一类真实失败:用户开了 commit.gpgsign 而签名程序跑不起来(签名故意没被 --no-gpg-sign 关掉,
    // 见 createTempBranch 的注释)。这正是「快照提交失败」在现实里剩下的那一半。
    await git(['config', 'commit.gpgsign', 'true'], { cwd: repo })
    await git(['config', 'gpg.program', '/bin/false'], { cwd: repo })
    const ws = { path: wsRoot, projects: [{ name: 'proj', branch: 'main' }] } as unknown as Workspace

    await expect(createRunTempBranches(ws, [{ name: 'proj', cwd: repo }], 'r9')).rejects.toThrow(/proj/)

    // 核心断言(评审者复现的那两条):HEAD 回到 branch1,废弃的临时分支不存在。
    expect(execSync('git rev-parse --abbrev-ref HEAD', { cwd: repo }).toString().trim()).toBe('branch1')
    expect(execSync('git branch --list forge/run-r9', { cwd: repo }).toString().trim()).toBe('')
    // 且撤回没有顺手销毁用户那些未提交的改动 —— 快照没提交成,它们此刻没有任何副本。
    expect(readFileSync(join(repo, 'tracked.txt'), 'utf8')).toBe('user edit\n')
    expect(readFileSync(join(repo, 'brand-new.txt'), 'utf8')).toBe('user new file\n')
    expect(execSync('git status --porcelain', { cwd: repo }).toString()).toBe(before)
  }, 20000)

  it('C1a:工作树停在上一次运行的临时分支上时,下一次启动被挡下(而不是把它当成基准)', async () => {
    execSync('git switch -c branch1', { cwd: repo, stdio: 'ignore' })
    // 模拟「上一次运行留下的废弃临时分支」——不管它是怎么留下的(快照失败、用户自己切过去、收尾崩在半路)。
    execSync('git switch -c forge/run-r9', { cwd: repo, stdio: 'ignore' })
    const ws = { path: wsRoot, projects: [{ name: 'proj', branch: 'main' }] } as unknown as Workspace

    await expect(createRunTempBranches(ws, [{ name: 'proj', cwd: repo }], 'r10'))
      .rejects.toThrow(/forge\/run-r9/)

    // 一个分支都没建,也没动 HEAD —— 用户拿着这句报错自己 git switch 回去即可。
    expect(execSync('git branch --list forge/run-r10', { cwd: repo }).toString().trim()).toBe('')
    expect(execSync('git rev-parse --abbrev-ref HEAD', { cwd: repo }).toString().trim()).toBe('forge/run-r9')
  }, 20000)

  it('detached HEAD → 抛错且不建任何分支', async () => {
    const head = execSync('git rev-parse HEAD', { cwd: repo }).toString().trim()
    execSync(`git checkout ${head}`, { cwd: repo, stdio: 'ignore' })
    const ws = { path: wsRoot, projects: [{ name: 'proj', branch: 'main' }] } as unknown as Workspace
    await expect(createRunTempBranches(ws, [{ name: 'proj', cwd: repo }], 'r1')).rejects.toThrow(/detached HEAD/)
    expect(execSync('git branch --list forge/run-r1', { cwd: repo }).toString().trim()).toBe('')
  }, 20000)
})

// ————————————————————————————————————————————————————————————————————————————————————————————
// 2026-08-17 全分支终审 C2(Critical,评审者用真 git 复现过):合并失败之后仓库已经被切回用户自己的
// 分支(mergeTempBranch 里的 `checkout target` + `merge --abort`),失败卡还明说「已恢复到合并前的
// 干净状态」并给出可粘贴的命令 —— 等于邀请用户接着在那儿干活。用户实测反馈的原话:「我自己解决了
// 冲突，并且自己继续开发」。此时点「重新收尾」,runFinalizeGate 会原样再调一遍 merge/park/discard,
// 而它们从前一个都不查自己在哪条分支上。
//
// 这一组每条用例都先真的制造出那个状态(真分叉 → 真冲突 → 真 abort),再模拟用户在自己的分支上继续
// 写代码,然后调重试。假 GitRunner 永远复现不了这个:它不移动 HEAD,也没有工作树可以被误伤。
// ————————————————————————————————————————————————————————————————————————————————————————————
describe.skipIf(!gitAvailable)('真 git · C2 收尾重试不许动用户自己分支上的东西', () => {
  let repo: string
  beforeEach(async () => { repo = await initRepoWithTrackedFile() })
  afterEach(() => rmSync(repo, { recursive: true, force: true }))

  // 把仓库带到「合并失败之后」那个状态:branch1 与 forge/run-r1 在同一个文件上各自有提交,
  // mergeTempBranch 冲突、abort、停在 branch1。返回时工作树干净,HEAD 在 branch1。
  async function reachFailedMergeState(): Promise<void> {
    execSync('git switch -c branch1', { cwd: repo, stdio: 'ignore' })
    await createTempBranch(repo, 'branch1', 'r1')
    writeFileSync(join(repo, 'tracked.txt'), 'agent version\n')
    execSync('git add -A', { cwd: repo, stdio: 'ignore' })
    execSync('git commit -m agent', { cwd: repo, stdio: 'ignore' })
    execSync('git switch branch1', { cwd: repo, stdio: 'ignore' })
    writeFileSync(join(repo, 'tracked.txt'), 'user diverged version\n')
    execSync('git add -A', { cwd: repo, stdio: 'ignore' })
    execSync('git commit -m "user diverges"', { cwd: repo, stdio: 'ignore' })
    execSync(`git switch ${tempBranchName('r1')}`, { cwd: repo, stdio: 'ignore' })

    let err: unknown
    try { await mergeTempBranch(repo, 'branch1', 'r1') } catch (e) { err = e }
    expect(err).toBeInstanceOf(TempBranchMergeError)
    // 前提核实:失败卡说的「已恢复到合并前的干净状态」确实成立 —— 用户就是在这个状态下继续开发的。
    expect(execSync('git rev-parse --abbrev-ref HEAD', { cwd: repo }).toString().trim()).toBe('branch1')
    expect(execSync('git status --porcelain', { cwd: repo }).toString().trim()).toBe('')
  }

  it('重新收尾选「合并」:不把用户失败后写的 WIP 提交成 forge: run r1', async () => {
    await reachFailedMergeState()
    // 用户自己解冲突、继续开发(未提交)。
    writeFileSync(join(repo, 'userwip.txt'), 'my own work after the failure\n')

    const logBefore = execSync('git log --oneline', { cwd: repo }).toString()
    let err: unknown
    try { await mergeTempBranch(repo, 'branch1', 'r1') } catch (e) { err = e }

    // 合并本身照样冲突(用户还没真解决分叉)——重点是它**没有**顺手替用户提交。
    expect(err).toBeInstanceOf(TempBranchMergeError)
    expect(execSync('git log --oneline', { cwd: repo }).toString()).toBe(logBefore)
    expect(execSync('git log --oneline -5', { cwd: repo }).toString()).not.toMatch(/forge: run r1/)
    // 用户的 WIP 原样留在工作树里,没被提交、也没被清掉。
    expect(existsSync(join(repo, 'userwip.txt'))).toBe(true)
    expect(execSync('git status --porcelain', { cwd: repo }).toString()).toMatch(/userwip\.txt/)
  }, 20000)

  it('重新收尾选「先不合并」:是一次成功的空操作,不提交用户的 WIP、临时分支照旧保留', async () => {
    await reachFailedMergeState()
    writeFileSync(join(repo, 'tracked.txt'), 'user keeps editing\n')
    writeFileSync(join(repo, 'userwip.txt'), 'my own work after the failure\n')
    const before = execSync('git status --porcelain', { cwd: repo }).toString()
    const logBefore = execSync('git log --oneline', { cwd: repo }).toString()

    // park 跳过时会 console.warn 一句(说明为什么无事可做);测试输出保持干净。
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await expect(parkTempBranch(repo, 'branch1', 'r1', null)).resolves.toBeUndefined()
      expect(warnSpy).toHaveBeenCalled()
    } finally { warnSpy.mockRestore() }

    expect(execSync('git rev-parse --abbrev-ref HEAD', { cwd: repo }).toString().trim()).toBe('branch1')
    expect(execSync('git log --oneline', { cwd: repo }).toString()).toBe(logBefore)
    expect(execSync('git status --porcelain', { cwd: repo }).toString()).toBe(before)
    expect(readFileSync(join(repo, 'tracked.txt'), 'utf8')).toBe('user keeps editing\n')
    // park 的语义(保留分支)本来就已经是事实了。
    expect(execSync('git branch --list forge/run-r1', { cwd: repo }).toString().trim()).not.toBe('')
  }, 20000)

  it('重新收尾选「丢弃」:拒绝执行,用户失败后写的改动与未跟踪新文件一个都不许被删', async () => {
    await reachFailedMergeState()
    writeFileSync(join(repo, 'tracked.txt'), 'user keeps editing\n')
    writeFileSync(join(repo, 'newwip.txt'), 'untracked, created after the failure card\n')

    await expect(discardTempBranch(repo, 'branch1', 'r1', null)).rejects.toThrow(/forge\/run-r1/)

    // 评审者复现的正是这两条:tracked 的编辑被 checkout -f 抹掉、untracked 的新文件被 clean -fd 删掉。
    expect(readFileSync(join(repo, 'tracked.txt'), 'utf8')).toBe('user keeps editing\n')
    expect(existsSync(join(repo, 'newwip.txt'))).toBe(true)
    // 拒绝 ≠ 假装成功:临时分支必须还在(它才是本次运行成果的唯一副本),报错里带着该敲的命令。
    expect(execSync('git branch --list forge/run-r1', { cwd: repo }).toString().trim()).not.toBe('')
  }, 20000)

  it('正常路径不受守卫影响:还在临时分支上时,三个动作照旧完整执行', async () => {
    execSync('git switch -c branch1', { cwd: repo, stdio: 'ignore' })
    const { snapshotSha } = await createTempBranch(repo, 'branch1', 'r2')
    expect(snapshotSha).toBeNull()
    writeFileSync(join(repo, 'agent.txt'), 'agent output\n')

    await mergeTempBranch(repo, 'branch1', 'r2')

    expect(execSync('git rev-parse --abbrev-ref HEAD', { cwd: repo }).toString().trim()).toBe('branch1')
    expect(readFileSync(join(repo, 'agent.txt'), 'utf8')).toBe('agent output\n')
    expect(execSync('git log --oneline -5', { cwd: repo }).toString()).toMatch(/run r2/)
    expect(execSync('git branch --list forge/run-r2', { cwd: repo }).toString().trim()).toBe('')
  }, 20000)
})

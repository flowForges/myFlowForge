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
 * 本模块替用户做的三次记账提交（运行前快照 / `forge: run <id>` / `forge: run <id> (aborted)`）一律
 * 走 `--no-verify`，理由见 createTempBranch 的注释；用户意志下的那次提交（`merge --no-ff`）不动。
 * 三个收尾动作（merge/park/discard）在动手之前都先确认自己还在临时分支上，理由见 onTempBranch。
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
 * 这个工作树此刻**是不是**还停在本次运行的临时分支上。
 *
 * 为什么每个收尾动作(merge/park/discard)都必须先问这一句(2026-08-17 审查 C2,真 git 复现):
 * 一次合并失败后 mergeTempBranch 已经 `checkout target` + `merge --abort`,仓库停在用户自己的
 * 分支上,失败卡还明说「已恢复到合并前的干净状态」——用户于是接着在那儿改代码、解冲突。此时点
 * 「重新收尾」,runFinalizeGate 会原样再调一遍这三个函数,而它们原本一个都不查自己在哪条分支上:
 *   - merge/park 的 `add -A` + commit 会把用户失败后写的东西提交到**用户自己的分支**上,
 *     还盖上 `forge: run <runId>` 的名字;
 *   - discard 的 `checkout -f` + `clean -fd` 会把用户失败后新建的未跟踪文件直接删掉(不可恢复)。
 * 所以工作树不在临时分支上时,那里的一切脏东西都是**用户的**,不是这次运行的,谁都不许动。
 *
 * 读不出当前分支(目录没了/不是仓库/git 缺失)一律抛出可读错误,不静默按「不在」处理 —— 那会让一次
 * 环境故障看起来像一次成功的空收尾。
 */
async function onTempBranch(cwd: string, runId: string, run: GitRunner): Promise<boolean> {
  const branch = tempBranchName(runId)
  try {
    return (await currentBranch(cwd, run)) === branch
  } catch (err) {
    throw readableGitError(`读不出当前所在分支，无法确认是否仍在临时分支 "${branch}" 上`, err)
  }
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
 *
 * `--no-verify`(2026-08-17 审查 C1c，真 git 复现)：这是 app 替用户在一条一次性分支上做的**记账**
 * 提交，不是用户自己按下的那次提交。跑用户的 pre-commit(lint-staged/husky 之类，本 app 面向的仓库
 * 里几乎人手一个)本身就说不通——它审的是「半成品脏树」，注定挂——挂了还会把整次启动带进 C1 那条
 * 「HEAD 被留在临时分支上」的连锁。签名(`commit.gpgsign`)则**故意不关**：钩子是内容质检，签名是
 * 用户对「什么能进历史」的策略，而这条快照提交在合并那条收尾路径上是真的会进用户分支历史的。
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
    await run(cwd, ['commit', '--no-verify', '-m', 'forge: 运行前快照'])
    const sha = (await run(cwd, ['rev-parse', 'HEAD'])).trim()
    return { branch, snapshotSha: sha }
  } catch (err) {
    throw readableGitError(`Failed to commit pre-run snapshot onto temp branch "${branch}"`, err)
  }
}

/**
 * 建分支途中失败时的「就地撤回」：切回 base，并删掉刚刚建出来的临时分支。
 *
 * 为什么不能复用 discardTempBranch(2026-08-17 审查 C1b):走到这里意味着**快照提交没成**(pre-commit
 * 钩子拒绝、user.email 没配、commit.gpgsign 失败……),用户那些未提交的改动此刻在世界上没有任何副本。
 * discardTempBranch 的 `checkout -f` + `clean -fd` 会把它们连同未跟踪的新文件一起销毁。这里只用普通
 * `checkout base`:临时分支此刻和 base 指向同一个提交(没有任何新提交要丢),脏树被原样带回 base,正是
 * 运行前的样子。
 *
 * 两步都尽力而为:`checkout -b` 自己就失败时临时分支压根不存在,`branch -D` 注定失败,不该因此把撤回
 * 判成失败(切回 base 才是要紧的那一步)。切回 base 失败则抛出——那才是「HEAD 被留在废弃临时分支上」
 * 这个真正危险状态的信号,调用方要把它报给用户。
 */
export async function abandonTempBranch(
  cwd: string,
  base: string,
  runId: string,
  run: GitRunner = defaultGitRunner
): Promise<void> {
  const branch = tempBranchName(runId)
  // HEAD 已经在临时分支上 ⟺ createTempBranch 过了 `checkout -b` 那一步,也就一定跑过 `add -A` ——
  // 只有这种情况才需要下面那次 `reset`。`checkout -b` 自己就失败时(重名等)我们什么都没暂存过,
  // 这时候 reset 反而会把用户**自己 staged** 的东西给退出去。读不出来就按最坏情况(在)办。
  let staged = true
  try { staged = (await currentBranch(cwd, run)) === branch } catch { /* 读不出来就按最坏情况办 */ }
  try {
    await run(cwd, ['checkout', base])
  } catch (err) {
    throw readableGitError(`Failed to check "${cwd}" back out onto base "${base}" after temp branch "${branch}" creation failed`, err)
  }
  if (staged) {
    try {
      // createTempBranch 失败前已经跑过 `add -A`,不撤销的话用户的改动会以「全部已暂存」的样子留下来。
      // `git reset`(mixed,不动工作树)把它们退回未暂存/未跟踪 —— 这就是运行前的外观。已知精度损失与
      // restoreSnapshotDetailed 那边完全一样:运行前**已 staged** 的改动会变成未 staged,内容一字不丢。
      await run(cwd, ['reset'])
    } catch (err) {
      console.warn(`[run2] ${cwd}: 撤回 ${branch} 后取消暂存失败(改动仍在,只是处于已暂存状态): ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  try {
    await run(cwd, ['branch', '-D', branch])
  } catch {
    // 分支可能压根没建成 —— 不是错误。
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

/**
 * Checkout `target`, merge the temp branch in with --no-ff, then delete the temp branch.
 *
 * 重试安全(2026-08-17 审查 C2)：上一次合并失败后仓库已经被切回 `target`（下面的 `checkout target`
 * + `merge --abort`），用户可能已经在那儿继续写代码了。此时点「重新收尾」会原样再调一次本函数——
 * 所以下面那步「把在制品提交到临时分支上」必须先确认自己**真的还在临时分支上**，否则提交的是用户
 * 自己的改动、还盖上 `forge: run <runId>` 的名字（真 git 复现过：branch1 上凭空多出一条 forge 提交，
 * 而且合并照样冲突，每重试一次就再多一条）。不在临时分支上时那一步直接跳过——那里没有本次运行的
 * 东西要提交（在制品早在第一次尝试里就提交进临时分支了），脏的都是用户的。合并本身照常重试。
 *
 * 在制品提交同样走 `--no-verify`（理由见 createTempBranch 的注释）：它和运行前快照一样是 app 替用户
 * 在一次性分支上做的记账提交，跑用户的 pre-commit 只会让一个挂掉的钩子把**整次运行**锁死在「收不了
 * 尾」——连「先不合并」这条安全出口都走不了。真正属于用户意志的那次提交是下面的 `merge --no-ff`
 * （它跑的是 pre-merge-commit 钩子），那个一个字都不动。
 */
export async function mergeTempBranch(
  cwd: string,
  target: string,
  runId: string,
  run: GitRunner = defaultGitRunner
): Promise<void> {
  const branch = tempBranchName(runId)
  const onBranch = await onTempBranch(cwd, runId, run)
  // The agent(s) wrote their changes into the working tree while checked out on `branch` —
  // nothing has committed them yet (createTempBranch/agents only ever `checkout -b`/edit files).
  // Commit them onto the temp branch HERE, BEFORE switching away, or the switch to `target` below
  // would carry the uncommitted edits over onto the target's working tree instead of merging real
  // history (the exact bug this function used to have: `checkout target` on a dirty tree "moves"
  // the edits, then `merge` finds temp and target identical → "Already up to date", no merge
  // commit, and the target's working tree is left dirty with the run's changes).
  if (onBranch) {
    try {
      await run(cwd, ['add', '-A'])
      // `git status --porcelain` (not diff --cached --quiet's exit-code trick) so this is trivial to
      // drive with a fake GitRunner in unit tests: empty output = clean, anything else = staged work.
      const status = await run(cwd, ['status', '--porcelain'])
      if (status.trim().length > 0) {
        await run(cwd, ['commit', '--no-verify', '-m', `forge: run ${runId}`])
      }
    } catch (err) {
      throw readableGitError(`Failed to commit run "${runId}" changes onto temp branch "${branch}"`, err)
    }
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
 *
 * 这套「强制 + 清理」的前提只在**工作树还停在临时分支上**时成立，所以本函数现在先查一句，不在就
 * 直接拒绝执行（2026-08-17 审查 C2，真 git 复现）：一次合并失败后仓库已经被切回 target、失败卡还
 * 明说「已恢复到合并前的干净状态」，用户于是接着在那儿写代码；此时点「重新收尾」再选丢弃，
 * `checkout -f` + `clean -fd` 删掉的是**用户失败之后自己写的**改动和未跟踪新文件——不可恢复。
 * 三个收尾动作里只有它选择「报错」而不是「跳过」：跳过等于假装丢弃成功、临时分支却还在，用户下次
 * 启动就会撞上 launch.ts 那道 `forge/run-` 基准守卫；而报错会走到收尾失败卡，那里能把该敲的命令
 * 原样给出来。删除未跟踪文件是这三者里唯一不可逆的动作，宁可什么都不做。
 */
export async function discardTempBranch(
  cwd: string,
  target: string,
  runId: string,
  snapshotSha: string | null = null,
  run: GitRunner = defaultGitRunner
): Promise<void> {
  const branch = tempBranchName(runId)
  if (!(await onTempBranch(cwd, runId, run))) {
    const here = await currentBranch(cwd, run)
    throw new Error(
      `没有丢弃 ${branch}：这个仓库当前在分支 ${here || '（detached HEAD）'} 上，不在本次运行的临时分支上，`
      + `工作树里的改动看起来是你自己的，已原样留着没动。`
      // Task 8 residual fix (R3)：这句只交代了「当前工作树」是安全的，只字未提运行前那些未提交改动
      // 的下落——它们不在这棵工作树里，只存在于 branch 上的「运行前快照」提交里（见 createTempBranch）。
      // 启动门现在已经明说了「未提交改动会提交成运行前快照」（I1），用户认得这个词、也会以为它已经被
      // 处理好了；这里若不提，用户会照着后面那句 `git branch -D` 原样执行，把这份唯一副本连快照一起
      // 删掉——git reflog 还能捞回来，但没人会知道要去捞。只在真有快照时才提（工作树当时干净时
      // snapshotSha 是 null，没有这回事）。
      + (snapshotSha
        ? `另外，你运行前那些未提交的改动只保存在 ${branch} 的「运行前快照」提交 ${snapshotSha} 里——这条命令会把它们一起删掉。`
        : '')
      + `确认要丢弃本次运行请手动执行：git branch -D ${branch}`
    )
  }
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
 *
 * 2026-08-17 审查 C2:工作树**不在**临时分支上时,park 整个变成一次成功的空操作。
 *
 * 走到这一步只有一种现实路径:上一次收尾选的是「合并」且失败了(mergeTempBranch 已经 `checkout
 * target` + `merge --abort`,在制品也早在它自己那步里提交进了临时分支),用户看完失败卡改选了
 * 「先不合并」。park 想要的三件事此刻都**已经是事实**:在制品在临时分支上、分支保留着、工作树在
 * target 上。剩下的两个动作反而都是错的 —— `add -A` + commit 会把用户失败后写的东西提交到他自己
 * 的分支上并盖上 forge 的名字(真 git 复现过),cherry-pick 快照会把用户运行前那份改动**第二次**
 * 盖到一棵他已经继续改过的工作树上(快照本体安全地待在临时分支的提交里,不需要在这儿抢救)。
 * 所以什么都不做、如实返回成功,让这个 run 收干净。
 */
export async function parkTempBranch(
  cwd: string,
  target: string,
  runId: string,
  snapshotSha: string | null = null,
  run: GitRunner = defaultGitRunner
): Promise<void> {
  const branch = tempBranchName(runId)
  if (!(await onTempBranch(cwd, runId, run))) {
    console.warn(`[run2] ${cwd}: 已不在 ${branch} 上(多半是上一次合并失败后已切回 ${target}),保留分支这步无事可做,跳过`)
    return
  }
  try {
    await run(cwd, ['add', '-A'])
    const status = await run(cwd, ['status', '--porcelain'])
    if (status.trim().length > 0) {
      await run(cwd, ['commit', '--no-verify', '-m', `forge: run ${runId} (aborted)`])
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

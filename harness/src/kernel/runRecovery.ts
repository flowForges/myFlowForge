// 崩溃恢复(04 spec §7.5):不续跑,对没收尾的运行如实写结束事件和通知。
// 只看日志,所以跑几次都一样;日志里的 runId、路径都不直接信
import { existsSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { isInside } from '../lib/fs/paths'
import { removeInWorktree, removeWorktree } from '../lib/git/worktree'
import type { Git, RepoPin } from '../lib/git/snapshot'
import { noticeText, type Diagnostic } from '../lib/tools/diagnostics'
import { denyReadCopies, treePolicy } from '../lib/tools/treePolicy'
import type { ExecPolicy } from '../lib/tools/types'
import type { KernelEvent } from '../protocol/index'
import type { Logger } from './log'

export const RECOVERY_FINAL = 'This run was interrupted by a restart and was not resumed. Files may be half changed: check `git status` first.'
/** 运行结束了、通知还在内存里就崩了:CLI 的回复没进日志,只有 run.ended 的字段 */
export const UNDELIVERED_FINAL = 'This run ended before a restart, and its notice was never delivered. The fields above come from the log; the reply of the CLI is in raw-log, if there is one.'

const RUN_ID = /^run_[0-9a-f]+$/

export interface RecoveredRun {
  runId: string
  sessionId?: string
  /** CLI 起来过。没有 = 崩在建 worktree 和起进程之间 */
  started: boolean
  cwd?: string
  worktree?: string
}

interface RunLog {
  sessionId?: string
  queued?: Record<string, any>
  started?: Record<string, any>
  ended?: Record<string, any>
  noticed?: boolean
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined)

/** 运行结束时临时目录改名成 `…-rm` 再在后台删:崩在中间的在这里删 */
function sweepDoomedTmp(root: string, log?: Logger): void {
  try {
    for (const name of readdirSync(root)) if (/^mffai-run-.+-rm$/.test(name)) rmSync(join(root, name), { recursive: true, force: true })
  } catch (e) {
    log?.warn('stale run tmp dirs not removed', { code: (e as NodeJS.ErrnoException)?.code })
  }
}

/**
 * 有 queued 没 ended:写 interrupted 的 ended 和通知,删 `mffai-run-<runId>`。
 * 有 ended 没 notice:只补通知(通知结束时只在内存里,要等循环取走才进日志)。
 * 返回第一种,它们的 worktree 由 cleanRecoveredWorktrees 收拾
 */
export function recoverRuns(events: KernelEvent[], append: (e: Omit<KernelEvent, 'seq' | 'ts'>) => unknown, o: { tmpRoot?: string; log?: Logger } = {}): RecoveredRun[] {
  const runs = new Map<string, RunLog>()
  for (const e of events) {
    if (!e.type.startsWith('executor.')) continue
    const p = e.payload as Record<string, any> | null
    const runId = str(p?.runId)
    if (!runId || !p) continue
    const run = runs.get(runId) ?? {}
    runs.set(runId, run)
    if (e.type === 'executor.run.queued') {
      run.queued = p
      run.sessionId = e.sessionId
    } else if (e.type === 'executor.run.started') run.started = p
    else if (e.type === 'executor.run.ended') run.ended = p
    else if (e.type === 'executor.notice') run.noticed = true
  }

  sweepDoomedTmp(o.tmpRoot ?? tmpdir(), o.log)
  const recovered: RecoveredRun[] = []
  for (const [runId, run] of runs) {
    // 写坏的一条不能让后台永远起不来(worker 启动失败就退出)
    try {
      const { queued, started, sessionId } = run
      if (!queued || run.noticed) continue
      const turnId = queued.turnId as string
      const id = str(queued.executor) ?? 'unknown'
      const isolation = (started?.isolation ?? queued.isolation) as Diagnostic['isolation']
      const untranslated = started?.untranslatedRules as number | undefined
      const notice = (d: Omit<Diagnostic, 'id' | 'run' | 'isolation' | 'untranslated'>) =>
        append({ type: 'executor.notice', sessionId, payload: { turnId, runId, text: noticeText({ id, run: runId, isolation, untranslated, ...d }) } } as Omit<KernelEvent, 'seq' | 'ts'>)

      const end = run.ended
      if (end) {
        notice({
          status: end.status, reason: end.reason, exit: end.exit, signal: end.signal, ms: end.ms, changed: end.changed,
          violations: end.violations, usage: end.usage, rawLog: end.rawLog, worktree: end.worktree, final: UNDELIVERED_FINAL,
        })
        continue
      }
      const worktree = str(started?.worktree)
      const changed = { files: [] as string[], source: 'none' as const }
      append({
        type: 'executor.run.ended',
        sessionId,
        payload: { runId, turnId, executor: id, status: 'interrupted', reason: 'daemon_restart', ms: 0, changed, ...(worktree && { worktree }) },
      } as Omit<KernelEvent, 'seq' | 'ts'>)
      notice({ status: 'interrupted', reason: 'daemon_restart', ms: 0, changed, worktree, final: RECOVERY_FINAL })
      recovered.push({ runId, sessionId, started: started !== undefined, ...(str(started?.cwd) && { cwd: started!.cwd }), ...(worktree && { worktree }) })
      // runId 来自日志,拼路径之前先认形状
      if (RUN_ID.test(runId)) {
        try {
          rmSync(join(o.tmpRoot ?? tmpdir(), `mffai-run-${runId}`), { recursive: true, force: true })
        } catch {
          // 删不掉只留一个临时目录
        }
      }
    } catch (e) {
      o.log?.error('run not recovered', { runId: RUN_ID.test(runId) ? runId : 'invalid', error: e instanceof Error ? e.message : 'unknown' })
    }
  }
  return recovered
}

export interface WorktreeCleanup {
  /** worktreeRootOf(dataDir) */
  root: string
  git: Git
  tmpDir?: string
  log: Logger
  /** 会话的 cwd */
  cwdOf(sessionId: string): string | undefined
  /** 会话钉住的仓库:不在了(不认识的会话)就只删目录,不跑 git */
  pinOf(sessionId: string): RepoPin | undefined
  policyOf(sessionId: string, cwd: string): ExecPolicy
}

/**
 * 没起过 CLI 的 worktree 里没有谁要的东西,删掉(占名额,事件里也没有它的路径)。
 * 起过的留着,但 finish 没跑到:`deny read` 根的字面副本在这里删。
 * 路径只用 <根>/<会话>/<运行> 这一个算出来的,日志里写的不用。
 * 同步的部分先做完;返回的 promise 是 git 删 worktree,调用方限时等
 */
export function cleanRecoveredWorktrees(runs: RecoveredRun[], o: WorktreeCleanup): Promise<unknown> {
  let root: string
  try {
    root = realpathSync(o.root)
  } catch {
    return Promise.resolve() // 根不在:没有 worktree
  }
  const removals: Promise<unknown>[] = []
  for (const r of runs) {
    if (!r.sessionId || !RUN_ID.test(r.runId)) continue
    const path = join(root, r.sessionId, r.runId)
    if (relative(root, path).split(sep).length !== 2) continue
    const sessionCwd = o.cwdOf(r.sessionId)
    if (!r.started) {
      if (!existsSync(path)) continue
      removals.push(removeWorktree(o.pinOf(r.sessionId), path, o.git, { root: o.root, tmpDir: o.tmpDir }).catch(e => o.log.warn('recovered worktree not removed', { runId: r.runId, error: e instanceof Error ? e.message : 'unknown' })))
    } else if (r.worktree !== undefined && sessionCwd !== undefined) {
      try {
        const cwd = r.cwd !== undefined && isInside(r.cwd, path, process.platform) ? r.cwd : path
        const prefix = relative(path, cwd)
        const top = prefix && sessionCwd.endsWith(`${sep}${prefix}`) ? sessionCwd.slice(0, -prefix.length - 1) : sessionCwd
        const policy = treePolicy(c => o.policyOf(r.sessionId!, c), sessionCwd, cwd, { session: top, run: path })
        const refused = removeInWorktree(path, denyReadCopies(policy, path))
        if (refused.length > 0) o.log.warn('worktree copy of a denied path not removed', { runId: r.runId, count: refused.length })
      } catch (e) {
        o.log.warn('worktree copy of a denied path not removed', { runId: r.runId, error: e instanceof Error ? e.message : 'unknown' })
      }
    }
  }
  return Promise.allSettled(removals)
}

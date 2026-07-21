import type { AgentProvider } from '../agents/types'
import type { StagePlan } from './machine'
import type { WorkOrderOutcome } from './workOrder'
import type { DevelopProject } from './runTypes'

// ①汇总 (end-of-run summary): the run-completion summary agent migrated from the legacy
// orchestrator's per-stage 汇总 idea, but scoped to the WHOLE run. After a run finishes every stage
// cleanly (RunController.start, `!aborted && all done`), we compose a deterministic digest of every
// lane's self-reported outcome (per-stage, per-project: summary / filesChanged / testsRun) and hand
// it to a lightweight one-shot summarizer that writes a human "本次运行总结". The digest doubles as
// the summarizer's INPUT and its FALLBACK — if the provider has no `.chat`, throws, or times out, we
// surface the digest verbatim rather than blocking the run's finalize gate on a best-effort narrative.

/** One project's / lane's contribution to the digest, distilled from a WorkOrderOutcome. */
function laneLine(o: WorkOrderOutcome): string {
  const who = o.order.project ? `**${o.order.project}**` : '**（根阶段）**'
  if (o.status !== 'ok' || !o.result) {
    return `- ${who} ❌ 失败：${o.error ?? '未知错误'}（尝试 ${o.attempts} 次）`
  }
  const r = o.result
  const parts = [`- ${who} ✅ ${r.summary || '（无说明）'}`]
  if (r.filesChanged.length) parts.push(`  - 改动文件：${r.filesChanged.join('、')}`)
  if (r.testsRun) {
    parts.push(`  - 测试：${r.testsRun.passed ? '通过' : '未通过'}${r.testsRun.detail ? `（${r.testsRun.detail}）` : ''}`)
  }
  if (r.blockers.length) parts.push(`  - 阻塞：${r.blockers.join('；')}`)
  return parts.join('\n')
}

/**
 * Deterministic markdown digest of a whole run's outcomes, grouped by stage in plan order. Reads
 * ONLY what lanes self-reported (WorkOrderOutcome.result — see handoffResult.ts), never git — so it
 * is instant, never fails, and is safe to surface directly as the finalize-gate body / summary card
 * when the LLM summarizer is unavailable. A stage with no recorded outcomes (e.g. a root stage that
 * produced no artifact) is skipped so the digest stays about what actually ran.
 */
export function composeRunDigest(
  stages: StagePlan[],
  outcomes: Record<string, WorkOrderOutcome[]>,
  _projects: DevelopProject[] = [],
): string {
  const blocks: string[] = []
  for (const stage of stages) {
    const list = outcomes[stage.key]
    if (!list || list.length === 0) continue
    const lines = list.map(laneLine).join('\n')
    blocks.push(`### ${stage.name}\n${lines}`)
  }
  if (blocks.length === 0) return '本次运行没有可汇总的产出。'
  return blocks.join('\n\n')
}

/**
 * The summarizer's prompt: hand it the deterministic digest and ask for a tight, human "本次运行总结"
 * in markdown. Deliberately NOT a repo-reading agent — it summarizes the reported outcomes only, so
 * it can't invent changes lanes didn't report. `task` (the original 需求原文) is threaded in as
 * ground truth so the summary can frame the work against what the user actually asked for.
 */
export function buildSummaryPrompt(digest: string, task?: string): string {
  const seed = task ? `【本次需求原文】\n${task}\n\n` : ''
  return [
    '你是 Forge 工作流的收尾汇总助手。下面是本次运行各阶段、各项目子代理自己上报的产出清单。',
    '请据此写一段简洁的「本次运行总结」（中文，markdown），说明本次到底做了什么、改了哪些项目/文件、测试与遗留情况。',
    '要求：只依据下面的清单，不要臆造未上报的改动；先一句话总述，再按项目分点；不写客套话。',
    '',
    `${seed}【各阶段产出清单】\n${digest}`,
  ].join('\n')
}

export interface RunSummaryArgs {
  digest: string
  task?: string
  model: string
  cwd: string
  env: NodeJS.ProcessEnv
  // Best-effort ceiling so a hung summarizer never blocks the run's finalize gate. Falls back to the
  // digest when it fires. Injectable for tests.
  timeoutMs?: number
  setTimer?: (fn: () => void, ms: number) => { clear: () => void }
}

let summarySeq = 0

/**
 * One-shot summarizer (照搬 explain.ts 的 oneShot：provider.chat + onAssistantDelta 累加 +
 * session.done.then(finish, finish) 兜底 + fail-open). Returns the synthesized narrative, or the
 * digest unchanged when the provider has no `.chat`, errors, yields nothing, or exceeds timeoutMs.
 * Never throws and never writes to any chat history (no sessionId). The controller treats a return
 * value of the digest itself as "no LLM narrative" — both are valid finalize-gate bodies.
 */
export function runRunSummary(provider: AgentProvider | undefined, args: RunSummaryArgs): Promise<string> {
  if (!provider?.chat) return Promise.resolve(args.digest)
  const prompt = buildSummaryPrompt(args.digest, args.task)
  const timeoutMs = args.timeoutMs ?? 60_000
  const setTimer = args.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); return { clear: () => clearTimeout(t) } }) // eslint-disable-line
  return new Promise<string>((resolve) => {
    let out = ''
    let settled = false
    let timer: { clear: () => void } | null = null
    const finish = () => {
      if (settled) return
      settled = true
      timer?.clear()
      const note = out.trim()
      resolve(note || args.digest)
    }
    timer = setTimer(finish, timeoutMs)
    try {
      const session = provider.chat!(
        { id: `run-summary-${++summarySeq}`, prompt, model: args.model, cwd: args.cwd },
        { onSession: () => {}, onAssistantDelta: (t) => { out += t }, onThinkDelta: () => {}, onDone: finish, onError: finish },
        args.env,
      )
      session.done.then(finish, finish)
    } catch { finish() }
  })
}

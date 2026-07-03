import type { StageRuntime, AgentRuntime } from '@shared/types'

const HANDOFF_PREFIX = '交接 → '
const ERROR_PREFIX = '错误:'

function handoffSummaries(agent: AgentRuntime): string[] {
  const out: string[] = []
  for (const l of agent.logs) {
    if (l.text.startsWith(HANDOFF_PREFIX)) out.push(l.text.slice(HANDOFF_PREFIX.length).trim())
  }
  return out
}

function errorLines(agent: AgentRuntime): string[] {
  const out: string[] = []
  for (const l of agent.logs) {
    if (l.text.startsWith(ERROR_PREFIX)) out.push(l.text.slice(ERROR_PREFIX.length).trim())
  }
  return out
}

// Deterministic (zero-LLM), idempotent CR report: concatenate every reviewer handoff summary,
// grouped by reviewer name (project for per-project, lens label for multi-lens). PURE: no IO, no
// mutation. Agent-produced summaries are plain text only; renderer paths must escape as usual.
export function buildReviewReport(stage: StageRuntime): string {
  const head = `代码 CR 汇总 · ${stage.agents.length} reviewer`
  const groups = stage.agents.map(a => {
    const summaries = handoffSummaries(a)
    const errs = errorLines(a)
    const body = errs.length
      ? errs.map(e => `  ✗ ${e}`).join('\n')
      : summaries.length
        ? summaries.map(s => `  - ${s}`).join('\n')
        : '  (无交接)'
    return `### ${a.name}\n${body}`
  })
  return `${head}\n\n${groups.join('\n\n')}`
}

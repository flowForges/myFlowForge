import type { RunState, AgentState, ChangeItem, StageRuntime } from '@shared/types'
import type { AgentProvider } from '../agents/types'
import { buildReviewReport } from '../orchestrator/reviewReport'
import { outputFromLogs } from '../orchestrator/gateBody'

// Cap the fallback plan body so a long run's output doesn't flood the chat回流 note.
const STAGE_PLAN_MAX = 2000

export function statusZh(s: AgentState): string {
  return s === 'run' ? '执行中' : s === 'ok' ? '完成' : s === 'err' ? '失败' : '等待'
}

const HANDOFF_PREFIX = '交接 → '
const ERROR_PREFIX = '错误:'
const DOC_PREFIX = '文档 → '

// Deterministic (zero-LLM) per-stage progress note built purely from RunState.
// Reuses the handoff summaries / error lines the orchestrator already pushed into agent.logs.
// PURE: no IO. Untrusted (agent-produced) text is passed through as plain text only.
export function buildStageNote(stage: StageRuntime): string {
  if (stage.key === 'review') return buildReviewReport(stage)

  const n = stage.agents.length
  const head = `${stage.name} · ${statusZh(stage.state)} · ${n} 代理`

  // 收集设计文档路径(在 err 分支之外都可能有;err 分支保持原样不追加)
  const docs: string[] = []
  for (const a of stage.agents) {
    for (const l of a.logs) {
      if (l.text.startsWith(DOC_PREFIX)) docs.push(l.text.slice(DOC_PREFIX.length).trim())
    }
  }
  const docNote = docs.length
    ? `\n\n📄 设计文档:${docs.join(';')} —— 点上方门控卡「打开文档」查看全文`
    : ''

  if (stage.state === 'err') {
    const errs: string[] = []
    for (const a of stage.agents) {
      for (const l of a.logs) {
        if (l.text.startsWith(ERROR_PREFIX)) errs.push(l.text.slice(ERROR_PREFIX.length).trim())
      }
    }
    const tail = errs.slice(-3)
    return tail.length ? `✗ ${head} · 错误:${tail.join(';')}` : `✗ ${head}`
  }

  const handoffs: string[] = []
  for (const a of stage.agents) {
    for (const l of a.logs) {
      if (l.text.startsWith(HANDOFF_PREFIX)) handoffs.push(l.text.slice(HANDOFF_PREFIX.length).trim())
    }
  }
  if (handoffs.length) return `✓ ${head} · 交接:${handoffs.join(';')}${docNote}`

  // No handoff fence (e.g. a design stage where the agent answered without emitting one) — surface the
  // agents' real answer output so the produced plan still reaches the conversation instead of a bare
  // "N 代理" line. Bounded so a long run doesn't flood chat. Falls through to the plain head when the
  // agents produced no `output`-kind lines either.
  const outputs = stage.agents.map(a => outputFromLogs(a.logs)).filter(Boolean)
  if (outputs.length) {
    const body = outputs.join('\n\n')
    const clipped = body.length > STAGE_PLAN_MAX ? body.slice(0, STAGE_PLAN_MAX).trimEnd() + '…' : body
    return `✓ ${head}\n\n${clipped}${docNote}`
  }
  return `${head}${docNote}`
}

export interface MainAgent { provider: AgentProvider; model: string; providerDisplay: string }

export function pickMainAgent(run: RunState, providers: Record<string, AgentProvider>): MainAgent | null {
  const agent = run.stages[0]?.agents[0]
  if (!agent) return null
  const provider = providers[agent.provider]
  if (!provider || !provider.chat) return null
  return { provider, model: agent.model, providerDisplay: provider.displayName }
}

function totalAgents(run: RunState): number {
  return run.stages.reduce((n, s) => n + s.agents.length, 0)
}

export function buildNarration(kind: 'start' | 'done', run: RunState, changes: ChangeItem[]): string {
  const stageList = run.stages.map(s => `${s.name}(${s.agents.length} 代理 · ${statusZh(s.state)})`).join('、')
  if (kind === 'start') {
    return [
      `你正在编排工作区「${run.workspaceName}」的研发流程。`,
      `已确定性编排 ${totalAgents(run)} 个子代理,阶段:${stageList}。`,
      `请用一句简短的中文向用户说明你已经编排了什么(不要 markdown 代码块、不要罗列要点)。`
    ].join('\n')
  }
  const add = changes.filter(c => c.type === 'A').length
  const mod = changes.filter(c => c.type === 'M').length
  const del = changes.filter(c => c.type === 'D').length
  const totalAdd = changes.reduce((n, c) => n + c.add, 0)
  const totalDel = changes.reduce((n, c) => n + c.del, 0)
  return [
    `工作区「${run.workspaceName}」的编排已结束,结果:${statusZh(run.status)}。`,
    `阶段:${stageList}。`,
    `工作树变更:新增 ${add}、修改 ${mod}、删除 ${del} 个文件(共 +${totalAdd} −${totalDel} 行)。`,
    `请用一句简短的中文向用户总结完成情况与变更(不要 markdown 代码块)。`
  ].join('\n')
}

import { useState } from 'react'
import type { SubagentCard } from '@shared/types'

// Built-in Task sub-agents the main agent spawned, surfaced in the chat stream. Each is a collapsed
// card (start → running → result); expand to see the full task prompt + returned result. We only get
// start + final result from the parent stream (the sub-agent runs in a child process), so there are
// no live internal steps — the card shows existence, running/done state, and the result.
function stateLabel(s: SubagentCard['state']): string {
  return s === 'running' ? '运行中' : s === 'error' ? '失败' : '已完成'
}

function Card({ sub }: { sub: SubagentCard }) {
  const [open, setOpen] = useState(false)
  const title = sub.description || sub.subagentType || '探查子代理'
  return (
    <div className={`subagent-card s-${sub.state}`}>
      <button className="sac-head" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <span className="sac-ico" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" />
          </svg>
        </span>
        <span className="sac-title">子代理 · {title}{sub.subagentType && sub.description ? <span className="sac-type"> ({sub.subagentType})</span> : null}</span>
        <span className={`sac-state st-${sub.state}`}>{stateLabel(sub.state)}</span>
        <span className={`sac-caret${open ? ' open' : ''}`} aria-hidden="true">▸</span>
      </button>
      {open && (
        <div className="sac-body">
          {sub.prompt ? (
            <div className="sac-sec">
              <div className="sac-sec-h">任务</div>
              <div className="sac-sec-t">{sub.prompt}</div>
            </div>
          ) : null}
          {sub.result ? (
            <div className="sac-sec">
              <div className="sac-sec-h">结果</div>
              <div className="sac-sec-t">{sub.result}</div>
            </div>
          ) : sub.state === 'running' ? (
            <div className="sac-sec"><div className="sac-sec-t sac-muted">运行中,子代理跑在独立进程里,完成后回传结果…</div></div>
          ) : null}
        </div>
      )}
    </div>
  )
}

export function SubagentCards({ subagents }: { subagents: SubagentCard[] }) {
  if (!subagents.length) return null
  return (
    <div className="subagent-cards">
      <div
        className="sac-lead"
        title="这是主代理(所选 CLI,如 Claude Code)在这轮里用自己的 Task 工具开的原生子代理去探查 —— 不是 Forge 工作流的阶段代理。工作流阶段代理只在你批准方案、工作流真正运行时才出现,显示在工作流泳道里。没有卡片时 = 主代理自己直接看的代码。"
      >
        <span className="sac-lead-dot" aria-hidden="true" />
        主代理派出的原生子代理(它自己去探查,非工作流阶段代理)
      </div>
      {subagents.map(s => <Card key={s.id} sub={s} />)}
    </div>
  )
}

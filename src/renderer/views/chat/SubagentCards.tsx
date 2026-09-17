import { useState } from 'react'
import type { SubagentCard } from '@shared/types'
import { SubagentSpinner } from './Spinners'

// Built-in Task sub-agents the main agent spawned, surfaced in the chat stream. Each is a collapsed
// card (start → running → result); expand to see the full task prompt + returned result. We only get
// start + final result from the parent stream (the sub-agent runs in a child process), so there are
// no live internal steps — the card shows existence, running/done state, and the result.
function stateLabel(s: SubagentCard['state']): string {
  return s === 'running' ? '运行中' : s === 'error' ? '失败' : '已完成'
}

function Card({ sub, live }: { sub: SubagentCard; live: boolean }) {
  const [open, setOpen] = useState(false)
  const title = sub.description || sub.subagentType || '探查子代理'
  // A sub-agent card can only be genuinely '运行中' while the turn is still streaming. On a settled
  // (persisted / reloaded) message a 'running' state is a lost terminal event — the turn is over, so the
  // sub-agent is too. Render it as ended ('已完成') instead of a card frozen at 运行中 forever.
  const state: SubagentCard['state'] = !live && sub.state === 'running' ? 'done' : sub.state
  return (
    <div className={`subagent-card s-${state}`}>
      <button className="sac-head" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        {/* ★★跑的时候是**开口圆弧**(和 `ThinkBlock` 用的是同一个 `.spin`,整个 app 一套 spinner),
            跑完换成一个**静止的**图标。
            ★原来是一枚放大镜整个绕中心转 —— 一个有手柄的图形绕中心旋转,手柄会甩圈,
             看起来就是乱晃而不是「在转」(2026-09-17 用户:「这个图标太丑了」)。
             圆弧没有这个问题:它本来就是为旋转画的。 */}
        <span className="sac-ico" aria-hidden="true">
          {state === 'running' ? (
            <SubagentSpinner size={14} />
          ) : (
            // 静止态用一枚「分支出去的节点」—— 子 agent 就是从主线上分出去的一条。
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="6" cy="6" r="2.4" /><circle cx="18" cy="17.5" r="2.4" />
              <path d="M6 8.4v4.6a4 4 0 0 0 4 4h5.6" />
            </svg>
          )}
        </span>
        <span className="sac-title">子代理 · {title}{sub.subagentType && sub.description ? <span className="sac-type"> ({sub.subagentType})</span> : null}</span>
        <span className={`sac-state st-${state}`}>{stateLabel(state)}</span>
        <span className={`sac-caret${open ? ' open' : ''}`} aria-hidden="true">▸</span>
      </button>
      {/* Collapsed: the sub-agent's latest tool call, so its live activity is legible without expanding
          every card — the point is not to look frozen while N sub-agents探查. */}
      {sub.steps?.length && !open ? <div className="sac-activity" title={sub.steps[sub.steps.length - 1]}>{sub.steps[sub.steps.length - 1]}</div> : null}
      {open && (
        <div className="sac-body">
          {sub.prompt ? (
            <div className="sac-sec">
              <div className="sac-sec-h">任务</div>
              <div className="sac-sec-t">{sub.prompt}</div>
            </div>
          ) : null}
          {sub.steps?.length ? (
            <div className="sac-sec">
              <div className="sac-sec-h">执行步骤 ({sub.steps.length})</div>
              <div className="sac-steps">{sub.steps.map((s, i) => <div className="sac-step" key={i}>{s}</div>)}</div>
            </div>
          ) : null}
          {sub.result ? (
            <div className="sac-sec">
              <div className="sac-sec-h">结果</div>
              <div className="sac-sec-t">{sub.result}</div>
            </div>
          ) : state === 'running' ? (
            <div className="sac-sec"><div className="sac-sec-t sac-muted">运行中,子代理跑在独立进程里,实时回传它的工具调用…</div></div>
          ) : null}
        </div>
      )}
    </div>
  )
}

export function SubagentCards({ subagents, live = false }: { subagents: SubagentCard[]; live?: boolean }) {
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
      {subagents.map(s => <Card key={s.id} sub={s} live={live} />)}
    </div>
  )
}

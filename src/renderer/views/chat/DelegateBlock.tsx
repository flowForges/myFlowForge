import { useState } from 'react'
import type { DelegateBatch, DelegateBatchAgent } from '@shared/types'

// Live progress block for a fire-and-forget delegate batch (forge_delegate). The main agent's turn ends
// as soon as it dispatches, so this collapsible block — rendered below the reply — is how the user watches
// the N background sub-agents actually execute: each row shows its live status, its 最近一步动作 (activity),
// and its streaming/final output. Reuses the `.subagent-card`/`.sac-*` styling; delegate-specific bits
// (live dot + activity line) add a few small classes in chat.css. Live-only — never persisted.

// run → 运行中 → reuse the "running" card visuals; ok → done; idle = failed/timed-out → error visuals.
function cardState(s: DelegateBatchAgent['status']): 'running' | 'done' | 'error' {
  return s === 'run' ? 'running' : s === 'ok' ? 'done' : 'error'
}
function stateLabel(s: DelegateBatchAgent['status']): string {
  return s === 'run' ? '运行中' : s === 'ok' ? '已完成' : '失败 / 超时'
}

function AgentRow({ agent }: { agent: DelegateBatchAgent }) {
  const [open, setOpen] = useState(false)
  const cs = cardState(agent.status)
  return (
    <div className={`subagent-card s-${cs}`}>
      <button className="sac-head" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <span className={`dg-dot dg-${agent.status}`} aria-hidden="true" />
        <span className="sac-title">{agent.name}<span className="sac-type"> ({agent.provider})</span></span>
        <span className={`sac-state st-${cs}`}>{stateLabel(agent.status)}</span>
        <span className={`sac-caret${open ? ' open' : ''}`} aria-hidden="true">▸</span>
      </button>
      {/* Collapsed rows still show the live 最近一步动作 so the batch is legible at a glance without
          expanding every row — that liveness is the whole point of the block. */}
      {agent.activity && !open ? <div className="dg-activity" title={agent.activity}>{agent.activity}</div> : null}
      {open && (
        <div className="sac-body">
          {agent.activity ? (
            <div className="sac-sec"><div className="sac-sec-h">最近一步</div><div className="sac-sec-t">{agent.activity}</div></div>
          ) : null}
          {agent.output ? (
            <div className="sac-sec"><div className="sac-sec-h">输出</div><div className="sac-sec-t">{agent.output}</div></div>
          ) : agent.status === 'run' ? (
            <div className="sac-sec"><div className="sac-sec-t sac-muted">运行中,子代理跑在独立进程里,实时回传进度…</div></div>
          ) : null}
        </div>
      )}
    </div>
  )
}

export function DelegateBlock({ batch }: { batch: DelegateBatch }) {
  if (!batch.agents.length) return null
  const running = batch.agents.filter(a => a.status === 'run').length
  return (
    <div className="subagent-cards">
      <div className="sac-lead" title="这是主代理用 forge_delegate 派到后台执行的委派子代理(fire-and-forget)。主代理拿到「已派发」就结束了本轮,这个块让你实时看到后台子代理在做什么、是否卡住;它们全部完成后会另有一条汇总消息回到会话。">
        <span className={`sac-lead-dot${batch.done ? '' : ' live'}`} aria-hidden="true" />
        {batch.done ? `委派子代理 · ${batch.agents.length} 个已完成` : `委派子代理 · ${running} 个执行中 / 共 ${batch.agents.length}`}
      </div>
      {batch.agents.map(a => <AgentRow key={a.agentId} agent={a} />)}
    </div>
  )
}

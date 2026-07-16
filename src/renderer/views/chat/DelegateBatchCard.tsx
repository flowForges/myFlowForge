import { useState } from 'react'
import type { DelegateBatch, DelegateBatchAgent } from '@shared/types'

// A lightweight-delegation batch surfaced live in the chat stream (below the main agent's reply).
// Delegation is fire-and-forget: the main turn ends right after dispatch while the N sub-agents keep
// running in the background. Without this block the only place to see them run is the IDs panel. So we
// show a compact, collapsible list — one row per sub-agent, live 运行中 → 已完成 / 失败 — and each row
// expands to reveal its 输入 (the delegated task) and 输出 (its returned result). The aggregated
// conclusions still arrive afterwards as their own summary message.

function statusLabel(s: DelegateBatchAgent['status']): string {
  return s === 'run' ? '运行中' : s === 'ok' ? '已完成' : '失败'
}

function Row({ agent, task, brief }: { agent: DelegateBatchAgent; task: string; brief?: string }) {
  const [open, setOpen] = useState(false)
  return (
    <li className={`db-row r-${agent.status}${open ? ' open' : ''}`}>
      <button className="db-rowhead" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <span className="db-dot" aria-hidden="true" />
        <span className="db-name">{agent.name}</span>
        <span className="db-prov">{agent.provider}</span>
        <span className="db-rowstate">{statusLabel(agent.status)}</span>
        <span className={`db-rowcaret${open ? ' open' : ''}`} aria-hidden="true">▸</span>
      </button>
      {open && (
        <div className="db-rowbody">
          <div className="db-sec">
            <div className="db-sec-h">输入</div>
            <div className="db-sec-t">{brief ? `${brief}\n\n${task}` : task}</div>
          </div>
          <div className="db-sec">
            <div className="db-sec-h">输出</div>
            {agent.output
              ? <div className="db-sec-t">{agent.output}</div>
              : <div className="db-sec-t db-muted">{agent.status === 'run' ? '运行中,子代理跑在独立进程里,完成后回传结论…' : '(无产出)'}</div>}
          </div>
        </div>
      )}
    </li>
  )
}

export function DelegateBatchCard({ batch }: { batch: DelegateBatch }) {
  const [open, setOpen] = useState(true)
  const n = batch.agents.length
  const done = batch.agents.filter(a => a.status !== 'run').length
  const failed = batch.agents.filter(a => a.status === 'idle').length
  const state: 'run' | 'ok' | 'idle' = !batch.done ? 'run' : failed === n && n > 0 ? 'idle' : 'ok'
  const head = !batch.done
    ? `运行中 · ${done}/${n} 完成`
    : failed
      ? `完成 · ${n - failed}/${n} 成功`
      : `全部完成 · ${n}`
  return (
    <div className={`delegate-batch db-${state}`}>
      <button className="db-head" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <span className="db-ico" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 3v4M12 17v4M3 12h4M17 12h4" /><circle cx="12" cy="12" r="3.2" />
          </svg>
        </span>
        <span className="db-title">委派子代理 · {n} 个</span>
        <span className={`db-state st-${state}`}>{head}</span>
        <span className={`db-caret${open ? ' open' : ''}`} aria-hidden="true">▸</span>
      </button>
      {open && (
        <ul className="db-list">
          {batch.agents.map(a => <Row key={a.agentId} agent={a} task={batch.task} brief={batch.brief} />)}
        </ul>
      )}
    </div>
  )
}

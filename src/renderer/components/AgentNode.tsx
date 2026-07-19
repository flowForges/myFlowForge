import { useState } from 'react'
import type { AgentRuntime } from '@shared/types'
import { fmtLogClock, fmtDuration } from '@shared/relTime'
import { AgentContextMeta } from './AgentContextMeta'
import { useStickToBottom } from './useStickToBottom'

const STATE_MAP: Record<string, { cls: string; label: string }> = {
  wait: { cls: 'st-wait', label: '等待' },
  run:  { cls: 'st-run',  label: '执行中' },
  stalled:  { cls: 'st-stalled',  label: '疑似卡住' },
  awaiting: { cls: 'st-awaiting', label: '等待确认' },
  ok:   { cls: 'st-ok',   label: '完成' },
  err:  { cls: 'st-err',  label: '失败' },
}

const LOG_LEVEL_CLS: Record<string, string> = {
  info:   '',
  ok:     'ok',
  accent: 'ac',
  run:    'run',
}

// Per-kind class + tiny inline icon, so the running card's 执行过程 reads at a glance.
const KIND_CLS: Record<string, string> = {
  think:  'k-think',
  tool:   'k-tool',
  file:   'k-file',
  output: 'k-output',
}
const KIND_ICON: Record<string, string> = {
  think:  '💭',
  tool:   '⚙',
  file:   '📄',
  output: '▸',
}

// Per-agent CONTEXT USAGE bar (1:1 with the prototype `.agent-ctx`). Omitted entirely when
// the agent has no usage data yet (ctxPct == null).
function CtxBar({ agent }: { agent: AgentRuntime }) {
  if (agent.ctxPct == null) return null
  const pct = Math.max(0, Math.min(100, agent.ctxPct))
  const max = agent.ctxMax ?? 200
  const usedK = Math.round((pct / 100) * max)
  const lvl = pct >= 90 ? 'danger' : pct >= 75 ? 'warn' : ''
  const note = pct >= 90 ? ' · 接近上限' : pct >= 75 ? ' · 偏高' : ''
  return (
    <div className={`agent-ctx${lvl ? ' ' + lvl : ''}`}>
      <span className="actx-lab">上下文</span>
      <span className="actx-bar"><i className={lvl || undefined} style={{ width: `${pct}%` }} /></span>
      <span className={`actx-num${lvl ? ' ' + lvl : ''}`}><b>{usedK}K</b> / {max}K · {pct}%{note}</span>
    </div>
  )
}

function contextCount(agent: AgentRuntime): number {
  const ctx = agent.context
  if (!ctx) return 0
  return ctx.skills.length + ctx.rules.length + (ctx.mcps?.length ?? 0)
}

function heartbeatLabel(lastBeat?: number): string | null {
  if (!lastBeat) return null
  const secs = Math.max(0, Math.round((Date.now() - lastBeat) / 1000))
  if (secs < 3) return '心跳 刚刚'
  if (secs < 60) return `心跳 ${secs}s 前`
  return `心跳 ${Math.round(secs / 60)}m 前`
}

// Improvement ⑥: this lane's own elapsed execution time, from AgentRuntime.laneStartedAt/laneEndedAt
// (populated by runExecAdapter from RunController.laneTimings — see its doc). `null` until the lane
// has actually started (a fan-out card can render before its turn, with no timing yet). While still
// running (no laneEndedAt), elapsed is computed against `Date.now()` — the card re-renders on every
// onUpdate the controller emits during a live run (progress/log/gate/etc., see RunExecPanel), which
// is frequent enough to read as "ticking" without a dedicated setInterval (deliberately not added,
// per this task's own guidance against over-engineering a live ticker here).
//
// `live` distinguishes an actively-running panel from a read-only historical replay (RunExecPanel's
// `staticState`/`readOnly`). A lane with no `endedAt` in a LIVE run is genuinely still going, so it
// ticks against `Date.now()`. The same shape in a historical replay means the process was killed
// mid-lane (app crash/force-quit) before it could record `laneEndedAt` — ticking against "now" would
// render a nonsense "minutes since the crash" duration, so read-only mode reports it as unfinished
// instead.
function elapsedLabel(startedAt: number | undefined, endedAt: number | undefined, live: boolean): string | null {
  if (!startedAt) return null
  if (endedAt == null && !live) return '未完成'
  return fmtDuration((endedAt ?? Date.now()) - startedAt)
}

interface AgentNodeProps {
  agent: AgentRuntime
  /** Controlled open state. If provided, AgentNode is controlled. */
  open?: boolean
  /** Controlled toggle callback. If provided, AgentNode is controlled. */
  onToggle?: () => void
  /** When provided, shows a "在日志台查看" affordance that opens the bottom log drawer for this agent. */
  onViewLog?: () => void
  /** Whether this card belongs to a LIVE running panel vs a read-only historical replay. Defaults
   *  to `true` (existing callers — a live run or WorkspaceView's old tab — keep ticking). Only
   *  RunExecPanel's read-only/`staticState` replay path passes `false` — see `elapsedLabel` above. */
  live?: boolean
}

export function AgentNode({ agent, open: openProp, onToggle, onViewLog, live = true }: AgentNodeProps) {
  const [openLocal, setOpenLocal] = useState(agent.state === 'run')
  // If onToggle is provided, use controlled mode; otherwise uncontrolled
  const isControlled = onToggle !== undefined
  const open = isControlled ? (openProp ?? false) : openLocal
  const stateInfo = STATE_MAP[agent.state] ?? STATE_MAP.wait
  const beatLabel = heartbeatLabel(agent.lastBeat)
  const elapsed = elapsedLabel(agent.laneStartedAt, agent.laneEndedAt, live)
  const ctxCount = contextCount(agent)
  // Follow-tail: keep the live output pinned to the newest line; when the user scrolls up, surface a
  // "查看最新" jump button. Re-pins on new lines only while already at the bottom.
  const log = useStickToBottom(agent.logs.length)

  const handleToggle = () => {
    if (isControlled) {
      onToggle()
    } else {
      setOpenLocal(o => !o)
    }
  }

  return (
    <div className={`agent-node${open ? ' open' : ''}`}>
      <button
        className={`agent-card${agent.state === 'run' ? ' run' : ''}`}
        aria-label={agent.name}
        onClick={handleToggle}
      >
        <div className="agent-top">
          <div className="agent-ic">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <polyline points="4 17 10 11 4 5" />
              <line x1="12" y1="19" x2="20" y2="19" />
            </svg>
          </div>
          <div className="agent-meta">
            <span className="agent-name">{agent.name}</span>
            <span className="agent-role">{agent.role}</span>
            <span className="agent-model">
              <span className={`prov-dot p-${agent.provider}`} />
              {agent.model}
              {(agent as AgentRuntime & { ver?: string }).ver && (
                <span className="ver">· {(agent as AgentRuntime & { ver?: string }).ver}</span>
              )}
            </span>
          </div>
          <span className={`agent-state ${stateInfo.cls}`}>
            <span className="d" />
            {stateInfo.label}
          </span>
          {elapsed && <span className="agent-elapsed" title="该项目本阶段执行耗时">{elapsed}</span>}
          {beatLabel && <span className="agent-beat">{beatLabel}</span>}
          <svg className="agent-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
            <polyline points="9 6 15 12 9 18" />
          </svg>
        </div>
        {/* Context-usage bar TEMPORARILY HIDDEN — the flat input+cache ÷ 200K estimate saturated to
            100%/接近上限 on every agent and misled users. Re-enable once a faithful per-turn real-context
            reading replaces the estimate (CtxBar kept for that swap). */}
        {false && <CtxBar agent={agent} />}
      </button>
      <div className="agent-log">
        <div className={`proc-head${agent.state === 'run' ? ' run' : ''}`}>
          <span className="ph-dot" />
          执行过程 · {agent.name}
          {agent.context && <span className="ctx-count">{ctxCount} 项上下文</span>}
          {onViewLog && (
            <button
              className="proc-expand"
              title="在底部「实时日志」中查看该代理的完整输出"
              onClick={(e) => { e.stopPropagation(); onViewLog() }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" />
                <line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" />
              </svg>
              日志台
            </button>
          )}
        </div>
        {/* Fixed-height, internally-scrolling output — so N parallel running cards don't each grow
            unbounded and crush the inspector. Full output is one click away in the bottom drawer. */}
        {open && (
          <div className="agent-log-wrap">
            <div className="agent-log-lines" ref={log.ref} onScroll={log.onScroll}>
              {agent.logs.map((line, i) => {
                const lvlCls = LOG_LEVEL_CLS[line.level] ?? ''
                const kindCls = line.kind ? (KIND_CLS[line.kind] ?? '') : ''
                const kindIcon = line.kind ? KIND_ICON[line.kind] : undefined
                const isLast = i === agent.logs.length - 1
                return (
                  <div key={i} className={`log-line${lvlCls ? ' ' + lvlCls : ''}${kindCls ? ' ' + kindCls : ''}`}>
                    <span className="tk">{fmtLogClock(line.ts)}</span>
                    <span className={`tx${lvlCls ? ' ' + lvlCls : ''}`}>
                      {kindIcon && <span className="k-ic">{kindIcon} </span>}
                      {line.text}
                      {agent.state === 'run' && isLast && <span className="log-cursor" />}
                    </span>
                  </div>
                )
              })}
            </div>
            {!log.atBottom && agent.logs.length > 0 && (
              <button className="log-jump" onClick={(e) => { e.stopPropagation(); log.scrollToBottom() }} title="跳到最新输出">
                查看最新
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
            )}
          </div>
        )}
        {open && agent.context && (
          <>
            <div className="proc-head ctx-proc-head">
              <span className="ph-dot" />
              已加载 Skill / Rule / MCP
            </div>
            <AgentContextMeta context={agent.context} mini />
          </>
        )}
      </div>
    </div>
  )
}

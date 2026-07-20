import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import './logcon.css'
import type { LogLine } from '../state/logReducer'
import { LEVEL_LABELS } from '../state/logReducer'

type Filter = 'all' | 'think' | 'exec' | 'file' | 'out'

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all',   label: '全部' },
  { key: 'think', label: '思考' },
  { key: 'exec',  label: '执行' },
  { key: 'file',  label: '文件' },
  { key: 'out',   label: '输出' },
]

export interface LogConsoleProps {
  open: boolean
  dual?: boolean
  focused?: boolean
  onHandleDown?: (e: ReactPointerEvent) => void
  logs: LogLine[]
  busy: boolean
  onClear: () => void
  onClose: () => void
  /** When set, only this agent's lines are shown (matched by id against LogLine.filterId, falling back to .src). */
  agentFilter?: { id: string; name: string } | null
  onClearAgentFilter?: () => void
}

export function LogConsole({ open, dual, focused, onHandleDown, logs, busy, onClear, onClose, agentFilter, onClearAgentFilter }: LogConsoleProps) {
  const [filter, setFilter] = useState<Filter>('all')
  const [auto, setAuto] = useState(true)
  const bodyRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom when auto is on
  useEffect(() => {
    if (auto && open && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight
    }
  }, [logs, auto, open])

  return (
    <div className={`logcon${open ? ' open' : ''}${dual ? ' dual' : ''}${focused ? ' focused' : ''}`} role="log" aria-label="实时日志">
      {onHandleDown && <div className="panel-resizer" data-resize-panel="log" onPointerDown={onHandleDown} role="separator" aria-orientation="horizontal" title="拖动调整高度" />}
      {/* Header */}
      <div className="logcon-head">
        <span className="tt">
          <span className={`lg-dot${busy ? ' run' : ''}`} />
          实时日志
        </span>

        {/* Filters */}
        <div className="logcon-filters">
          {FILTERS.map(f => (
            <button
              key={f.key}
              className={`lgf${filter === f.key ? ' on' : ''}`}
              data-lf={f.key}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
            </button>
          ))}
          {agentFilter && (
            <button
              className="lgf lgf-agent on"
              aria-label="清除代理过滤"
              title="清除代理过滤,显示全部代理"
              onClick={() => onClearAgentFilter?.()}
            >
              仅看 {agentFilter.name}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
            </button>
          )}
        </div>

        {/* Actions */}
        <div className="logcon-act">
          {/* Auto-scroll toggle */}
          <button
            className={`lg-btn${auto ? ' on' : ''}`}
            title="自动滚动到底部"
            onClick={() => setAuto(a => !a)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="12" y1="5" x2="12" y2="19" />
              <polyline points="19 12 12 19 5 12" />
            </svg>
            自动滚动
          </button>

          {/* Clear */}
          <button className="lg-btn" title="清空日志" onClick={onClear}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
            清空
          </button>

          {/* Close */}
          <button className="lg-btn" title="关闭" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="logcon-body" ref={bodyRef}>
        {logs.length === 0 ? (
          <div className="lg-empty">
            暂无日志 · 与主代理对话后,思考与执行过程会实时显示在这里
          </div>
        ) : (
          logs.map(line => {
            // Matched against `filterId` when the line carries one (run2 lines — see LogLine's doc,
            // `src` there is a shared stage name, not unique per lane) and falls back to `src`
            // otherwise (the pre-existing/old-orchestrator behavior, unchanged).
            const hidden = (filter !== 'all' && filter !== line.level) || (!!agentFilter && (line.filterId ?? line.src) !== agentFilter.id)
            return (
              <div
                key={line.id}
                className={`lg-line l-${line.level}${line.streaming ? ' streaming' : ''}${hidden ? ' hide' : ''}`}
              >
                <span className="lg-time">{line.t}</span>
                <span className="lg-lvl">{LEVEL_LABELS[line.level]}</span>
                <span className="lg-src">
                  <span className="pd" style={{ background: line.color }} />
                  {line.src}
                </span>
                <span className="lg-msg">{line.text}</span>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

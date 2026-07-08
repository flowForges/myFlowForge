import { useEffect, useRef, useState } from 'react'
import type { AppLogEntry, LogLevel } from '@shared/types'
import { fmtMsgTimeFull } from '@shared/relTime'
import './debugLog.css'

const LEVELS: { key: LogLevel | 'all'; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'error', label: '错误' },
  { key: 'warn', label: '警告' },
  { key: 'info', label: '信息' },
  { key: 'debug', label: '调试' },
]
const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }
const MAX = 3000

export function filterByScope(entries: AppLogEntry[], scope: string | null): AppLogEntry[] {
  return scope ? entries.filter(e => e.scope === scope) : entries
}

interface DebugLogPaneProps {
  perfStallToast?: boolean
  onTogglePerfToast?: (v: boolean) => void
}

export function DebugLogPane({ perfStallToast = false, onTogglePerfToast }: DebugLogPaneProps = {}) {
  const [entries, setEntries] = useState<AppLogEntry[]>([])
  const [level, setLevel] = useState<LogLevel | 'all'>('all')
  const [scopeFilter, setScopeFilter] = useState<string | null>(null)
  const [autoScroll, setAutoScroll] = useState(true)
  const [toast, setToast] = useState<string | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)

  const reload = () => { void window.forge.appLogGet().then(setEntries) }

  useEffect(() => {
    reload()
    const off = window.forge.onAppLogEvent((e) => setEntries(prev => {
      const next = prev.length >= MAX ? [...prev.slice(prev.length - MAX + 1), e] : [...prev, e]
      return next
    }))
    return () => { off() }
  }, [])

  useEffect(() => {
    if (autoScroll && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight
  }, [entries, autoScroll, level])

  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(null), 1600) }

  const onExport = async () => {
    const r = await window.forge.appLogExport()
    if (r.ok) flash('已导出到 ' + r.path)
    else if (!r.canceled) flash('导出失败：' + (r.error ?? '未知错误'))
  }
  const onClear = async () => { setEntries(await window.forge.appLogClear()) }
  const onCopyAll = () => {
    const text = shown.map(fmt).join('\n')
    void navigator.clipboard?.writeText(text)
    flash('已复制 ' + shown.length + ' 行')
  }

  const scoped = filterByScope(entries, scopeFilter)
  const shown = level === 'all' ? scoped : scoped.filter(e => RANK[e.level] >= RANK[level as LogLevel])
  const errs = entries.filter(e => e.level === 'error').length

  return (
    <div className="set-group debug-log-pane">
      <div className="dl-head">
        <div>
          <h4>调试日志</h4>
          <p>记录 app 运行与编码代理(codex/claude…)失败详情。出问题时可导出日志排查。</p>
          <label className="dl-auto" style={{ marginTop: 6 }}>
            <input
              type="checkbox"
              checked={perfStallToast}
              onChange={e => onTogglePerfToast?.(e.target.checked)}
            />
            在通知里提示主进程卡顿(开发者诊断，默认关闭；卡顿始终记录到上方日志)
          </label>
        </div>
        <div className="dl-actions">
          <button className="set-btn" onClick={reload}>刷新</button>
          <button className="set-btn" onClick={onCopyAll} disabled={!shown.length}>复制</button>
          <button className="set-btn" onClick={onExport} disabled={!entries.length}>导出日志</button>
          <button className="set-btn danger" onClick={onClear} disabled={!entries.length}>清空</button>
        </div>
      </div>

      <div className="dl-bar">
        <div className="dl-filters">
          {LEVELS.map(l => (
            <button key={l.key} className={'dl-fch' + (level === l.key ? ' on' : '')} onClick={() => setLevel(l.key)}>{l.label}</button>
          ))}
          <button className={'dl-fch' + (scopeFilter === 'perf' ? ' on' : '')} onClick={() => setScopeFilter(scopeFilter === 'perf' ? null : 'perf')}>性能</button>
        </div>
        <span className="dl-stat">{shown.length} 条{errs ? ` · ${errs} 错误` : ''}</span>
        <label className="dl-auto"><input type="checkbox" checked={autoScroll} onChange={e => setAutoScroll(e.target.checked)} />自动滚动</label>
      </div>

      <div className="dl-body" ref={bodyRef}>
        {shown.length === 0 ? (
          <div className="proj-empty">暂无日志。运行工作流或对话后,这里会记录过程与错误。</div>
        ) : (
          shown.map((e, i) => (
            <div key={i} className={'dl-line lv-' + e.level}>
              <span className="dl-ts" title={fmtMsgTimeFull(e.ts)}>{tsClock(e.ts)}</span>
              <span className={'dl-lv lv-' + e.level}>{e.level}</span>
              <span className="dl-scope">{e.scope}</span>
              <span className="dl-msg">{e.msg}</span>
              {e.detail ? <pre className="dl-detail">{e.detail}</pre> : null}
            </div>
          ))
        )}
      </div>
      {toast ? <div className="dl-toast">{toast}</div> : null}
    </div>
  )
}

function tsClock(ts: string): string {
  const d = new Date(ts)
  if (isNaN(d.getTime())) return ts.slice(11, 19)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function fmt(e: AppLogEntry): string {
  const base = `${fmtMsgTimeFull(e.ts) || e.ts} [${e.level}] [${e.scope}] ${e.msg}`
  return e.detail ? `${base}\n    ${e.detail.replace(/\n/g, '\n    ')}` : base
}

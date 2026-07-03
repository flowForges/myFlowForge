import { useEffect, useRef, useState } from 'react'
import type { StatusbarUsage, UsageWindow } from '@shared/plugins'

export interface UsagePopoverProps {
  usage: StatusbarUsage
  children: React.ReactNode
}

// Percentage used → bar color tier. Mirrors the prototype: ≥90% danger, ≥70% warn, else ok.
function lvl(pct: number): 'ok' | 'warn' | 'danger' {
  return pct >= 90 ? 'danger' : pct >= 70 ? 'warn' : 'ok'
}

function pctOf(w: UsageWindow): number {
  if (!(w.limit > 0)) return 0
  return Math.min(100, Math.max(0, Math.round((w.used / w.limit) * 100)))
}

function fmtResetAt(resetAt: number): string {
  const diff = resetAt - Date.now()
  if (diff <= 0) return '即将重置'
  const h = Math.floor(diff / 3_600_000)
  const m = Math.floor((diff % 3_600_000) / 60_000)
  if (h >= 24) {
    const d = Math.floor(h / 24)
    return `${d} 天 ${h % 24} 小时后重置`
  }
  if (h > 0) return `${h} 小时 ${m} 分后重置`
  return `${m} 分后重置`
}

function UsageBar({ name, win }: { name: string; win: UsageWindow }) {
  const pct = pctOf(win)
  return (
    <div className="sbp-bar">
      <div className="sbp-brow">
        <span className="sbp-bname">{name}</span>
        <span className="sbp-bpct">{pct}%</span>
      </div>
      <div className="sbp-track">
        <div className={`sbp-fill ${lvl(pct)}`} style={{ width: `${pct}%` }} />
      </div>
      {win.resetAt != null && <div className="sbp-reset">{fmtResetAt(win.resetAt)}</div>}
    </div>
  )
}

export function UsagePopover({ usage, children }: UsagePopoverProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // Outside-click closes the popover (mirrors NotificationPopover pattern)
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('click', onDoc)
    return () => document.removeEventListener('click', onDoc)
  }, [open])

  const { window5h, weekly, label } = usage

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <div onClick={() => setOpen(o => !o)}>{children}</div>

      <div className={`usage-pop${open ? ' on' : ''}`}>
        {label && <div className="up-label">{label}</div>}
        {window5h && <UsageBar name="5 小时限额" win={window5h} />}
        {weekly && <UsageBar name="周限额" win={weekly} />}
        {!window5h && !weekly && <div className="up-empty">暂无用量数据</div>}
      </div>
    </div>
  )
}

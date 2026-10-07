import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
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
  const [pos, setPos] = useState<{ bottom: number; left: number } | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  // Outside-click / Esc / resize closes the popover (same as HostSwitcher).
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    const onResize = () => setOpen(false)
    document.addEventListener('click', onDoc)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('click', onDoc)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onResize)
    }
  }, [open])

  const toggle = () => {
    if (!open) {
      const r = ref.current?.getBoundingClientRect()
      // 往上弹,锚 bottom:按钮贴着窗口底边。
      if (r) setPos({ bottom: Math.max(0, window.innerHeight - r.top + 6), left: Math.max(6, r.left) })
    }
    setOpen(o => !o)
  }

  const { window5h, weekly, label } = usage

  // ★★2026-10-07「点了没反应」:弹层原来是按钮旁边的 `position:absolute`,而 `.sb-models` 是
  //  `overflow-x:auto`(装多了能横滑,见 shell.css)—— 这会把 y 方向也变成裁剪,再加上 `.statusbar`
  //  自己的 `overflow:hidden`,往上弹的弹层**整个被裁掉**:打开了,但看不见。
  //  所以和 HostSwitcher 一样 portal 到 body、按按钮的视口矩形定位,谁也裁不到它。
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <div onClick={toggle}>{children}</div>

      {open && pos && createPortal(
        <div
          className="usage-pop on"
          style={{ position: 'fixed', bottom: pos.bottom, left: pos.left }}
          onClick={(e) => e.stopPropagation()}
        >
          {label && <div className="up-label">{label}</div>}
          {window5h && <UsageBar name="5 小时限额" win={window5h} />}
          {weekly && <UsageBar name="周限额" win={weekly} />}
          {!window5h && !weekly && <div className="up-empty">暂无用量数据</div>}
        </div>,
        document.body,
      )}
    </div>
  )
}

import { useEffect, useRef, useState, type ReactNode } from 'react'

export interface WsMenuItem {
  key: string
  label: string
  icon: ReactNode
  danger?: boolean
  onClick: () => void
}

const DOTS_ICON = (
  <svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>
)

// 工作区行「更多操作」下拉 —— 把原来一排容易误点的图标按钮收进一个 ⋯ 菜单(图标+文字)。
// 复用 UsagePopover 的「点击外部关闭」惯用法。菜单项点击后先关闭再执行,确认弹层由上层负责。
// `open`/`onOpenChange` optionally control the menu from the parent (e.g. a right-click on the row
// opens it). Uncontrolled (own state) when omitted.
export function WsMenu({ items, open: openProp, onOpenChange }: { items: WsMenuItem[]; open?: boolean; onOpenChange?: (o: boolean) => void }) {
  const [openLocal, setOpenLocal] = useState(false)
  const open = openProp ?? openLocal
  const setOpen = (o: boolean | ((p: boolean) => boolean)) => {
    const next = typeof o === 'function' ? o(open) : o
    if (onOpenChange) onOpenChange(next); else setOpenLocal(next)
  }
  const ref = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('click', onDoc)
    return () => document.removeEventListener('click', onDoc)
  }, [open])

  return (
    <span ref={ref} className={`ws-menu${open ? ' open' : ''}`}>
      <span
        className="ws-act ws-menu-btn"
        role="button"
        title="更多操作"
        aria-label="更多操作"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={e => { e.stopPropagation(); setOpen(o => !o) }}
      >
        {DOTS_ICON}
      </span>
      {open && (
        <div className="ws-menu-pop" role="menu" onClick={e => e.stopPropagation()}>
          {items.map(it => (
            // role="button" span (not <button>) — WsMenu lives inside the row's own <button>, and
            // nesting real buttons is invalid HTML that misbehaves in-browser (matches ws-act pattern).
            <span
              key={it.key}
              className={`ws-menu-item${it.danger ? ' danger' : ''}`}
              role="menuitem"
              tabIndex={0}
              onClick={e => { e.stopPropagation(); setOpen(false); it.onClick() }}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); setOpen(false); it.onClick() } }}
            >
              <span className="wm-ico">{it.icon}</span>
              {it.label}
            </span>
          ))}
        </div>
      )}
    </span>
  )
}

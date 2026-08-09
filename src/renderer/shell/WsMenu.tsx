import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

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

const GAP = 4      // 弹层与按钮的间距
const EDGE = 8     // 与视口上/下边缘留出的余量

interface Pos { right: number; top?: number; bottom?: number; maxHeight: number }

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
  const btnRef = useRef<HTMLSpanElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  // 弹层 portal 到 <body> + fixed 定位:它原本是 .ws-menu 的 absolute 后代,而侧栏 .sb-scroll 是
  // overflow-y:auto 的滚动容器 —— 工作区排到列表靠下时,菜单整块被滚动容器裁掉(只露出第一项)。
  // 位置锚到 ⋯ 按钮的视口矩形,并在下方空间不足时翻到按钮上方。
  const [pos, setPos] = useState<Pos | null>(null)

  useLayoutEffect(() => {
    if (!open) { setPos(null); return }
    const btn = btnRef.current, popEl = popRef.current
    if (!btn || !popEl) return
    // 侧栏折叠时 .ws-actions 被 display:none 掉(⋯ 按钮量不出矩形),但右键仍能开菜单 ——
    // 退回到整行去锚,否则弹层会飘到屏幕左上角。
    let r = btn.getBoundingClientRect()
    if (!r.width && !r.height) r = (btn.closest('.ws-item') ?? btn).getBoundingClientRect()
    const h = popEl.getBoundingClientRect().height
    const right = window.innerWidth - r.right
    const below = window.innerHeight - r.bottom - GAP - EDGE
    const above = r.top - GAP - EDGE
    // 下方放得下就向下;否则翻上去。两边都放不下时选空间大的一侧并限高(内部滚动)。
    const down = h <= below || below >= above
    setPos(down
      ? { right, top: r.bottom + GAP, maxHeight: Math.max(below, 0) }
      : { right, bottom: window.innerHeight - r.top + GAP, maxHeight: Math.max(above, 0) })
  }, [open, items.length])

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node
      if (popRef.current?.contains(t)) return          // 弹层已 portal 出去,不再是 ref 的后代
      if (ref.current && !ref.current.contains(t)) setOpen(false)
    }
    // fixed 弹层不会跟着侧栏滚动/窗口缩放走,与其错位不如关掉(同 OpenLocationMenu 的做法)。
    const onMove = () => setOpen(false)
    document.addEventListener('click', onDoc)
    document.addEventListener('scroll', onMove, true)
    window.addEventListener('resize', onMove)
    return () => {
      document.removeEventListener('click', onDoc)
      document.removeEventListener('scroll', onMove, true)
      window.removeEventListener('resize', onMove)
    }
  }, [open])

  return (
    <span ref={ref} className={`ws-menu${open ? ' open' : ''}`}>
      <span
        ref={btnRef}
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
      {open && createPortal(
        <div
          ref={popRef}
          className="ws-menu-pop"
          role="menu"
          // 首帧 pos 尚未量出(useLayoutEffect 在 paint 前补上),先藏起来避免左上角闪一下。
          style={pos
            ? { top: pos.top, bottom: pos.bottom, right: pos.right, maxHeight: pos.maxHeight }
            : { visibility: 'hidden' }}
          onClick={e => e.stopPropagation()}
        >
          {items.map(it => (
            // role="button" span (not <button>) — 保持与 ws-act 一致的无嵌套按钮写法。
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
        </div>,
        document.body,
      )}
    </span>
  )
}

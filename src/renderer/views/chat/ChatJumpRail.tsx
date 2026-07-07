// src/renderer/views/chat/ChatJumpRail.tsx
import { useLayoutEffect, useMemo, useRef, useState, useCallback } from 'react'
import type { RefObject } from 'react'
import type { ChatMessage } from '@shared/types'
import { fmtMsgTime } from '@shared/relTime'
import { computeRailLayout } from './jumpRailLayout'

interface ChatJumpRailProps {
  messages: ChatMessage[]
  scrollRef: RefObject<HTMLDivElement | null>
}

interface UserItem { index: number; label: string; text: string }

function buildItems(messages: ChatMessage[]): UserItem[] {
  const out: UserItem[] = []
  messages.forEach((m, i) => {
    if (m.who !== 'user') return
    const raw = (m.text || '').replace(/\s+/g, ' ').trim() || '用户输入'
    out.push({
      index: i,
      label: m.ts ? fmtMsgTime(m.ts, Date.now()) : `#${out.length + 1}`,
      text: raw.length > 90 ? raw.slice(0, 90) + '…' : raw,
    })
  })
  return out
}

// Left-edge navigation rail: one faint dot per user message. Hover a dot to
// preview that input; click to smooth-scroll to it and briefly flash it. The
// rail is a sibling of .chat-scroll inside the position:relative .chat column,
// so it stays fixed while content scrolls; dot positions are derived from each
// message's offsetTop mapped onto the rail (see computeRailLayout).
export function ChatJumpRail({ messages, scrollRef }: ChatJumpRailProps) {
  const items = useMemo(() => buildItems(messages), [messages])
  const on = items.length > 1
  const railRef = useRef<HTMLDivElement>(null)
  // Positions are now even (CSS flex cluster), so we only consume the layout's activeIndex — the
  // per-dot `tops` are computed for parity but not applied to style.
  const [, setTops] = useState<number[]>([])
  const [active, setActive] = useState(-1)

  const sync = useCallback(() => {
    const sc = scrollRef.current
    const rail = railRef.current
    if (!sc || !rail || items.length <= 1) return
    // Guard: skip per-message offsetTop reflow when the list is very large (>120
    // user messages). Forced reflow on hundreds of elements causes noticeable
    // jank; the rail stays invisible until the list shrinks to a manageable size.
    if (items.length > 120) {
      setTops([])
      setActive(-1)
      return
    }
    const offsets = items.map(it => {
      const el = sc.querySelector<HTMLElement>(`[data-user-msg="${it.index}"]`)
      return el ? el.offsetTop : 0
    })
    const layout = computeRailLayout({
      offsets,
      scrollTop: sc.scrollTop,
      maxScroll: sc.scrollHeight - sc.clientHeight,
      railH: Math.max(40, rail.clientHeight || 0),
    })
    setTops(layout.tops)
    setActive(layout.activeIndex)
  }, [items, scrollRef])

  // Keep the latest sync in a ref so the scroll/resize subscription stays stable.
  const syncRef = useRef(sync)
  syncRef.current = sync

  // Re-measure whenever the message list changes (offsets shift as content grows).
  useLayoutEffect(() => {
    if (!on) return
    const id = requestAnimationFrame(() => syncRef.current())
    return () => cancelAnimationFrame(id)
  }, [items, on])

  // Subscribe once to scroll + resize.
  useLayoutEffect(() => {
    const sc = scrollRef.current
    const h = () => syncRef.current()
    sc?.addEventListener('scroll', h, { passive: true })
    window.addEventListener('resize', h)
    return () => {
      sc?.removeEventListener('scroll', h)
      window.removeEventListener('resize', h)
    }
  }, [scrollRef])

  const jump = (index: number) => {
    const sc = scrollRef.current
    if (!sc) return
    const el = sc.querySelector<HTMLElement>(`[data-user-msg="${index}"]`)
    if (!el) return
    const y = Math.max(0, Math.min(sc.scrollHeight - sc.clientHeight, el.offsetTop - 18))
    sc.scrollTo({ top: y, behavior: 'smooth' })
    el.classList.add('jump-flash')
    window.setTimeout(() => el.classList.remove('jump-flash'), 900)
  }

  return (
    <div className={`chat-jump-rail${on ? ' on' : ''}`} ref={railRef} aria-label="用户输入导航">
      {on && items.map((it, n) => (
        <button
          key={it.index}
          type="button"
          className={`chat-jump-dot${n === active ? ' active' : ''}`}
          data-jump-msg={it.index}
          aria-label={`跳到第 ${n + 1} 条用户输入`}
          onClick={() => jump(it.index)}
        >
          <span className="chat-jump-preview">
            <span className="jp-k">{it.label || `#${n + 1}`}</span>
            <span className="jp-t">{it.text}</span>
          </span>
        </button>
      ))}
    </div>
  )
}

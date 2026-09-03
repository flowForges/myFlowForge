// src/renderer/views/chat/ChatJumpRail.tsx
import { useLayoutEffect, useMemo, useRef, useState, useCallback } from 'react'
import type { RefObject } from 'react'
import type { ChatMessage } from '@shared/types'
import { fmtMsgTime } from '@shared/relTime'
import { computeRailLayout, bucketGroups, railCapacity, MIN_DOTS, RAIL_PAD } from './jumpRailLayout'

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
  /**
   * 轨道装得下几个锚点。★从对话区的**可见**高度算,所以拖窗口会跟着变。
   *
   * ★★这个值必须在**绘制之前**量到(下面用 useLayoutEffect 同步量)。
   *  第一版把它和 offsetTop 一起放在 `requestAnimationFrame` 里,于是首帧按初值
   *  `MIN_DOTS` 只画 6 个锚点、下一帧再弹到 20 —— 肉眼就是闪一下。
   *  量高度只是读一次 `clientHeight`,很便宜;真正贵的是逐条读 `offsetTop`(强制重排),
   *  那个才需要等布局稳定,继续留在 rAF 里。
   */
  const [capacity, setCapacity] = useState(MIN_DOTS)
  /**
   * 轨道摆在哪、最高多高 —— **量出来的,不是 CSS 里拍的常量**。
   *
   * ★★轨道是绝对定位在 `.chat`(整列)里的,而整列 = 对话滚动区 + **输入框**。
   *  原来 CSS 写死 `top:50%` + `max-height: calc(100% - 210px)`,等于假设输入框只有 105px 高;
   *  带附件条/模式条时它轻松 160~180,整窗缩放调大字号还要再涨 —— 于是轨道下半截压进输入框。
   * ★现在按**滚动区那个盒子**摆:中心对它的中心,高度按它的可见高度。输入框天然在它外面,
   *  多高都不会被压到,而且窗口、字号、附件条怎么变都自动跟上。
   */
  const [box, setBox] = useState<{ top: number; maxH: number } | null>(null)
  /**
   * ★★对话很多时把相邻的几条并成一个锚点 —— 否则 N 条 = `10N-4` px,
   *  超出可视区的那些会被推到屏幕外面,**根本点不到**(见 jumpRailLayout 里那段)。
   *  没超上限时这里是严格 1:1,日常对话一个像素都不变。
   */
  const groups = useMemo(() => bucketGroups(items.length, capacity), [items.length, capacity])

  const sync = useCallback(() => {
    const sc = scrollRef.current
    const rail = railRef.current
    if (!sc || !rail || items.length <= 1) return
    // ★★这里原来有一个「超过 120 条就放弃」的守卫,理由是「对几百个元素读 offsetTop 会强制重排」。
    //  那个理由是真的,但守卫本身**没做到它注释说的事**:它只清空 tops/active,而渲染条件是
    //  `items.length > 1` —— 121 条时那一长条照样全画出来,只是连高亮都没了。
    // ★现在不需要它了:只读**每组第一条**的 offsetTop,次数被 capacity 封顶(~80 次),
    //  跟对话有多长无关。合并锚点顺带把这个性能问题也解决了。
    const offsets = groups.map(g => {
      const it = items[g.start]
      const el = it ? sc.querySelector<HTMLElement>(`[data-user-msg="${it.index}"]`) : null
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
  }, [items, groups, scrollRef])

  /**
   * 量滚动区那个盒子 → 轨道的位置、高度、容量。
   * 便宜(读两个已缓存的布局属性),所以绘制前同步做,避免锚点数闪一下。
   *
   * ★量的是 `.chat-scroll`,不是轨道的定位容器 `.chat` —— 后者含输入框(见上面 `box`)。
   * ★`offsetTop` 也是相对 `.chat` 的(它俩是同一个 offsetParent),所以能直接当 `top` 用。
   * ★不能量轨道自己:它的高度由子节点撑出来,而子节点数量又由容量决定 —— 会锁死在初值上。
   */
  const measureCapacity = useCallback(() => {
    const sc = scrollRef.current
    const h = sc?.clientHeight ?? 0
    if (!(h > 0)) return
    setCapacity(railCapacity(h))
    setBox({ top: (sc?.offsetTop ?? 0) + h / 2, maxH: Math.max(0, h - RAIL_PAD * 2) })
  }, [scrollRef])

  // Keep the latest sync in a ref so the scroll/resize subscription stays stable.
  const syncRef = useRef(sync)
  syncRef.current = sync
  const capRef = useRef(measureCapacity)
  capRef.current = measureCapacity

  // Re-measure whenever the message list changes (offsets shift as content grows).
  useLayoutEffect(() => {
    if (!on) return
    capRef.current()                                     // 同步:绘制前就知道能放几个
    const id = requestAnimationFrame(() => syncRef.current())   // 异步:等布局稳了再读 offsetTop
    return () => cancelAnimationFrame(id)
  }, [items, on])

  // Subscribe once to scroll + resize.
  useLayoutEffect(() => {
    const sc = scrollRef.current
    const h = () => { capRef.current(); syncRef.current() }
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
    <div
      className={`chat-jump-rail${on ? ' on' : ''}`}
      ref={railRef}
      aria-label="用户输入导航"
      // ★位置和高度都由上面量出来(见 `box`)。CSS 里不再写死 `top:50%` / `max-height` ——
      //  那两句拍的是「输入框有多高」,而那是个会变的量。
      style={box ? { top: box.top, maxHeight: box.maxH } : undefined}
    >
      {on && groups.map((g, n) => {
        const it = items[g.start]
        if (!it) return null
        // ★合并了才说「N 条」。单条的组和以前长得一模一样 —— 多一个「1 条」是纯噪音。
        const head = g.size > 1 ? `${it.label || `#${g.start + 1}`} · ${g.size} 条` : (it.label || `#${g.start + 1}`)
        return (
          <button
            key={it.index}
            type="button"
            className={`chat-jump-dot${n === active ? ' active' : ''}`}
            data-jump-msg={it.index}
            aria-label={g.size > 1
              ? `跳到第 ${g.start + 1} 到 ${g.start + g.size} 条用户输入`
              : `跳到第 ${g.start + 1} 条用户输入`}
            onClick={() => jump(it.index)}
          >
            <span className="chat-jump-preview">
              <span className="jp-k">{head}</span>
              <span className="jp-t">{it.text}</span>
            </span>
          </button>
        )
      })}
    </div>
  )
}

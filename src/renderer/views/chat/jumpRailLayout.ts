// src/renderer/views/chat/jumpRailLayout.ts
export interface RailGeom {
  offsets: number[]
  scrollTop: number
  maxScroll: number
  railH: number
}

export interface RailLayout {
  tops: number[]
  activeIndex: number
}

// Pure geometry for the chat jump rail: maps each user-message offsetTop onto a
// fixed-height rail and picks the dot nearest the current scroll position.
// Mirrors the prototype's syncUserJumpRail math, extracted so it is testable
// without a real layout engine (jsdom reports offsetTop/clientHeight as 0).
export function computeRailLayout({ offsets, scrollTop, maxScroll, railH }: RailGeom): RailLayout {
  const ms = Math.max(1, maxScroll)
  const span = Math.max(1, railH - 24)
  let activeIndex = -1
  let best = Infinity
  const tops = offsets.map((off, i) => {
    const target = Math.max(0, Math.min(ms, off - 18))
    const dist = Math.abs(scrollTop - target)
    if (dist < best) { best = dist; activeIndex = i }
    return 12 + (target / ms) * span
  })
  return { tops, activeIndex }
}

// ── 锚点合并 ────────────────────────────────────────────────────────────────
//
// ★★2026-08-31 用户报:「对话次数非常多时这个导航也非常长」。
//  轨道是 `position:absolute; top:50%; translateY(-50%)` 的 flex 列,每个锚点占
//  6px 短横 + 4px 间隙 —— N 条就是 `10N-4` px 高。60 条 596px、120 条 1196px,
//  **溢出可视区的那些不是变丑,是根本点不到**(它们被推到屏幕外面去了)。
//
// 修法:锚点数量封顶在「轨道装得下多少个」,超出就把相邻的几条并成一个锚点。
// ★N 没超过上限时是**严格 1:1**,日常对话的观感一个像素都不变。

/** 一个锚点的自然高度 + 间隙,和 chat.css 的 `.chat-jump-dot{height:6px}` / `.chat-jump-rail{gap:4px}` 对齐。 */
export const DOT_H = 6
export const DOT_GAP = 4

/**
 * 轨道的高度预算。**必须和 chat.css 里 `.chat-jump-rail` 的 `max-height: calc(100% - 210px)` 一致** ——
 * 改一边就要改另一边(下面 `railCapacity` 的测试钉着这个数)。
 */
export const RAIL_MAX_OFFSET = 210

/**
 * 再挤也要留这么多个锚点。
 * ★窗口被拖得很矮时算出来可能是 1 甚至 0 —— 那时整条轨道退化成一个点,等于没有导航。
 *  宁可略微超出一点,也不要给一个什么都定位不了的东西。
 */
export const MIN_DOTS = 6

/**
 * 这个容器高度下,轨道最多放几个**自然大小**的锚点。
 *
 * ★★2026-08-31 在真 Chrome 里量过才发现问题有两层,不止「跑出屏幕」:
 *  轨道是 `max-height` + `overflow:visible` 的 flex 列,锚点 `flex-shrink` 默认是 1 ——
 *  所以塞不下时它们**先被压扁**,再溢出。实测 840px 高的对话区:
 *    20 个 → 6px,正常;76 个 → **4.3px**;300 个 → **1.5px 且有 166 个在屏幕外**。
 *  1.5px 的短横基本看不见,连带 16px 的点击热区也一起塌了。
 *  所以容量要按「不被压扁」算,不是按「不溢出」算。
 *
 * n 个锚点占 `n*DOT_H + (n-1)*DOT_GAP`,要 ≤ 预算 ⇒ `n ≤ (预算 + DOT_GAP) / (DOT_H + DOT_GAP)`。
 */
export function railCapacity(containerH: number): number {
  if (!(containerH > 0)) return MIN_DOTS
  const budget = containerH - RAIL_MAX_OFFSET
  return Math.max(MIN_DOTS, Math.floor((budget + DOT_GAP) / (DOT_H + DOT_GAP)))
}

/** 一个锚点覆盖哪几条:`start` 是组内第一条在 items 里的下标,`size` 是这一组有几条。 */
export interface RailGroup { start: number; size: number }

/**
 * 把 `count` 条用户输入分成至多 `capacity` 个连续的组。
 *
 * ★没超上限就**一条一个**,不做任何合并(严格 1:1)。
 * ★★超了的话,余数分给**旧的那一头**(数组开头 = 最早的对话)。
 *  也就是说新的那几组最小、定位最准 —— 人几乎总是在找最近说过的东西,
 *  让最近的内容分辨率最高是免费的。
 */
export function bucketGroups(count: number, capacity: number): RailGroup[] {
  if (count <= 0) return []
  const cap = Math.max(1, Math.floor(capacity))
  if (count <= cap) return Array.from({ length: count }, (_, i) => ({ start: i, size: 1 }))
  const base = Math.floor(count / cap)
  const extra = count % cap        // 前 `extra` 组各多担一条
  const out: RailGroup[] = []
  let start = 0
  for (let i = 0; i < cap; i++) {
    const size = base + (i < extra ? 1 : 0)
    out.push({ start, size })
    start += size
  }
  return out
}

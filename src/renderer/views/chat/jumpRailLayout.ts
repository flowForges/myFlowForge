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

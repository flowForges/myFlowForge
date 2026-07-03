import { useCallback, useEffect, useRef, useState } from 'react'

export interface ScrollMetrics {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

// A scroll container counts as "at the bottom" when the remaining distance to the end is within
// `threshold` px. The small slack keeps auto-follow engaged despite sub-pixel rounding and the last
// line's cursor/padding, and treats a not-yet-scrollable container as already at the bottom.
export function isNearBottom({ scrollTop, scrollHeight, clientHeight }: ScrollMetrics, threshold = 32): boolean {
  return scrollHeight - scrollTop - clientHeight <= threshold
}

export interface StickToBottom {
  ref: React.RefObject<HTMLDivElement | null>
  atBottom: boolean
  onScroll: () => void
  scrollToBottom: () => void
}

// Keeps a scroll container pinned to its latest content ("follow tail"): while the user is at the
// bottom, new content (signalled by `dep` changing) auto-scrolls down. Once the user scrolls up,
// following pauses and `atBottom` goes false so the caller can show a "jump to latest" affordance.
export function useStickToBottom(dep: unknown): StickToBottom {
  const ref = useRef<HTMLDivElement | null>(null)
  const [atBottom, setAtBottom] = useState(true)

  const scrollToBottom = useCallback(() => {
    const el = ref.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    setAtBottom(true)
  }, [])

  const onScroll = useCallback(() => {
    const el = ref.current
    if (el) setAtBottom(isNearBottom(el))
  }, [])

  // Follow the tail when new content arrives and the user hasn't scrolled away.
  useEffect(() => {
    const el = ref.current
    if (el && atBottom) el.scrollTop = el.scrollHeight
  }, [dep, atBottom])

  return { ref, atBottom, onScroll, scrollToBottom }
}

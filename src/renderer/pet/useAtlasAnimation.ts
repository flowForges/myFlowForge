import { useEffect, useRef, useState } from 'react'
import { FRAME_DURATIONS, type PetAction } from '@shared/petAtlas'

// Drive an atlas row's frame index by its per-frame durations. A setTimeout chain (not a fixed interval)
// honors the contract's variable timings; the action resets the loop to frame 0. Reduced motion holds
// frame 0 (the contract's "reduced-motion first frame").
//
// `durations` lets a caller supply its own table instead of the built-in codex one — growth-pet packs
// carry per-frame durations in their manifest, which is what keeps their pacing host-driven rather than
// baked into an animated file. Omitting it keeps the exact codex behavior.
// 首参放宽成 string:传了 durations 时它只用来「动作一变就重置到第 0 帧」,值本身不参与查表。
// 成长包的动作名(idle/working/alert)不属于 PetAction,放宽后不必在调用处强转。
export function useAtlasAnimation(
  action: string,
  opts: { reducedMotion?: boolean; durations?: number[] } = {},
): number {
  const [frame, setFrame] = useState(0)
  const frameRef = useRef(0)
  const custom = opts.durations
  // Effects must not depend on a fresh array identity every render, so key on the contents.
  const customKey = custom ? custom.join(',') : ''

  useEffect(() => {
    frameRef.current = 0
    setFrame(0)
    if (opts.reducedMotion) return
    const durations = customKey ? customKey.split(',').map(Number) : FRAME_DURATIONS[action as PetAction]
    if (!durations || durations.length <= 1) return
    let timer: ReturnType<typeof setTimeout>
    const tick = () => {
      const next = (frameRef.current + 1) % durations.length
      frameRef.current = next
      setFrame(next)
      timer = setTimeout(tick, durations[next])
    }
    timer = setTimeout(tick, durations[0])
    return () => clearTimeout(timer)
  }, [action, opts.reducedMotion, customKey])

  return frame
}

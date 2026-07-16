import { useEffect, useRef, useState } from 'react'
import { FRAME_DURATIONS, type PetAction } from '@shared/petAtlas'

// Drive an atlas row's frame index by its per-frame durations. A setTimeout chain (not a fixed interval)
// honors the contract's variable timings; the action resets the loop to frame 0. Reduced motion holds
// frame 0 (the contract's "reduced-motion first frame").
export function useAtlasAnimation(action: PetAction, opts: { reducedMotion?: boolean } = {}): number {
  const [frame, setFrame] = useState(0)
  const frameRef = useRef(0)

  useEffect(() => {
    frameRef.current = 0
    setFrame(0)
    if (opts.reducedMotion) return
    const durations = FRAME_DURATIONS[action]
    if (durations.length <= 1) return
    let timer: ReturnType<typeof setTimeout>
    const tick = () => {
      const next = (frameRef.current + 1) % durations.length
      frameRef.current = next
      setFrame(next)
      timer = setTimeout(tick, durations[next])
    }
    timer = setTimeout(tick, durations[0])
    return () => clearTimeout(timer)
  }, [action, opts.reducedMotion])

  return frame
}

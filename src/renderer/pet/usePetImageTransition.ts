import { useEffect, useMemo, useRef, useState } from 'react'

export interface PetImageLayers {
  front: string | undefined
  fading: string | undefined
  failed: ReadonlySet<string>
}

export function usePetImageTransition(
  requested: string | undefined,
  candidates: readonly string[],
  fadeMs = 120,
): PetImageLayers {
  const candidateKey = candidates.join('\u0000')
  const uniqueCandidates = useMemo(() => [...new Set(candidates.filter(Boolean))], [candidateKey])
  const [ready, setReady] = useState<ReadonlySet<string>>(() => new Set())
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set())
  const [front, setFront] = useState<string | undefined>(requested)
  const [fading, setFading] = useState<string | undefined>()
  const frontRef = useRef(front)
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    let active = true
    const settle = (url: string, ok: boolean) => {
      if (!active) return
      const update = (current: ReadonlySet<string>) => new Set(current).add(url)
      if (ok) setReady(update)
      else setFailed(update)
    }

    for (const url of uniqueCandidates) {
      const image = new Image()
      let settled = false
      const finish = (ok: boolean) => {
        if (settled) return
        settled = true
        settle(url, ok)
      }
      image.onload = () => finish(true)
      image.onerror = () => finish(false)
      image.src = url
      // Some Chromium builds reject decode() before a valid custom-scheme image
      // finishes loading. In that case the load/error events remain authoritative.
      if (typeof image.decode === 'function') image.decode().then(() => finish(true), () => undefined)
    }

    return () => { active = false }
  }, [uniqueCandidates])

  useEffect(() => {
    if (!requested || !ready.has(requested) || frontRef.current === requested) return
    if (fadeTimer.current) clearTimeout(fadeTimer.current)
    setFading(frontRef.current)
    frontRef.current = requested
    setFront(requested)
    fadeTimer.current = setTimeout(() => setFading(undefined), fadeMs)
  }, [fadeMs, ready, requested])

  useEffect(() => {
    if (!requested || !failed.has(requested) || frontRef.current !== requested) return
    frontRef.current = undefined
    setFront(undefined)
  }, [failed, requested])

  useEffect(() => () => {
    if (fadeTimer.current) clearTimeout(fadeTimer.current)
  }, [])

  return { front, fading, failed }
}

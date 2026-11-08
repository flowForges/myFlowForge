import { useEffect, useRef, useState } from 'react'

const fmt = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** 到 until(毫秒时间戳)为止的 m:ss;到点调一次 onDone */
export function Countdown({ until, onDone }: { until: number; onDone?: () => void }) {
  const [now, setNow] = useState(() => Date.now())
  const done = useRef(false)
  const cb = useRef(onDone)
  cb.current = onDone
  useEffect(() => {
    done.current = false
    const tick = () => {
      const t = Date.now()
      setNow(t)
      if (t >= until && !done.current) {
        done.current = true
        cb.current?.()
      }
      return t < until
    }
    if (!tick()) return
    const id = setInterval(() => { if (!tick()) clearInterval(id) }, 1000)
    return () => clearInterval(id)
  }, [until])
  return <span className="mffai-count">{fmt(until - now)}</span>
}

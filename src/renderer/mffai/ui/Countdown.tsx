import { useEffect, useRef, useState } from 'react'

const fmt = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const RING = 34
const R = 15
const C = 2 * Math.PI * R

/** 到 until(毫秒时间戳)为止的 m:ss;到点调一次 onDone。给了 from(开始的时间戳)就外面画一个 34px 的环,弧长 = 剩下的比例 */
export function Countdown({ until, onDone, from }: { until: number; onDone?: () => void; from?: number }) {
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
  const text = <span className="mffai-count">{fmt(until - now)}</span>
  if (from === undefined) return text
  const total = until - from
  const left = total > 0 ? Math.min(1, Math.max(0, (until - now) / total)) : 0
  return (
    <span className="mffai-countring">
      <svg className="mffai-ring" width={RING} height={RING} viewBox={`0 0 ${RING} ${RING}`} aria-hidden="true">
        <circle className="mffai-ring-track" cx={RING / 2} cy={RING / 2} r={R} />
        <circle className="mffai-ring-arc" cx={RING / 2} cy={RING / 2} r={R} strokeDasharray={C} strokeDashoffset={C * (1 - left)} />
      </svg>
      {text}
    </span>
  )
}

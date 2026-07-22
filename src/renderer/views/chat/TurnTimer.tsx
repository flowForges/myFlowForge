import { useEffect, useState } from 'react'

interface Props {
  // Whole-turn wall-clock from useChat: startedAt on assistant-start, endedAt on done/error.
  startedAt?: number
  endedAt?: number
  streaming: boolean
}

function fmtDur(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rem = s % 60
  return `${m}m${rem.toString().padStart(2, '0')}s`
}

// Whole-turn elapsed shown in the assistant message header: counts up every second from the moment the
// LLM starts (assistant-start) through answering, then freezes at the 用时 total when the turn finishes.
// Distinct from ThinkBlock's ticker (thinking phase only, inside the collapsible). If the view opened
// mid-turn and never saw assistant-start (no startedAt), it falls back to counting from first render so
// the user still sees liveness rather than a frozen dash.
export function TurnTimer({ startedAt, endedAt, streaming }: Props) {
  const [mountAt] = useState(() => Date.now())
  const base = startedAt ?? mountAt
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!streaming) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [streaming])

  if (streaming) {
    return <span className="turn-timer live" title="本轮已运行"><span className="tt-dot" />{fmtDur(now - base)}</span>
  }
  // Settled turn: only show a total when we actually captured both ends this session (a reloaded
  // historical message has neither, so render nothing rather than a bogus 0s).
  if (startedAt != null && endedAt != null) {
    return <span className="turn-timer" title="本轮整体耗时">用时 {fmtDur(endedAt - startedAt)}</span>
  }
  return null
}

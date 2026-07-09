import { useEffect, useState } from 'react'
import type { ChatThink } from '@shared/types'

const CHEV = (
  <svg className="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><polyline points="9 18 15 12 9 6" /></svg>
)
const SPIN = (
  <svg className="spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 12a9 9 0 1 1-6.2-8.5" /></svg>
)
const GLYPH = (
  <svg className="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2a5 5 0 0 0-5 5c0 1.5.6 2.7 1.5 3.5C9 11 9 12 9 13H7m5-11a5 5 0 0 1 5 5c0 1.5-.6 2.7-1.5 3.5-.5.5-.5 1.5-.5 2.5h2M9 13h6M10 16h4M10.5 19h3" /></svg>
)

interface Props {
  think: ChatThink
  streaming: boolean
}

// Auto-open while streaming (watch reasoning live), auto-collapse when done; a manual click
// overrides thereafter.
export function ThinkBlock({ think, streaming }: Props) {
  const [override, setOverride] = useState<boolean | null>(null)
  const open = override ?? streaming
  // Live elapsed while streaming. The agent's first token can lag many seconds behind the spinner
  // (CLI spawn + forge-MCP handshake + model load / session resume), a window in which NOTHING streams
  // — a ticking counter shows it's alive instead of looking frozen. Falls back to think.elapsed once done.
  const [startedAt] = useState(() => Date.now())
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!streaming) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [streaming])
  const elapsed = streaming ? Math.max(0, Math.floor((now - startedAt) / 1000)) : think.elapsed
  return (
    <div className={`think${streaming ? ' live' : ''}${open ? ' open' : ''}`}>
      <button className="think-h" onClick={() => setOverride(o => !(o ?? streaming))}>
        {!streaming && CHEV}
        {streaming ? SPIN : GLYPH}
        <span className="label">{think.label}</span>
        {elapsed != null && <span className="t">{elapsed}s</span>}
      </button>
      <div className="think-body">
        <div className="think-steps">
          {think.steps.map((s, i) => (
            <div className="think-step" key={i}>{s}</div>
          ))}
        </div>
      </div>
    </div>
  )
}

// 变更(08 §12.4):memory.changes,时间、文件、操作、来源一行,点开看 before/after。
import { useEffect, useRef, useState } from 'react'
import type { MemoryChange } from '@mffai/protocol'
import { call, isUnsupported, toCallError } from '../rpc'
import { Chip } from '../ui/Chip'

function ChangeRow({ c }: { c: MemoryChange }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="mffai-group mffai-change" data-change={c.id}>
      <button className="mffai-file-btn" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="mffai-sess-time">{new Date(c.ts).toLocaleString()}</span>
        {c.file && <span className="mffai-path">{c.file}</span>}
        <Chip>{c.op}</Chip>
        <Chip tone="muted">{c.source}</Chip>
      </button>
      {open && (
        <div className="mffai-row">
          <span className="mffai-k">之前</span>
          <pre className="mffai-pre">{c.before ?? ''}</pre>
          <span className="mffai-k">之后</span>
          <pre className="mffai-pre">{c.after ?? ''}</pre>
        </div>
      )}
    </div>
  )
}

export function Changes() {
  const [items, setItems] = useState<MemoryChange[] | null>(null)
  const [failed, setFailed] = useState<'unsupported' | 'failed' | null>(null)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    void call('memory.changes', { limit: 100 }).then(
      (r) => { if (alive.current) setItems(r.items) },
      (e) => { if (!alive.current) return; if (!isUnsupported(e)) console.error('mffai memory.changes', toCallError(e)); setFailed(isUnsupported(e) ? 'unsupported' : 'failed') },
    )
    return () => { alive.current = false }
  }, [])

  if (failed === 'unsupported') return <div className="mffai-pane mffai-changeslist"><Chip tone="bad">不支持</Chip></div>
  if (failed === 'failed') return <div className="mffai-pane mffai-changeslist"><span className="mffai-fail">失败</span></div>

  return (
    <div className="mffai-pane mffai-changeslist">
      {items?.map((c, i) => <ChangeRow key={`${c.id}-${c.ts}-${i}`} c={c} />)}
    </div>
  )
}

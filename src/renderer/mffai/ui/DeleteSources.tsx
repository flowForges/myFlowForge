// 删完之后仍引用它的记忆(08 §7.2、§12.3 同一组件):每条一行文字 + 删除。
// 超时后重试用同一个 commandId;-32602 not found 算已经删了(06 followups Task 7)。
import { useEffect, useRef, useState } from 'react'
import { call, retryable, toCallError } from '../rpc'
import { CodeChip } from './CodeChip'

const ERR_INVALID = -32602
const TEXT_MAX = 160

function Item({ id, onGone }: { id: string; onGone: () => void }) {
  const [text, setText] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const inflight = useRef(false)
  const [failed, setFailed] = useState(false)
  const retry = useRef(retryable()).current
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    void call('memory.get', { id }).then((m) => { if (alive.current) setText(m.text) }, () => {})
    return () => { alive.current = false }
  }, [id])
  const del = async () => {
    if (inflight.current) return
    inflight.current = true
    setBusy(true)
    setFailed(false)
    try {
      await call('memory.delete', { commandId: retry.id(id), id })
      retry.done(id)
      onGone()
    } catch (e) {
      const c = toCallError(e)
      if (c.code === ERR_INVALID && /not found/.test(c.message)) { retry.done(id); onGone(); return }
      console.error('mffai memory.delete', c)
      if (alive.current) setFailed(true)
    } finally {
      inflight.current = false
      if (alive.current) setBusy(false)
    }
  }
  const shown = text && text.length > TEXT_MAX ? text.slice(0, TEXT_MAX) + '…' : text
  return (
    <div className="mffai-confirm-row">
      <span className="mffai-k"><CodeChip code={id} /></span>
      <span className="mffai-v">{shown}</span>
      {failed && <span className="mffai-fail">失败</span>}
      <button className="set-btn" disabled={busy} onClick={() => void del()}>删除</button>
    </div>
  )
}

export function DeleteSources({ title, ids, onClose }: {
  /** 按剩下的条数给标题,如 `仍引用它的记忆 N 条` */
  title: (n: number) => string
  ids: readonly string[]
  onClose: () => void
}) {
  const [left, setLeft] = useState<string[]>(() => [...new Set(ids)])
  const t = title(left.length)
  return (
    <div className="confirm-overlay on" onClick={onClose}>
      <div className="confirm-card mffai-confirm" role="dialog" aria-modal="true" aria-label={t} onClick={(e) => e.stopPropagation()}>
        <div className="confirm-title">{t}</div>
        {left.length > 0 && (
          <div className="mffai-confirm-rows">
            {left.map((id) => <Item key={id} id={id} onGone={() => setLeft((l) => l.filter((x) => x !== id))} />)}
          </div>
        )}
        <div className="confirm-actions">
          <button className="confirm-ok" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  )
}

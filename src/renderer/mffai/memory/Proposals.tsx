// 待确认(08 §12.2):memory.proposals.list {status:'pending'}。证据和被替换的原文都是 r_/n_ id,
// 各自经 memory.get 取原话。批准带改过的文字;回 full(ERR_INVALID 'full')→ 已满 + 去编辑(跳档案那个文件)。
// memory.proposal、memory.updated 到了,或者本地批准/驳回成功,整份重拉(06 followups Task 10)。
import { useCallback, useEffect, useRef, useState } from 'react'
import type { MemoryProposal } from '@mffai/protocol'
import { call, isUnsupported, retryable, toCallError } from '../rpc'
import { useMffaiEvent, useMffaiReset } from '../events'
import { Chip } from '../ui/Chip'
import { CodeChip } from '../ui/CodeChip'

type Target = MemoryProposal['target']
const ERR_INVALID = -32602
const OP_LABEL: Record<MemoryProposal['op'], string> = { add: '新增', replace: '替换' }
const SOURCE_LABEL: Record<MemoryProposal['source'], string> = { extract: '提取', model: '模型' }
const K = '\u0000'

function Quote({ id }: { id: string }) {
  const [text, setText] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    void call('memory.get', { id }).then((m) => { if (alive.current) setText(m.text) }, () => {})
    return () => { alive.current = false }
  }, [id])
  return <span className="mffai-quote">{text ?? id}</span>
}

function ProposalRow({ p, onDecided, onJumpToFile }: {
  p: MemoryProposal
  onDecided: () => void
  onJumpToFile: (file: Target) => void
}) {
  const [text, setText] = useState(p.text)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<'full' | 'unsupported' | 'failed' | null>(null)
  const inflight = useRef(false)
  const retry = useRef(retryable()).current

  const decide = async (decision: 'approve' | 'reject') => {
    if (inflight.current) return
    const key = decision + K + (decision === 'approve' ? text : '')
    inflight.current = true
    setBusy(true)
    setStatus(null)
    try {
      await call('memory.proposals.decide', { commandId: retry.id(key), id: p.id, decision, ...(decision === 'approve' && { text }) })
      retry.done(key)
      onDecided()
    } catch (e) {
      const c = toCallError(e)
      if (c.code === ERR_INVALID && c.message === 'full') setStatus('full')
      else if (isUnsupported(c)) setStatus('unsupported')
      else { console.error('mffai memory.proposals.decide', c); setStatus('failed') }
    } finally {
      inflight.current = false
      setBusy(false)
    }
  }

  return (
    <div className="mffai-card mffai-proposal" data-proposal={p.id}>
      <div className="mffai-row">
        <Chip>{p.target}</Chip>
        <Chip tone={p.op === 'replace' ? 'warn' : 'ok'}>{OP_LABEL[p.op]}</Chip>
        <Chip tone="muted">{SOURCE_LABEL[p.source]}</Chip>
        {p.flags.map((fl) => <CodeChip key={fl} code={fl} />)}
      </div>
      {p.op === 'replace' && p.replaces && (
        <div className="mffai-row"><span className="mffai-k">原文</span><Quote id={p.replaces} /></div>
      )}
      <textarea aria-label={`文字 ${p.id}`} className="mffai-input" value={text} disabled={busy}
        onChange={(e) => setText(e.target.value)} />
      {p.evidence.length > 0 && (
        <div className="mffai-row">
          <span className="mffai-k">证据</span>
          {p.evidence.map((id) => <Quote key={id} id={id} />)}
        </div>
      )}
      <div className="mffai-actions">
        <button className="set-btn mffai-primary" disabled={busy} onClick={() => void decide('approve')}>批准</button>
        <button className="set-btn" disabled={busy} onClick={() => void decide('reject')}>驳回</button>
        {status === 'full' && (
          <>
            <Chip tone="bad">已满</Chip>
            <button className="set-btn" onClick={() => onJumpToFile(p.target)}>去编辑</button>
          </>
        )}
        {status === 'unsupported' && <Chip tone="bad">不支持</Chip>}
        {status === 'failed' && <span className="mffai-fail">失败</span>}
      </div>
    </div>
  )
}

export function Proposals({ onJumpToFile }: { onJumpToFile: (file: Target) => void }) {
  const [items, setItems] = useState<MemoryProposal[] | null>(null)
  const [failed, setFailed] = useState<'unsupported' | 'failed' | null>(null)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  const load = useCallback(() => {
    void call('memory.proposals.list', { status: 'pending' }).then(
      (r) => { if (alive.current) { setItems(r.items); setFailed(null) } },
      (e) => { if (alive.current) setFailed(isUnsupported(e) ? 'unsupported' : 'failed') },
    )
  }, [])
  useEffect(load, [load])
  useMffaiEvent({ types: ['memory.proposal', 'memory.updated'] }, load)
  useMffaiReset(load)

  if (failed === 'unsupported') return <div className="mffai-pane mffai-proposals"><Chip tone="bad">不支持</Chip></div>

  return (
    <div className="mffai-pane mffai-proposals">
      {failed === 'failed' && <span className="mffai-fail">失败</span>}
      {items?.map((p) => <ProposalRow key={p.id} p={p} onDecided={load} onJumpToFile={onJumpToFile} />)}
    </div>
  )
}

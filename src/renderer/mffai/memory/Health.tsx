// 状态(08 §12.4):memory.health 的库大小、行数、cursorLag、待确认数、上次整理时间;budget 两条进度条;
// problems 每个一个 CodeChip,file_over_cap:/delete_pending:/delete_stuck: 按前缀认(06 Task 4)。
// delete_stuck 的 id 在页头给一个 重试 按钮,用同一个 id 再调 memory.delete。立即整理(memory.consolidate,
// 600 s 期限由宿主的长方法表兜底)在跑时按钮转圈;memory.consolidated 事件或直接回答都能更新上次整理结果。
import { useCallback, useEffect, useRef, useState } from 'react'
import type { MemoryConsolidatedPayload, MemoryHealth } from '@mffai/protocol'
import { call, cmd, isUnsupported, toCallError } from '../rpc'
import { useMffaiEvent, useMffaiReset } from '../events'
import { Chip } from '../ui/Chip'
import { CodeChip } from '../ui/CodeChip'

const STUCK_PREFIX = 'delete_stuck:'

function Meter({ label, value, limit }: { label: string; value: number; limit: number }) {
  const pct = limit > 0 ? Math.min(100, Math.round((value / limit) * 100)) : 0
  return (
    <div className="mffai-row mffai-meter-row">
      <span className="mffai-k">{label}</span>
      <div className="mffai-meter"><div className="mffai-meter-fill" style={{ width: `${pct}%` }} /></div>
      <span className="mffai-count">{`${value} / ${limit}`}</span>
    </div>
  )
}

function StuckRow({ id, onDone }: { id: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const inflight = useRef(false)

  const retry = async () => {
    if (inflight.current) return
    inflight.current = true
    setBusy(true)
    setFailed(false)
    try {
      await call('memory.delete', { commandId: cmd(), id })
      onDone()
    } catch (e) {
      console.error('mffai memory.delete', toCallError(e))
      setFailed(true)
    } finally {
      inflight.current = false
      setBusy(false)
    }
  }

  return (
    <div className="mffai-row" data-stuck={id}>
      <Chip tone="bad">删除卡住</Chip>
      <CodeChip code={id} />
      <button className="set-btn" disabled={busy} onClick={() => void retry()}>重试</button>
      {failed && <span className="mffai-fail">失败</span>}
    </div>
  )
}

export function Health() {
  const [health, setHealth] = useState<MemoryHealth | null>(null)
  const [failed, setFailed] = useState<'unsupported' | 'failed' | null>(null)
  const [consolidating, setConsolidating] = useState(false)
  const [consolidateFailed, setConsolidateFailed] = useState<'unsupported' | 'failed' | null>(null)
  const [lastResult, setLastResult] = useState<MemoryConsolidatedPayload | null>(null)
  const inflight = useRef(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  const load = useCallback(() => {
    void call('memory.health').then(
      (h) => { if (alive.current) { setHealth(h); setFailed(null) } },
      (e) => { if (alive.current) setFailed(isUnsupported(e) ? 'unsupported' : 'failed') },
    )
  }, [])
  useEffect(load, [load])
  useMffaiEvent({ types: ['memory.deleted'] }, load)
  useMffaiEvent({ types: ['memory.consolidated'] }, (e) => setLastResult(e.payload as MemoryConsolidatedPayload))
  useMffaiReset(load)

  const consolidate = async () => {
    if (inflight.current) return
    inflight.current = true
    setConsolidating(true)
    setConsolidateFailed(null)
    try {
      const r = await call('memory.consolidate', { commandId: cmd() })
      if (!alive.current) return
      setLastResult(r)
      load()
    } catch (e) {
      const c = toCallError(e)
      console.error('mffai memory.consolidate', c)
      if (alive.current) setConsolidateFailed(isUnsupported(c) ? 'unsupported' : 'failed')
    } finally {
      inflight.current = false
      if (alive.current) setConsolidating(false)
    }
  }

  if (failed === 'unsupported') return <div className="mffai-pane mffai-health"><Chip tone="bad">不支持</Chip></div>
  if (!health) return <div className="mffai-pane mffai-health" />

  const stuckIds = health.problems.filter((p) => p.startsWith(STUCK_PREFIX)).map((p) => p.slice(STUCK_PREFIX.length))
  const otherProblems = health.problems.filter((p) => !p.startsWith(STUCK_PREFIX))

  return (
    <div className="mffai-pane mffai-health">
      {failed === 'failed' && <span className="mffai-fail">失败</span>}
      {stuckIds.map((id) => <StuckRow key={id} id={id} onDone={load} />)}
      <div className="mffai-row"><span className="mffai-k">库大小</span><span className="mffai-count">{health.dbBytes}</span></div>
      <div className="mffai-row"><span className="mffai-k">原始行数</span><span className="mffai-count">{health.rawRows}</span></div>
      <div className="mffai-row"><span className="mffai-k">笔记数</span><span className="mffai-count">{health.noteRows}</span></div>
      <div className="mffai-row"><span className="mffai-k">cursorLag</span><span className="mffai-count">{health.cursorLag}</span></div>
      <div className="mffai-row"><span className="mffai-k">待确认数</span><span className="mffai-count">{health.pendingProposals}</span></div>
      <div className="mffai-row">
        <span className="mffai-k">上次整理</span>
        <span>{health.lastConsolidation ?? '-'}</span>
        {lastResult && (
          <span className="mffai-usage">{`提取 ${lastResult.extracted} · 写入 ${lastResult.promoted} · 提议 ${lastResult.proposed}`}</span>
        )}
      </div>
      {health.backgroundModel && <div className="mffai-row"><span className="mffai-k">后台模型</span><span>{health.backgroundModel.modelId}</span></div>}
      {health.budget && (
        <>
          <Meter label="tokens" value={health.budget.tokens} limit={health.budget.tokensLimit} />
          <Meter label="usd" value={health.budget.usd} limit={health.budget.usdLimit} />
        </>
      )}
      {otherProblems.map((p) => <CodeChip key={p} code={p} />)}
      <div className="mffai-actions">
        <button className="set-btn mffai-primary" disabled={consolidating} onClick={() => void consolidate()}>立即整理</button>
        {consolidating && <Chip tone="warn">整理中</Chip>}
        {consolidateFailed === 'unsupported' && <Chip tone="bad">不支持</Chip>}
        {consolidateFailed === 'failed' && <span className="mffai-fail">失败</span>}
      </div>
    </div>
  )
}

// 状态(08 §12.4):memory.health 的库大小、行数、cursorLag、待确认数、上次整理时间;budget 两条进度条;
// problems 每个一个 CodeChip,file_over_cap:/delete_pending:/delete_stuck: 按前缀认(06 Task 4)。
// delete_stuck 的 id 在页头给一个 重试 按钮,用同一个 id 再调 memory.delete;-32602 not found 的重试算已经
// 删完(和 Items 单条删的那条规矩一样)。立即整理(memory.consolidate,600 s 期限由宿主的长方法表兜底)在跑时
// 按钮转圈,这个状态记在模块顶层(inFlightConsolidate),切走再切回这页也不丢——不然重新挂载会把忙标志清成
// false,用户能在后台那次还没答完的时候再点一次,发出第二个 memory.consolidate。memory.consolidated 事件或
// 直接回答都能更新上次整理结果。
import { useCallback, useEffect, useRef, useState } from 'react'
import type { MemoryConsolidatedPayload, MemoryHealth } from '@mffai/protocol'
import { call, cmd, toCallError } from '../rpc'
import { useMffaiEvent, useMffaiReset } from '../events'
import { memoryUnsupported } from './unavailable'
import { Chip } from '../ui/Chip'
import { CodeChip } from '../ui/CodeChip'

const STUCK_PREFIX = 'delete_stuck:'
const ERR_INVALID = -32602

/** memory-default 的 lastConsolidation 是 files.ts 的 localDate() 存的纯日期(没有时间);别的调用方可能给
 * 完整时间戳。纯日期字符串按本地年月日构造 Date(不走 Date(str) 的 UTC 解析,免得时区把日期本身挪了一天)。 */
function formatLocal(s: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString()
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString()
}

// 切页再切回来也不丢「正在整理」:这次调用的 promise 存在模块顶层,新挂载的实例接上同一个,不重发
let inFlightConsolidate: Promise<MemoryConsolidatedPayload> | null = null

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
      const c = toCallError(e)
      if (c.code === ERR_INVALID && /not found/.test(c.message)) { onDone(); return }
      console.error('mffai memory.delete', c)
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
  const [consolidating, setConsolidating] = useState(!!inFlightConsolidate)
  const [consolidateFailed, setConsolidateFailed] = useState<'unsupported' | 'failed' | null>(null)
  const [lastResult, setLastResult] = useState<MemoryConsolidatedPayload | null>(null)
  const inflight = useRef(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  // 挂载时已经有一个在跑的整理:接上它的结果,不重新发一次
  useEffect(() => {
    const p = inFlightConsolidate
    if (!p) return
    let current = true
    p.then(
      (r) => { if (current && alive.current) { setLastResult(r); setConsolidating(false) } },
      () => { if (current && alive.current) setConsolidating(false) },
    )
    return () => { current = false }
  }, [])

  const load = useCallback(() => {
    void call('memory.health').then(
      (h) => { if (alive.current) { setHealth(h); setFailed(null) } },
      (e) => { if (alive.current) setFailed(memoryUnsupported(e) ? 'unsupported' : 'failed') },
    )
  }, [])
  useEffect(load, [load])
  useMffaiEvent({ types: ['memory.deleted'] }, load)
  useMffaiEvent({ types: ['memory.consolidated'] }, (e) => setLastResult(e.payload as MemoryConsolidatedPayload))
  useMffaiReset(load)

  const consolidate = async () => {
    if (inflight.current || inFlightConsolidate) return
    inflight.current = true
    setConsolidating(true)
    setConsolidateFailed(null)
    const p = call('memory.consolidate', { commandId: cmd() })
    inFlightConsolidate = p
    try {
      const r = await p
      if (inFlightConsolidate === p) inFlightConsolidate = null
      if (!alive.current) return
      setLastResult(r)
      load()
    } catch (e) {
      if (inFlightConsolidate === p) inFlightConsolidate = null
      const c = toCallError(e)
      console.error('mffai memory.consolidate', c)
      if (alive.current) setConsolidateFailed(memoryUnsupported(c) ? 'unsupported' : 'failed')
    } finally {
      inflight.current = false
      if (alive.current) setConsolidating(false)
    }
  }

  if (failed === 'unsupported') return <div className="mffai-pane mffai-health"><Chip tone="bad">不支持</Chip></div>
  if (!health) return <div className="mffai-pane mffai-health" />

  const stuckIds = health.problems.filter((p) => p.startsWith(STUCK_PREFIX)).map((p) => p.slice(STUCK_PREFIX.length))
  const otherProblems = health.problems.filter((p) => !p.startsWith(STUCK_PREFIX))

  const fig = (k: string, v: string | number) => (
    <div className="mffai-fig"><span className="mffai-k">{k}</span><span className="mffai-count">{v}</span></div>
  )

  return (
    <div className="mffai-pane mffai-health">
      {failed === 'failed' && <span className="mffai-fail">失败</span>}
      {stuckIds.map((id) => <StuckRow key={id} id={id} onDone={load} />)}
      <div className="mffai-card mffai-statuscard">
        <div className="mffai-card-h">
          <span>状态</span>
          {consolidating && <Chip tone="warn" dot>整理中</Chip>}
        </div>
        <div className="mffai-figs">
          {fig('库大小', health.dbBytes)}
          {fig('笔记数', health.noteRows)}
          {fig('原始行数', health.rawRows)}
          {fig('待确认数', health.pendingProposals)}
          {fig('cursorLag', health.cursorLag)}
          <div className="mffai-fig">
            <span className="mffai-k">上次整理</span>
            <span className="mffai-count">{health.lastConsolidation ? formatLocal(health.lastConsolidation) : '-'}</span>
            {lastResult && (
              <span className="mffai-usage">{`提取 ${lastResult.extracted} · 写入 ${lastResult.promoted} · 提议 ${lastResult.proposed}`}</span>
            )}
          </div>
        </div>
        {health.backgroundModel && <div className="mffai-row"><span className="mffai-k">后台模型</span><span>{health.backgroundModel.modelId}</span></div>}
        {health.budget && (
          <div className="mffai-meters">
            <Meter label="tokens" value={health.budget.tokens} limit={health.budget.tokensLimit} />
            <Meter label="usd" value={health.budget.usd} limit={health.budget.usdLimit} />
          </div>
        )}
        {otherProblems.length > 0 && <div className="mffai-row">{otherProblems.map((p) => <CodeChip key={p} code={p} />)}</div>}
        <div className="mffai-actions">
          <button className="set-btn mffai-primary" disabled={consolidating} onClick={() => void consolidate()}>立即整理</button>
          {consolidateFailed === 'unsupported' && <Chip tone="bad">不支持</Chip>}
          {consolidateFailed === 'failed' && <span className="mffai-fail">失败</span>}
        </div>
      </div>
    </div>
  )
}

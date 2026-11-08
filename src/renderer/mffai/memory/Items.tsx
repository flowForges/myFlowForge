// 条目和删除(08 §12.3):层下拉 + 搜索框切到 memory.search,列表分页用 before。勾选多条批量删一次
// memory.deleteMany;单条删用 memory.delete,超时后同一个 commandId 重试,-32602 not found 的重试算已经删了
// (Review Focus 11)。memory.health 的 problems 里 delete_pending:<id> 对应的条目显示 删除中、按钮禁用。
// 删完 sources 非空就弹 DeleteSources(06 Task 6 的那个组件,08 §7.2 共用)。
import { useCallback, useEffect, useRef, useState } from 'react'
import type { MemoryItem, MemoryLayer } from '@mffai/protocol'
import { call, isUnsupported, retryable, toCallError } from '../rpc'
import { useMffaiEvent, useMffaiReset } from '../events'
import { Chip } from '../ui/Chip'
import { CodeChip } from '../ui/CodeChip'
import { DeleteSources } from '../ui/DeleteSources'

const ERR_INVALID = -32602
const LAYERS: readonly MemoryLayer[] = ['user', 'memory', 'topic', 'diary', 'session', 'raw']
const SCOPES = ['notes', 'raw', 'all'] as const
type Scope = (typeof SCOPES)[number]
const PENDING_PREFIX = 'delete_pending:'
const PAGE = 50

function ItemRow({ item, checked, pending, onToggle, onGone }: {
  item: MemoryItem
  checked: boolean
  pending: boolean
  onToggle: (id: string) => void
  onGone: (id: string, sources: string[]) => void
}) {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const inflight = useRef(false)
  const retry = useRef(retryable()).current

  const del = async () => {
    if (inflight.current || pending) return
    inflight.current = true
    setBusy(true)
    setFailed(false)
    try {
      const r = await call('memory.delete', { commandId: retry.id(item.id), id: item.id })
      retry.done(item.id)
      onGone(item.id, r.sources)
    } catch (e) {
      const c = toCallError(e)
      if (c.code === ERR_INVALID && /not found/.test(c.message)) { retry.done(item.id); onGone(item.id, []); return }
      console.error('mffai memory.delete', c)
      setFailed(true)
    } finally {
      inflight.current = false
      setBusy(false)
    }
  }

  return (
    <div className="mffai-row mffai-itemrow" data-item={item.id}>
      <input type="checkbox" aria-label={`选择 ${item.id}`} checked={checked} disabled={pending} onChange={() => onToggle(item.id)} />
      <span className="mffai-v mffai-itemtext">{item.text}</span>
      <Chip>{item.layer}</Chip>
      {item.source && <Chip tone="muted">{item.source}</Chip>}
      {item.ts !== undefined && <span className="mffai-sess-time">{new Date(item.ts).toLocaleString()}</span>}
      {item.flags?.map((fl) => <CodeChip key={fl} code={fl} />)}
      {pending
        ? <Chip tone="warn">删除中</Chip>
        : <button className="set-btn" disabled={busy} onClick={() => void del()}>删除</button>}
      {failed && <span className="mffai-fail">失败</span>}
    </div>
  )
}

export default function Items() {
  const [layer, setLayer] = useState<MemoryLayer>('user')
  const [mode, setMode] = useState<'list' | 'search'>('list')
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<Scope>('notes')
  const [items, setItems] = useState<MemoryItem[] | null>(null)
  const [failed, setFailed] = useState<'unsupported' | 'failed' | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set())
  const [notes, setNotes] = useState<string[] | null>(null)
  const [batchBusy, setBatchBusy] = useState(false)
  const [batchFailed, setBatchFailed] = useState<'unsupported' | 'failed' | null>(null)

  const alive = useRef(true)
  const batchInflight = useRef(false)
  const batchRetry = useRef(retryable()).current

  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  const loadHealth = useCallback(() => {
    void call('memory.health').then(
      (h) => {
        if (!alive.current) return
        setPendingIds(new Set(h.problems.filter((p) => p.startsWith(PENDING_PREFIX)).map((p) => p.slice(PENDING_PREFIX.length))))
      },
      () => {},
    )
  }, [])
  useEffect(loadHealth, [loadHealth])
  useMffaiEvent({ types: ['memory.deleted'] }, loadHealth)

  const loadList = useCallback((before?: number) => {
    void call('memory.list', { layer, limit: PAGE, ...(before !== undefined && { before }) }).then(
      (r) => {
        if (!alive.current) return
        setFailed(null)
        setItems((prev) => (before === undefined ? r.items : [...(prev ?? []), ...r.items]))
      },
      (e) => { if (alive.current) setFailed(isUnsupported(e) ? 'unsupported' : 'failed') },
    )
  }, [layer])

  const runSearch = useCallback(() => {
    const q = query.trim()
    if (!q) return
    setMode('search')
    void call('memory.search', { query: q, layer: scope, limit: PAGE }).then(
      (r) => { if (alive.current) { setFailed(null); setItems(r.items) } },
      (e) => { if (alive.current) setFailed(isUnsupported(e) ? 'unsupported' : 'failed') },
    )
  }, [query, scope])

  useEffect(() => {
    if (mode === 'list') { setItems(null); loadList() }
    // 搜索模式下切层不重搜:只有点搜索才发
  }, [mode, loadList])

  const reset = () => { setMode('list'); setQuery(''); setSelected(new Set()) }
  useMffaiReset(() => { setItems(null); if (mode === 'list') loadList(); else runSearch() })

  const toggle = (id: string) => setSelected((s) => {
    const next = new Set(s)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })

  const removeFromList = (id: string) => {
    setItems((prev) => (prev ? prev.filter((x) => x.id !== id) : prev))
    setSelected((s) => { if (!s.has(id)) return s; const next = new Set(s); next.delete(id); return next })
  }

  const onRowGone = (id: string, sources: string[]) => {
    removeFromList(id)
    if (sources.length) setNotes((n) => [...new Set([...(n ?? []), ...sources])])
  }

  const deleteSelected = async () => {
    if (batchInflight.current || selected.size === 0) return
    const ids = [...selected]
    const key = ids.slice().sort().join(',')
    batchInflight.current = true
    setBatchBusy(true)
    setBatchFailed(null)
    try {
      const r = await call('memory.deleteMany', { commandId: batchRetry.id(key), ids })
      batchRetry.done(key)
      if (!alive.current) return
      setItems((prev) => (prev ? prev.filter((x) => !ids.includes(x.id)) : prev))
      setSelected(new Set())
      if (r.sources.length) setNotes((n) => [...new Set([...(n ?? []), ...r.sources])])
    } catch (e) {
      const c = toCallError(e)
      console.error('mffai memory.deleteMany', c)
      if (!alive.current) return
      setBatchFailed(isUnsupported(c) ? 'unsupported' : 'failed')
    } finally {
      batchInflight.current = false
      if (alive.current) setBatchBusy(false)
    }
  }

  const loadMore = () => {
    const last = items?.at(-1)
    if (last?.ts !== undefined) loadList(last.ts)
  }

  if (failed === 'unsupported') return <div className="mffai-pane mffai-memitems"><Chip tone="bad">不支持</Chip></div>

  return (
    <div className="mffai-pane mffai-memitems">
      <div className="mffai-row">
        <span className="mffai-k">层</span>
        <select aria-label="层" value={layer} disabled={mode === 'search'}
          onChange={(e) => { setMode('list'); setLayer(e.target.value as MemoryLayer) }}>
          {LAYERS.map((l) => <option key={l} value={l}>{l}</option>)}
        </select>
        <input aria-label="搜索" className="mffai-filter" value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') runSearch() }} />
        <select aria-label="搜索范围" value={scope} onChange={(e) => setScope(e.target.value as Scope)}>
          {SCOPES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <button className="set-btn" onClick={runSearch}>搜索</button>
        {mode === 'search' && <button className="set-btn" onClick={reset}>返回列表</button>}
      </div>
      {failed === 'failed' && <span className="mffai-fail">失败</span>}
      <div className="mffai-group">
        {items?.map((it) => (
          <ItemRow key={it.id} item={it} checked={selected.has(it.id)} pending={pendingIds.has(it.id)}
            onToggle={toggle} onGone={onRowGone} />
        ))}
      </div>
      <div className="mffai-actions">
        {mode === 'list' && items && items.length > 0 && items.at(-1)?.ts !== undefined && (
          <button className="set-btn mffai-older" onClick={loadMore}>更早</button>
        )}
        {selected.size > 0 && (
          <button className="set-btn mffai-primary" disabled={batchBusy} onClick={() => void deleteSelected()}>
            {`删除所选 ${selected.size}`}
          </button>
        )}
        {batchFailed === 'unsupported' && <Chip tone="bad">不支持</Chip>}
        {batchFailed === 'failed' && <span className="mffai-fail">失败</span>}
      </div>
      {notes && <DeleteSources title={(n) => `对话里的原话 ${n} 条`} ids={notes} onClose={() => setNotes(null)} />}
    </div>
  )
}

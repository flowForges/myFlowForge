// 每轮尾巴(08 §8.2、§8.4),排在这一轮最后一条消息后面:压缩分隔线、自动放行收回分隔线、用量、记忆 N、插件索引、
// 已拦截、失败、改动 N / 不可回滚、回滚本轮。委派的用量不在这里,在运行卡片上。
// 08b:一排轻按钮(改动 N、记忆 N、插件索引)、已拦截块、等宽的用量文字、弹簧、回滚本轮。
import { useEffect, useRef, useState } from 'react'
import { call, retryable, toCallError } from '../rpc'
import { route } from '../route'
import { Chip } from '../ui/Chip'
import { CodeChip } from '../ui/CodeChip'
import { Confirm } from '../ui/Confirm'
import { Icon } from '../shell/icons'
import { ChangesBlock } from './ChangesBlock'
import type { TurnView } from './reduce'

const TEXT_MAX = 160

function MemoryList({ ids }: { ids: string[] }) {
  const [texts, setTexts] = useState<Map<string, string>>(new Map())
  const key = ids.join('\u0000')
  useEffect(() => {
    let alive = true
    for (const id of key.split('\u0000')) {
      void call('memory.get', { id }).then(
        (m) => { if (alive) setTexts((cur) => new Map(cur).set(id, m.text.length > TEXT_MAX ? m.text.slice(0, TEXT_MAX) + '…' : m.text)) },
        () => {},
      )
    }
    return () => { alive = false }
  }, [key])
  return (
    <ul className="mffai-pop mffai-memlist" role="list">
      {ids.map((id) => (
        <li key={id}>
          <button className="menu-item mffai-memitem" onClick={() => route.set({ page: 'memory' })}>
            <CodeChip code={id} />
            <span className="mffai-v">{texts.get(id) ?? ''}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}

export function TurnTail({ sessionId, turn, canRollback }: { sessionId: string; turn: TurnView; canRollback: boolean }) {
  const [mem, setMem] = useState(false)
  const [changes, setChanges] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [local, setLocal] = useState<{ files: number; skipped: string[] } | null>(null)
  const inflight = useRef(false)
  const retry = useRef(retryable()).current

  const rolled = turn.rolledBack ?? local
  const snap = turn.snapshot
  const failure = turn.terminal?.type === 'turn.failed' ? turn.terminal.reason ?? '' : undefined
  const u = turn.usage

  const rollback = async () => {
    setConfirm(false)
    if (inflight.current) return
    inflight.current = true
    setBusy(true)
    setFailed(false)
    const key = sessionId + '\u0000' + turn.turnId
    try {
      const r = await call('turn.rollback', { commandId: retry.id(key), sessionId, turnId: turn.turnId })
      retry.done(key)
      setLocal({ files: r.files, skipped: r.skipped ?? [] })
    } catch (e) {
      console.error('mffai turn.rollback', toCallError(e))
      setFailed(true)
    } finally {
      inflight.current = false
      setBusy(false)
    }
  }

  return (
    <div className="mffai-tail" data-turn={turn.turnId}>
      {turn.rebuilt?.map((r, i) => <div key={i} className="mffai-divider">{`上下文已压缩 ${r.before} → ${r.after}`}</div>)}
      {turn.narrowed && <div className="mffai-divider">自动放行已收回</div>}
      <div className="mffai-tail-row">
        {snap?.changed !== undefined && snap.changed > 0 && (
          <button className="txt-btn mffai-tbtn" aria-expanded={changes} onClick={() => setChanges(!changes)}><Icon name="file" size={13} />{`改动 ${snap.changed}`}</button>
        )}
        {turn.injected && turn.injected.items.length > 0 && (
          <span className="mffai-tail-pop">
            <button className="txt-btn mffai-tbtn" aria-expanded={mem} onClick={() => setMem(!mem)}><Icon name="brain" size={13} />{`记忆 ${turn.injected.items.length}`}</button>
            {mem && <MemoryList ids={turn.injected.items} />}
          </span>
        )}
        {turn.plugins && <span className="mffai-tbtn mffai-tail-tag"><Icon name="puzzle" size={13} />插件索引</span>}
        {turn.netDenied.map((h, i) => <Chip key={i} tone="warn" sq><Icon name="globe" />{`已拦截 ${h}`}</Chip>)}
        {failure !== undefined && (failure === 'cancelled' ? <Chip>已停止</Chip> : <CodeChip code={failure} />)}
        {snap?.reason && <><Chip tone="warn">不可回滚</Chip><CodeChip code={snap.reason} /></>}
        {rolled && (
          <>
            <Chip tone="ok">{`已回滚 ${rolled.files} 个文件`}</Chip>
            {rolled.skipped.map((p) => <CodeChip key={p} code={p} />)}
          </>
        )}
        {u && <span className="mffai-tail-use">{`输入 ${u.input} · 输出 ${u.output} · 缓存 ${u.cacheRead ?? 0}`}</span>}
        {failed && <span className="mffai-fail">失败</span>}
        {canRollback && !rolled && (
          <>
            <span className="mffai-spring" />
            <button className="txt-btn mffai-tbtn" disabled={busy} onClick={() => setConfirm(true)}><Icon name="undo" size={13} />回滚本轮</button>
          </>
        )}
      </div>
      {changes && (
        <ChangesBlock
          load={() => call('turn.changes', { sessionId, turnId: turn.turnId })}
          diff={(path) => call('turn.diff', { sessionId, turnId: turn.turnId, path })}
        />
      )}
      {confirm && (
        <Confirm title="回滚本轮" rows={[['文件', String(snap?.changed ?? 0)]]} confirmLabel="回滚本轮" danger
          onCancel={() => setConfirm(false)} onConfirm={() => void rollback()} />
      )}
    </div>
  )
}

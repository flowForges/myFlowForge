// 习惯(08 §12.4):memory.habits.list,每条 周几 几点 · 目录 + 状态,确认/忽略只对 detected 的有意义。
// 开关 主动推荐(memory.recommendations.set)没有读接口(memory-default 只写配置,见 index.ts setRoutine):
// 这里只是发送上次点的那个值,不代表后台当下的真实状态。
import { useCallback, useEffect, useRef, useState } from 'react'
import type { MemoryHabit } from '@mffai/protocol'
import { call, cmd, isUnsupported, toCallError } from '../rpc'
import { useMffaiEvent, useMffaiReset } from '../events'
import { Chip } from '../ui/Chip'

const DAY_NAMES = ['日', '一', '二', '三', '四', '五', '六']
const STATUS_LABEL: Record<MemoryHabit['status'], string> = { detected: '待确认', confirmed: '已确认', dismissed: '已忽略' }
const STATUS_TONE = { detected: 'warn', confirmed: 'ok', dismissed: 'muted' } as const

function HabitRow({ h, onDecided }: { h: MemoryHabit; onDecided: () => void }) {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const inflight = useRef(false)

  const decide = async (decision: 'confirmed' | 'dismissed') => {
    if (inflight.current) return
    inflight.current = true
    setBusy(true)
    setFailed(false)
    try {
      await call('memory.habits.decide', { commandId: cmd(), id: h.id, decision })
      onDecided()
    } catch (e) {
      console.error('mffai memory.habits.decide', toCallError(e))
      setFailed(true)
    } finally {
      inflight.current = false
      setBusy(false)
    }
  }

  return (
    <div className="mffai-row mffai-habit" data-habit={h.id}>
      <span className="mffai-v">{`周${DAY_NAMES[h.weekday] ?? h.weekday} ${h.hour} 点 · ${h.cwd}`}</span>
      <Chip tone={STATUS_TONE[h.status]}>{STATUS_LABEL[h.status]}</Chip>
      {h.status === 'detected' && (
        <>
          <button className="set-btn" disabled={busy} onClick={() => void decide('confirmed')}>确认</button>
          <button className="set-btn" disabled={busy} onClick={() => void decide('dismissed')}>忽略</button>
        </>
      )}
      {failed && <span className="mffai-fail">失败</span>}
    </div>
  )
}

export function Habits() {
  const [items, setItems] = useState<MemoryHabit[] | null>(null)
  const [failed, setFailed] = useState<'unsupported' | 'failed' | null>(null)
  const [routine, setRoutine] = useState(false)
  const [routineBusy, setRoutineBusy] = useState(false)
  const [routineFailed, setRoutineFailed] = useState<'unsupported' | 'failed' | null>(null)
  const inflight = useRef(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  const load = useCallback(() => {
    void call('memory.habits.list').then(
      (r) => { if (alive.current) { setItems(r.items); setFailed(null) } },
      (e) => { if (alive.current) setFailed(isUnsupported(e) ? 'unsupported' : 'failed') },
    )
  }, [])
  useEffect(load, [load])
  useMffaiEvent({ types: ['memory.recommendation'] }, load)
  useMffaiReset(load)

  const toggleRoutine = async (on: boolean) => {
    if (inflight.current) return
    inflight.current = true
    setRoutineBusy(true)
    setRoutineFailed(null)
    try {
      await call('memory.recommendations.set', { commandId: cmd(), routine: on })
      if (alive.current) setRoutine(on)
    } catch (e) {
      const c = toCallError(e)
      console.error('mffai memory.recommendations.set', c)
      if (alive.current) setRoutineFailed(isUnsupported(c) ? 'unsupported' : 'failed')
    } finally {
      inflight.current = false
      if (alive.current) setRoutineBusy(false)
    }
  }

  if (failed === 'unsupported') return <div className="mffai-pane mffai-habits"><Chip tone="bad">不支持</Chip></div>

  return (
    <div className="mffai-pane mffai-habits">
      <div className="mffai-row">
        <label className="mffai-switch">
          <input type="checkbox" role="switch" checked={routine} disabled={routineBusy} onChange={(e) => void toggleRoutine(e.target.checked)} />
          主动推荐
        </label>
        {routineFailed === 'unsupported' && <Chip tone="bad">不支持</Chip>}
        {routineFailed === 'failed' && <span className="mffai-fail">失败</span>}
      </div>
      {failed === 'failed' && <span className="mffai-fail">失败</span>}
      {items?.map((h) => <HabitRow key={h.id} h={h} onDecided={load} />)}
    </div>
  )
}

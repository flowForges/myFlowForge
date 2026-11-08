// 对话页顶部的习惯推荐卡片(08 §12.4):memory.recommendation 到了才有,没有列出已有推荐的接口,纯事件驱动。
// 开会话:在它的 cwd 建会话,走 Task 6 NewSession 的 initial 默认(route.newSession);
// 不再提:memory.habits.decide dismissed,成功才摘掉卡片。
import { useRef, useState } from 'react'
import type { MemoryRecommendationPayload } from '@mffai/protocol'
import { call, cmd, toCallError } from '../rpc'
import { useMffaiEvent } from '../events'
import { route } from '../route'

function RecRow({ rec, onOpened, onDismissed }: {
  rec: MemoryRecommendationPayload
  onOpened: () => void
  onDismissed: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const inflight = useRef(false)

  const dismiss = async () => {
    if (inflight.current) return
    inflight.current = true
    setBusy(true)
    setFailed(false)
    try {
      await call('memory.habits.decide', { commandId: cmd(), id: rec.habitId, decision: 'dismissed' })
      onDismissed()
    } catch (e) {
      console.error('mffai memory.habits.decide', toCallError(e))
      setFailed(true)
    } finally {
      inflight.current = false
      setBusy(false)
    }
  }

  const open = () => {
    onOpened()
    route.set({ page: 'chat', newSession: { cwd: rec.cwd } })
  }

  return (
    <div className="mffai-card mffai-rec" data-rec={rec.id}>
      <span className="mffai-v">{rec.text}</span>
      <div className="mffai-actions">
        <button className="set-btn mffai-primary" onClick={open}>开会话</button>
        <button className="set-btn" disabled={busy} onClick={() => void dismiss()}>不再提</button>
        {failed && <span className="mffai-fail">失败</span>}
      </div>
    </div>
  )
}

export function RecommendationCard() {
  const [recs, setRecs] = useState<readonly MemoryRecommendationPayload[]>([])

  useMffaiEvent({ types: ['memory.recommendation'] }, (e) => {
    const p = e.payload as MemoryRecommendationPayload
    setRecs((rs) => (rs.some((r) => r.id === p.id) ? rs : [...rs, p]))
  })

  const remove = (id: string) => setRecs((rs) => rs.filter((r) => r.id !== id))

  if (recs.length === 0) return null
  return (
    <div className="mffai-recs">
      {recs.map((r) => <RecRow key={r.id} rec={r} onOpened={() => remove(r.id)} onDismissed={() => remove(r.id)} />)}
    </div>
  )
}

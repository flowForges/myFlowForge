// 选中会话的视图(08 §8.1):session.state → fromState;之后这个会话的实时事件进同一个 reduce(seq <= lastSeq 的丢掉)。
// 后台日志重置(reset 告警)、缓存里的 seq 被抹(events.redacted)→ 丢掉缓存重取;整会话抹除 → 回到列表。往上翻:session.events。
import { useCallback, useEffect, useRef, useState } from 'react'
import type { KernelEvent, SessionSummary, WorkerResult } from '@mffai/protocol'
import { call, isUnsupported, toCallError } from '../rpc'
import { useMffaiEvent, useMffaiReset } from '../events'
import { route } from '../route'
import { fromState, reduce, type SessionView } from './reduce'

const ERR_INVALID = -32602
const PAGE = 300

export type SessionError = 'gone' | 'unsupported' | 'failed'

interface Cache {
  view: SessionView
  /** 视图里每一条原始事件,seq 升序:往上翻时整份重算,被抹的 seq 靠它认。实时事件原地追加,不每条拷一份 */
  events: KernelEvent[]
  session: SessionSummary
}

/** 现有视图之外再加一段更早的事件:整份重算,open、lastSeq 沿用现在的,旧审批的判断也沿用 */
function rebuild(c: Cache, events: KernelEvent[], hasMore: boolean): SessionView {
  const live = c.view.turns.flatMap((t) => t.approvals.filter((a) => !a.resolved && !a.stale).map((a) => a.approvalId))
  const r: WorkerResult<'session.state'> = {
    session: c.session, events, hasMore, lastSeq: c.view.lastSeq,
    ...(c.view.open && { open: { ...c.view.open, approvalIds: live } }),
  }
  return fromState(r)
}

export function useSession(sessionId: string): {
  view: SessionView | null
  session?: SessionSummary
  loadOlder(): void
  reload(): void
  error: SessionError | null
} {
  const [cache, setCache] = useState<Cache | null>(null)
  const [error, setError] = useState<SessionError | null>(null)
  /** 最新的缓存,同步更新:同一批里到的几条事件一条接一条地 reduce */
  const ref = useRef<Cache | null>(null)
  const commit = useCallback((c: Cache | null) => { ref.current = c; setCache(c) }, [])
  /** session.state 在路上时到的实时事件:答回来之后按 seq 补上 */
  const pending = useRef<KernelEvent[] | null>(null)
  const gen = useRef(0)
  const older = useRef(false)

  const reload = useCallback(() => {
    const my = ++gen.current
    pending.current = []
    void call('session.state', { sessionId }).then(
      (r) => {
        if (my !== gen.current) return
        let view = fromState(r)
        const events = [...r.events]
        for (const e of pending.current ?? []) {
          const next = reduce(view, e)
          if (next !== view) { view = next; events.push(e) }
        }
        pending.current = null
        setError(null)
        commit({ view, events, session: r.session })
      },
      (e) => {
        if (my !== gen.current) return
        pending.current = null
        const c = toCallError(e)
        if (!isUnsupported(c)) console.error('mffai session.state', c)
        // 会话没了:缓存里的原话也不能再显示
        if (c.code === ERR_INVALID) commit(null)
        setError(c.code === ERR_INVALID ? 'gone' : isUnsupported(c) ? 'unsupported' : 'failed')
      },
    )
  }, [sessionId, commit])

  useEffect(() => {
    commit(null)
    setError(null)
    reload()
    return () => { gen.current++ }
  }, [reload, commit])

  useMffaiEvent({ sessionId }, (e) => {
    if (pending.current) { pending.current.push(e); return }
    const c = ref.current
    if (!c) return
    const view = reduce(c.view, e)
    if (view === c.view) return
    c.events.push(e)
    commit({ ...c, view })
  })

  useMffaiEvent({ types: ['events.redacted'] }, (e) => {
    const p = (e.payload ?? {}) as { seqs?: unknown; session?: unknown }
    if (p.session === sessionId) {
      gen.current++
      commit(null)
      if (route.get().sessionId === sessionId) route.set({ page: 'chat' })
      return
    }
    const seqs = new Set(Array.isArray(p.seqs) ? p.seqs : [])
    const c = ref.current
    if (seqs.size && c?.events.some((x) => seqs.has(x.seq))) reload()
  })

  useMffaiReset(reload)

  const loadOlder = useCallback(() => {
    const c = ref.current
    if (!c || !c.view.hasMore || older.current) return
    older.current = true
    const my = gen.current
    void call('session.events', { sessionId, beforeSeq: c.view.firstSeq, limit: PAGE }).then(
      (r) => {
        const cur = ref.current
        if (my !== gen.current || !cur) return
        const first = cur.events[0]?.seq ?? Infinity
        const events = [...r.events.filter((x) => x.seq < first), ...cur.events]
        commit({ ...cur, events, view: rebuild(cur, events, r.hasMore) })
      },
      (e) => console.error('mffai session.events', toCallError(e)),
    ).finally(() => { older.current = false })
  }, [sessionId, commit])

  return { view: cache?.view ?? null, session: cache?.session, loadOlder, reload, error }
}

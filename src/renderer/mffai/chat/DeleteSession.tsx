// 删除会话的确认框(08 §7.2、评审修订 R2)。行都是事实:会话、保留的 worktree、未合并的改动(按运行列出,
// 每行一个 去合并)、来源、别的会话里的引用:保留。有未合并的改动时按钮是 删除并丢弃改动,
// discardUnmerged 只带列出来的运行 id;后台再回 unmerged 就按它给的刷新,不自动重发。
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { RunRow, SessionSummary } from '@mffai/protocol'
import { call, isUnsupported, retryable, toCallError } from '../rpc'
import { useMffaiEvent } from '../events'
import { route } from '../route'
import { Confirm } from '../ui/Confirm'

const ERR_INVALID = -32602
const ERR_BUSY = -32003
const ERR_INTERNAL = -32603

type Unmerged = { runId: string; files: number }

/** 有改动、worktree 还在、没合并过 */
const isUnmerged = (r: RunRow) => (r.changed ?? 0) > 0 && !!r.worktree?.present && !r.worktree.merged

function unmergedRefusal(e: unknown): Unmerged[] | undefined {
  const err = toCallError(e)
  const d = err.data as { reason?: unknown; runs?: unknown } | undefined
  if (err.code !== ERR_INVALID || d?.reason !== 'unmerged' || !Array.isArray(d.runs)) return undefined
  return d.runs.flatMap((r: { runId?: unknown; files?: unknown }) =>
    typeof r?.runId === 'string' ? [{ runId: r.runId, files: typeof r.files === 'number' ? r.files : 0 }] : [])
}

export function DeleteSession({ session, onClose, onDeleted }: {
  session: SessionSummary
  onClose: () => void
  onDeleted: (notes: string[]) => void
}) {
  const [runs, setRuns] = useState<RunRow[] | null>(null)
  const [unmerged, setUnmerged] = useState<Unmerged[]>([])
  const [busy, setBusy] = useState(false)
  const inflight = useRef(false)
  const [err, setErr] = useState<'unsupported' | 'failed' | null>(null)
  const retry = useRef(retryable()).current
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  const loadRuns = useCallback(() => {
    void call('executor.runs', { limit: 200 }).then(
      (r) => r.runs.filter((x) => x.sessionId === session.id),
      (e) => { if (!isUnsupported(e)) console.error('mffai executor.runs', e); return [] as RunRow[] },
    ).then((mine) => {
      if (!alive.current) return
      setRuns(mine)
      setUnmerged(mine.filter(isUnmerged).map((r) => ({ runId: r.runId, files: r.changed ?? 0 })))
    })
  }, [session.id])
  useEffect(loadRuns, [loadRuns])
  // worktree 在 session.deleted 之后才异步清掉:到了就重拉
  useMffaiEvent({ types: ['session.deleted', 'executor.worktree.merged'] }, loadRuns)

  const executorOf = (runId: string) => runs?.find((r) => r.runId === runId)?.executor ?? runId
  const ids = unmerged.map((u) => u.runId)

  const confirm = async () => {
    if (inflight.current || runs === null) return
    const key = JSON.stringify([session.id, ids])
    inflight.current = true
    setBusy(true)
    setErr(null)
    try {
      const r = await call('session.delete', { commandId: retry.id(key), sessionId: session.id, ...(ids.length > 0 && { discardUnmerged: ids }) })
      retry.done(key)
      if (alive.current) onDeleted(r.notes)
    } catch (e) {
      if (!alive.current) return
      const refused = unmergedRefusal(e)
      const c = toCallError(e)
      if (refused) setUnmerged(refused)
      else if (c.code === ERR_BUSY) loadRuns()
      else if (isUnsupported(c) || (c.code === ERR_INTERNAL && c.message === 'memory is unavailable')) setErr('unsupported')
      else { console.error('mffai session.delete', c); setErr('failed') }
    } finally {
      inflight.current = false
      if (alive.current) setBusy(false)
    }
  }

  const goMerge = (runId: string) => {
    onClose()
    route.set({ page: 'chat', sessionId: session.id, runId })
  }

  const rows: (readonly [string, ReactNode, ReactNode?])[] = [
    ['会话', session.title],
    ['删除 worktree', String(runs?.filter((r) => r.worktree?.present).length ?? 0)],
  ]
  if (unmerged.length) {
    rows.push(['未合并的改动', `${unmerged.reduce((n, u) => n + u.files, 0)} 个文件`])
    for (const u of unmerged) {
      rows.push(['', `${executorOf(u.runId)} · ${u.files} 个文件`, <button key={u.runId} className="set-btn" onClick={() => goMerge(u.runId)}>去合并</button>])
    }
  }
  if (session.origin === 'im') rows.push(['来源', 'Telegram'])
  rows.push(['别的会话里的引用', '保留'])

  return (
    <Confirm title="删除会话" rows={rows} danger busy={busy || runs === null}
      confirmLabel={unmerged.length ? '删除并丢弃改动' : '删除'}
      onCancel={onClose} onConfirm={() => void confirm()}>
      {err === 'unsupported' && <span className="mffai-fail">不支持</span>}
      {err === 'failed' && <span className="mffai-fail">失败</span>}
    </Confirm>
  )
}

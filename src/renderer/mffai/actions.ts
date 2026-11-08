// 运行卡片和任务页共用的动作执行器(Task 8 评审):委派运行的 停止/合并/丢弃,IM worktree 的 合并/丢弃。
// 重试(超时后)用同一个 commandId,成功或被拒后换新的;两次点击落在同一帧里只发一次;-32003 显示 忙。
import { useRef, useState } from 'react'
import type { MergeRefusal } from '@mffai/protocol'
import { call, cmd, retryable, toCallError } from './rpc'

const ERR_INVALID = -32602
const ERR_BUSY = -32003
const K = '\u0000'

/** 合并被拒:-32602 带 data.reason(和路径、是否已还原) */
export function refusalOf(e: unknown): MergeRefusal | undefined {
  const c = toCallError(e)
  const d = c.data as { reason?: unknown; paths?: unknown; restored?: unknown } | undefined
  if (c.code !== ERR_INVALID || typeof d?.reason !== 'string') return undefined
  return {
    reason: d.reason as MergeRefusal['reason'],
    ...(Array.isArray(d.paths) && { paths: d.paths.filter((p): p is string => typeof p === 'string') }),
    ...(typeof d.restored === 'boolean' && { restored: d.restored }),
  }
}

/**
 * scope 把同一个对象的同一个动作认成同一个操作;fresh 里的动作每次都用新 commandId(停止不重放);
 * 只有 merge 认被拒
 */
export function useActionRunner<A extends string>(opts: { scope: string; fresh?: readonly A[]; log: string }) {
  const [busy, setBusy] = useState<A | null>(null)
  const [failed, setFailed] = useState<{ action: A; busy: boolean } | null>(null)
  const [refusal, setRefusal] = useState<MergeRefusal | null>(null)
  const inflight = useRef(false)
  const retry = useRef(retryable()).current

  const run = async (action: A, f: (commandId: string) => Promise<void>) => {
    if (inflight.current) return
    inflight.current = true
    setBusy(action)
    setFailed(null)
    if (action === 'merge') setRefusal(null)
    const key = action + K + opts.scope
    try {
      await f(opts.fresh?.includes(action) ? cmd() : retry.id(key))
      retry.done(key)
    } catch (e) {
      const r = action === 'merge' ? refusalOf(e) : undefined
      if (r) { retry.done(key); setRefusal(r) } else {
        const c = toCallError(e)
        console.error(`${opts.log} ${action}`, c)
        setFailed({ action, busy: c.code === ERR_BUSY })
      }
    } finally {
      inflight.current = false
      setBusy(null)
    }
  }

  return { busy, failed, refusal, run }
}

export type RunAction = 'stop' | 'merge' | 'discard'

/** 一个委派运行的 停止 / 合并 / 丢弃 */
export function useRunActions(sessionId: string, runId: string) {
  const r = useActionRunner<RunAction>({ scope: sessionId + K + runId, fresh: ['stop'], log: 'mffai executor' })
  const [merged, setMerged] = useState<{ files: number } | null>(null)
  const [discarded, setDiscarded] = useState(false)
  return {
    busy: r.busy, failed: r.failed, refusal: r.refusal, merged, discarded,
    stop: () => r.run('stop', async (commandId) => { await call('executor.cancel', { commandId, sessionId, runId }) }),
    merge: () => r.run('merge', async (commandId) => {
      const res = await call('executor.worktree.merge', { commandId, sessionId, runId })
      setMerged({ files: res.files })
    }),
    discard: () => r.run('discard', async (commandId) => {
      const res = await call('executor.worktree.discard', { commandId, sessionId, runId })
      if (!res.ok) throw new Error('discard refused')
      setDiscarded(true)
    }),
  }
}

/** IM worktree 的 合并 / 丢弃:没有会话,参数是 worktreeId */
export function useWorktreeActions(worktreeId: string) {
  const r = useActionRunner<'merge' | 'discard'>({ scope: worktreeId, log: 'mffai telegram worktree' })
  const [merged, setMerged] = useState<{ files: number } | null>(null)
  const [discarded, setDiscarded] = useState(false)
  return {
    busy: r.busy, failed: r.failed, refusal: r.refusal, merged, discarded,
    merge: () => r.run('merge', async (commandId) => {
      const res = await call('channel.telegram.worktree.merge', { commandId, worktreeId })
      setMerged({ files: res.files })
    }),
    discard: () => r.run('discard', async (commandId) => {
      const res = await call('channel.telegram.worktree.discard', { commandId, worktreeId })
      if (!res.ok) throw new Error('discard refused')
      setDiscarded(true)
    }),
  }
}

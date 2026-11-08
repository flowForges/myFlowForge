// 委派运行卡片(08 §8.5):按 runId 的 queued → started → progress* → ended。头、最近 5 条进度、结束后的结果,
// 按钮 停止(只停这一个)/ 合并 / 丢弃。合并被拒按 data.reason 显示,带路径;写到一半没还原的标 未还原。
// useRunActions 给任务页(Task 8)共用。
import { useRef, useState } from 'react'
import type { MergeRefusal, RunRow } from '@mffai/protocol'
import { CopyButton } from '../../views/chat/blocks'
import { call, cmd, retryable, toCallError } from '../rpc'
import { label } from '../labels'
import { Chip } from '../ui/Chip'
import { CodeChip } from '../ui/CodeChip'
import { Confirm } from '../ui/Confirm'
import { ChangesBlock } from './ChangesBlock'
import type { RunItem } from './reduce'

const ERR_INVALID = -32602
const ERR_BUSY = -32003
const SHOWN = 5
const K = '\u0000'

export type RunAction = 'stop' | 'merge' | 'discard'

function refusalOf(e: unknown): MergeRefusal | undefined {
  const c = toCallError(e)
  const d = c.data as { reason?: unknown; paths?: unknown; restored?: unknown } | undefined
  if (c.code !== ERR_INVALID || typeof d?.reason !== 'string') return undefined
  return {
    reason: d.reason as MergeRefusal['reason'],
    ...(Array.isArray(d.paths) && { paths: d.paths.filter((p): p is string => typeof p === 'string') }),
    ...(typeof d.restored === 'boolean' && { restored: d.restored }),
  }
}

/** 一个运行的 停止 / 合并 / 丢弃。重试(超时后)用同一个 commandId;两次点击落在同一帧里只发一次 */
export function useRunActions(sessionId: string, runId: string) {
  const [busy, setBusy] = useState<RunAction | null>(null)
  const [failed, setFailed] = useState<{ action: RunAction; busy: boolean } | null>(null)
  const [refusal, setRefusal] = useState<MergeRefusal | null>(null)
  const [merged, setMerged] = useState<{ files: number } | null>(null)
  const [discarded, setDiscarded] = useState(false)
  const inflight = useRef(false)
  const retry = useRef(retryable()).current

  const run = async (action: RunAction, f: (commandId: string) => Promise<void>) => {
    if (inflight.current) return
    inflight.current = true
    setBusy(action)
    setFailed(null)
    if (action === 'merge') setRefusal(null)
    const key = action + K + sessionId + K + runId
    try {
      await f(action === 'stop' ? cmd() : retry.id(key))
      retry.done(key)
    } catch (e) {
      const r = action === 'merge' ? refusalOf(e) : undefined
      if (r) { retry.done(key); setRefusal(r) } else {
        const c = toCallError(e)
        console.error(`mffai executor ${action}`, c)
        setFailed({ action, busy: c.code === ERR_BUSY })
      }
    } finally {
      inflight.current = false
      setBusy(null)
    }
  }

  return {
    busy, failed, refusal, merged, discarded,
    stop: () => run('stop', async (commandId) => { await call('executor.cancel', { commandId, sessionId, runId }) }),
    merge: () => run('merge', async (commandId) => {
      const r = await call('executor.worktree.merge', { commandId, sessionId, runId })
      setMerged({ files: r.files })
    }),
    discard: () => run('discard', async (commandId) => {
      const r = await call('executor.worktree.discard', { commandId, sessionId, runId })
      if (!r.ok) throw new Error('discard refused')
      setDiscarded(true)
    }),
  }
}

const ICON: Record<string, string> = { tool: '⚙', file: '▤', text: '✎', think: '◌' }

const fmtMs = (ms: number) => (ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`)

function phaseChip(r: RunItem) {
  if (r.phase === 'queued') return <Chip>{r.position !== undefined ? `排队 #${r.position}` : '排队'}</Chip>
  if (r.phase === 'running') return <Chip tone="ok">运行中</Chip>
  const st = r.ended?.status ?? ''
  return <Chip tone={st === 'ok' ? 'ok' : st === 'cancelled' ? 'muted' : 'bad'}>{label('runStatus', st)}</Chip>
}

export function RunCard({ sessionId, checkout, run, turnOpen, row, onChanged }: {
  sessionId: string
  /** 会话的 cwd:合并写进的检出。运行的 cwd 是 worktree(来源),不能当目标 */
  checkout?: string
  run: RunItem
  /** 运行所在的轮还开着(后台的 open 为准):否则没结束的运行也不给停止 */
  turnOpen: boolean
  /** executor.runs 里这一行:worktree 还在不在、合并过没有(重开之后靠它) */
  row?: RunRow
  onChanged?: () => void
}) {
  const a = useRunActions(sessionId, run.runId)
  const [all, setAll] = useState(false)
  const [confirm, setConfirm] = useState<'merge' | 'discard' | null>(null)
  const [changes, setChanges] = useState(false)

  const end = run.ended
  const files = end ? end.changed.files.length + (end.changed.filesTruncated ?? 0) : 0
  const worktree = end?.worktree ?? run.worktree ?? row?.worktree?.path
  const present = !a.discarded && !!worktree && row?.worktree?.present !== false
  const merged = a.merged ?? run.merged ?? (row?.worktree?.merged ? { files: row.changed ?? files } : null)
  const canStop = run.phase !== 'ended' && turnOpen
  const canMerge = run.phase === 'ended' && present && files > 0 && !merged
  const canDiscard = run.phase === 'ended' && present
  const shown = all ? run.progress : run.progress.slice(-SHOWN)
  const ref = a.refusal

  const act = async (what: 'merge' | 'discard') => {
    setConfirm(null)
    await (what === 'merge' ? a.merge() : a.discard())
    onChanged?.()
  }

  return (
    <div className="mffai-card mffai-run" id={`mffai-run-${run.runId}`} data-run={run.runId}>
      <div className="mffai-card-head">
        <span className="mffai-tool">{run.executor}</span>
        {phaseChip(run)}
        {run.readOnly && <Chip>只读</Chip>}
        {run.isolation && <Chip tone={run.isolation === 'none' ? 'bad' : 'muted'}>{label('isolation', run.isolation)}</Chip>}
        {!!run.untranslatedRules && <Chip tone="warn">{`规则未翻译 ${run.untranslatedRules}`}</Chip>}
        {canStop && <button className="set-btn" disabled={a.busy === 'stop'} onClick={() => void a.stop()}>停止</button>}
      </div>
      {run.progress.length > 0 && (
        <ul className="mffai-progress">
          {shown.map((p) => (
            <li key={p.seq} className={`mffai-progress-row k-${p.kind}`}>
              <span className="mffai-progress-icon" aria-label={p.kind}>{ICON[p.kind] ?? '·'}</span>
              <span className="mffai-progress-text">{p.text}</span>
            </li>
          ))}
        </ul>
      )}
      {(run.progress.length > SHOWN || !!end?.droppedProgress) && (
        <div className="mffai-card-row">
          {run.progress.length > SHOWN && (
            <button className="txt-btn" onClick={() => setAll(!all)}>{all ? '收起' : `全部 ${run.progress.length}`}</button>
          )}
          {!!end?.droppedProgress && <Chip>{`省略 ${end.droppedProgress} 条`}</Chip>}
        </div>
      )}
      {end && (
        <div className="mffai-card-row mffai-run-end">
          {end.reason && <CodeChip code={end.reason} />}
          <Chip>{fmtMs(end.ms)}</Chip>
          {end.exit !== undefined && <Chip>{`exit ${end.exit}`}</Chip>}
          {end.signal && <CodeChip code={end.signal} />}
          {end.usage && <Chip>{`CLI 输入 ${end.usage.input} · 输出 ${end.usage.output}`}</Chip>}
          {files > 0 && (
            <button className="txt-btn" aria-expanded={changes} onClick={() => setChanges(!changes)}>{`${files} 个文件`}</button>
          )}
          {end.changed.concurrent && <Chip tone="warn">同时有其他改动</Chip>}
          {merged && <Chip tone="ok">{`已合并 ${merged.files} 个文件`}</Chip>}
          {a.discarded && <Chip>已丢弃</Chip>}
        </div>
      )}
      {end?.violations && end.violations.length > 0 && (
        <ul className="mffai-violations">
          {end.violations.map((v, i) => <li key={i}>{v}</li>)}
          {!!end.violationsTruncated && <li><Chip>{`还有 ${end.violationsTruncated} 条`}</Chip></li>}
        </ul>
      )}
      {end?.rawLog && (
        <div className="mffai-card-row mffai-rawlog">
          <code className="mffai-path">{end.rawLog}</code>
          <CopyButton className="mffai-copy" title={end.rawLog} text={() => end.rawLog ?? ''} />
        </div>
      )}
      {changes && (
        <ChangesBlock
          load={() => call('executor.changes', { sessionId, runId: run.runId })}
          diff={(path) => call('executor.diff', { sessionId, runId: run.runId, path })}
        />
      )}
      {ref && (
        <div className="mffai-card-row mffai-refusal">
          <CodeChip code={ref.reason} />
          {ref.restored === false && <Chip tone="bad">未还原</Chip>}
          {ref.paths?.map((p) => <code key={p} className="mffai-path">{p}</code>)}
        </div>
      )}
      {(canMerge || canDiscard || a.failed) && (
        <div className="mffai-card-actions">
          {canMerge && <button className="set-btn mffai-primary" disabled={!!a.busy} onClick={() => setConfirm('merge')}>合并</button>}
          {canDiscard && <button className="set-btn" disabled={!!a.busy} onClick={() => setConfirm('discard')}>丢弃</button>}
          {a.failed?.busy && <Chip tone="warn">忙</Chip>}
          {a.failed && !a.failed.busy && <span className="mffai-fail">失败</span>}
        </div>
      )}
      {confirm === 'merge' && (
        <Confirm title={checkout ? `合并到 ${checkout}` : '合并'} rows={[['worktree', worktree ?? ''], ['文件', String(files)]]} confirmLabel="合并"
          onCancel={() => setConfirm(null)} onConfirm={() => void act('merge')} />
      )}
      {confirm === 'discard' && (
        <Confirm title="丢弃 worktree" rows={[['路径', worktree ?? '']]} confirmLabel="丢弃" danger
          onCancel={() => setConfirm(null)} onConfirm={() => void act('discard')} />
      )}
    </div>
  )
}

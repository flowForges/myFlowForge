// 委派运行卡片(08 §8.5):按 runId 的 queued → started → progress* → ended。头、最近 5 条进度、结束后的结果,
// 按钮 停止(只停这一个)/ 合并 / 丢弃。合并被拒按 data.reason 显示,带路径;写到一半没还原的标 未还原。
// 动作执行器在 ../actions,任务页(Task 8)共用。
// 08b:运行中 = 强调色边框 + 渐变头(.live);结束 = 一行事实、违规、改动、合并 / 丢弃 / 日志路径的底栏。确认框锚在点的按钮上(R13)。
import { useState, type MouseEvent } from 'react'
import type { RunRow } from '@mffai/protocol'
import { CopyButton } from '../../views/chat/blocks'
import { call } from '../rpc'
import { useRunActions } from '../actions'
import { label } from '../labels'
import { Chip } from '../ui/Chip'
import { CodeChip } from '../ui/CodeChip'
import { Confirm } from '../ui/Confirm'
import { Icon, type IconName } from '../shell/icons'
import { visibleChars } from '../ui/visible'
import { ChangesBlock } from './ChangesBlock'
import type { RunItem } from './reduce'

const SHOWN = 5

export { useRunActions, type RunAction } from '../actions'

/** 进度的类型图标:读写文件、运行工具、消息、思考 */
const ICON: Record<string, IconName> = { tool: 'play', file: 'file', text: 'msg2', think: 'sparkle' }

const fmtMs = (ms: number) => (ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`)

/** 合并目标:从中间截断,最后一段(目录名)不缩,全路径在 title */
function TargetPath({ path }: { path: string }) {
  const cut = path.replace(/[\\/]+$/, '').search(/[^\\/]*$/)
  return (
    <code className="mffai-rcard-to" title={path}>
      <span className="mffai-rcard-to-head">{path.slice(0, cut)}</span>
      <span className="mffai-rcard-to-tail">{path.slice(cut)}</span>
    </code>
  )
}

function phaseChip(r: RunItem) {
  if (r.phase === 'queued') return <Chip>{r.position !== undefined ? `排队 #${r.position}` : '排队'}</Chip>
  if (r.phase === 'running') return <Chip tone="run" dot>运行中</Chip>
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
  /** executor.runs 里这一行:worktree 还在不在、合并过没有。没有这一行 = 不知道,不给合并、丢弃 */
  row?: RunRow
  onChanged?: () => void
}) {
  const a = useRunActions(sessionId, run.runId)
  const [all, setAll] = useState(false)
  const [confirm, setConfirm] = useState<'merge' | 'discard' | null>(null)
  /** 点开确认框的那个按钮:确认框贴在它旁边 */
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [changes, setChanges] = useState(false)

  const end = run.ended
  const files = end ? end.changed.files.length + (end.changed.filesTruncated ?? 0) : 0
  const worktree = end?.worktree ?? run.worktree ?? row?.worktree?.path
  // worktree 在不在只有 executor.runs 知道(丢弃不写事件):查不到这一行就不当它在
  const present = !a.discarded && !!worktree && row?.worktree?.present === true
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

  const live = run.phase !== 'ended'
  const nViol = (end?.violations?.length ?? 0) + (end?.violationsTruncated ?? 0)
  const ask = (what: 'merge' | 'discard') => (e: MouseEvent<HTMLButtonElement>) => { setAnchor(e.currentTarget); setConfirm(what) }

  return (
    <div className={`mffai-card mffai-run mffai-rcard${live ? ' live' : ''}`} id={`mffai-run-${run.runId}`} data-run={run.runId}>
      <div className="mffai-card-head mffai-rcard-h">
        <span className="mffai-rlogo"><Icon name="term" size={12} /></span>
        <span className="mffai-tool">{run.executor}</span>
        {phaseChip(run)}
        {run.readOnly && <Chip sq>只读</Chip>}
        {run.isolation && <Chip sq tone={run.isolation === 'none' ? 'bad' : 'line'}><Icon name="shield" />{label('isolation', run.isolation)}</Chip>}
        {!!run.untranslatedRules && <Chip sq tone="warn">{`规则未翻译 ${run.untranslatedRules}`}</Chip>}
        <span className="mffai-spring" />
        {end && (
          <span className="mffai-facts">
            <span><span className="mffai-k">耗时</span> <b>{fmtMs(end.ms)}</b></span>
            {end.exit !== undefined && <span>{`exit ${end.exit}`}</span>}
            {end.usage && <span>{`CLI 输入 ${end.usage.input} · 输出 ${end.usage.output}`}</span>}
          </span>
        )}
        {canStop && <button className="set-btn mffai-xs" disabled={a.busy === 'stop'} onClick={() => void a.stop()}><Icon name="pause" size={12} />停止</button>}
      </div>
      <div className="mffai-rcard-b">
        {(run.summary || nViol > 0) && (
          <div className="mffai-card-row mffai-rcard-sum">
            {run.summary && <span className="mffai-rcard-title">{visibleChars(run.summary)}</span>}
            <span className="mffai-spring" />
            {nViol > 0 && <Chip sq tone="bad">{`违规 ${nViol}`}</Chip>}
          </div>
        )}
        {end?.violations && end.violations.length > 0 && (
          <ul className="mffai-violations">
            {end.violations.map((v, i) => <li key={i}>{v}</li>)}
            {!!end.violationsTruncated && <li><Chip>{`还有 ${end.violationsTruncated} 条`}</Chip></li>}
          </ul>
        )}
        {run.progress.length > 0 && (
          <ul className="mffai-progress">
            {shown.map((p, i) => (
              <li key={p.seq} className={`mffai-progress-row k-${p.kind}${i === shown.length - 1 ? ' last' : ''}`}>
                <span className="mffai-progress-icon" aria-label={p.kind}><Icon name={ICON[p.kind] ?? 'msg2'} size={13} /></span>
                <span className="mffai-progress-text">{p.text}</span>
              </li>
            ))}
          </ul>
        )}
        {(run.progress.length > SHOWN || !!end?.droppedProgress) && (
          <div className="mffai-card-row">
            {run.progress.length > SHOWN && (
              <button className="txt-btn" onClick={() => setAll(!all)}><Icon name={all ? 'chevu' : 'chevd'} size={12} />{all ? '收起' : `全部 ${run.progress.length}`}</button>
            )}
            {!!end?.droppedProgress && <Chip>{`省略 ${end.droppedProgress} 条`}</Chip>}
          </div>
        )}
        {end && (end.reason || end.signal || merged || a.discarded) && (
          <div className="mffai-card-row mffai-run-end">
            {end.reason && <CodeChip code={end.reason} />}
            {end.signal && <CodeChip code={end.signal} />}
            {merged && <Chip tone="ok">{`已合并 ${merged.files} 个文件`}</Chip>}
            {a.discarded && <Chip>已丢弃</Chip>}
          </div>
        )}
        {end && (files > 0 || end.changed.concurrent) && (
          <div className="mffai-card-row mffai-rcard-chg">
            <span className="mffai-sec-h">改动</span>
            {files > 0 && (
              <button className="txt-btn" aria-expanded={changes} onClick={() => setChanges(!changes)}>{`${files} 个文件`}</button>
            )}
            <span className="mffai-spring" />
            {end.changed.concurrent && <Chip sq tone="warn">同时有其他改动</Chip>}
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
      </div>
      {(canMerge || canDiscard || a.failed || end?.rawLog) && (
        <div className="mffai-card-actions mffai-rcard-f">
          {canMerge && <button className="set-btn mffai-primary" disabled={!!a.busy} onClick={ask('merge')}><Icon name="merge" size={13} />合并</button>}
          {canMerge && checkout && <TargetPath path={checkout} />}
          {canDiscard && <button className="set-btn mffai-danger" disabled={!!a.busy} onClick={ask('discard')}><Icon name="trash" size={13} />丢弃</button>}
          {a.failed?.busy && <Chip tone="warn">忙</Chip>}
          {a.failed && !a.failed.busy && <span className="mffai-fail">失败</span>}
          <span className="mffai-spring" />
          {end?.rawLog && (
            <span className="mffai-rawlog">
              <code className="mffai-path" title={end.rawLog}>{end.rawLog}</code>
              <CopyButton className="mffai-copy" title={end.rawLog} text={() => end.rawLog ?? ''} />
            </span>
          )}
        </div>
      )}
      {confirm === 'merge' && (
        <Confirm title={checkout ? `合并到 ${checkout}` : '合并'} rows={[['worktree', worktree ?? ''], ['文件', String(files)]]} confirmLabel="合并" anchor={anchor}
          onCancel={() => setConfirm(null)} onConfirm={() => void act('merge')} />
      )}
      {confirm === 'discard' && (
        <Confirm title="丢弃 worktree" rows={[['路径', worktree ?? '']]} confirmLabel="丢弃" danger anchor={anchor}
          onCancel={() => setConfirm(null)} onConfirm={() => void act('discard')} />
      )}
    </div>
  )
}

// 审批卡片(08 §8.3):工具名、summary(后台给的原样,等宽、完整、当文字;看不见的字符显示成 \u{…},长串空行收成 ⋯ N 空行)、未隔离、允许 / 本会话允许(有 key 才有)/ 拒绝。
// 点了之后按钮变灰直到 approval.resolved;已决的缩成一行,via 有值时加 · Telegram。mcp 的卡片不特殊处理。
import { useRef, useState, type ReactNode } from 'react'
import { call, toCallError } from '../rpc'
import { Chip } from '../ui/Chip'
import type { ApprovalItem } from './reduce'

type Decision = 'allow' | 'allow_session' | 'deny'

function viaLabel(via: string | undefined): string {
  if (!via) return ''
  return ` · ${/^telegram(:|$)/i.test(via) ? 'Telegram' : via}`
}

/** 格式字符(双向控制、零宽、软连字符…)和行/段分隔符:显示成看得见的 \u{…},屏幕上的顺序就是要跑的顺序 */
const INVISIBLE = /[\p{Cf}\u2028\u2029]/gu
/** 连续超过两行的空行收成一行 ⋯ N 空行:后面的命令不会被挤出视野 */
const BLANKS_KEPT = 2

function escapes(line: string, key: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let n = 0
  for (const m of line.matchAll(INVISIBLE)) {
    if (m.index > last) out.push(line.slice(last, m.index))
    const cp = m[0].codePointAt(0)!.toString(16).toUpperCase()
    out.push(<span key={`${key}e${n++}`} className="mffai-esc">{`\\u{${cp}}`}</span>)
    last = m.index + m[0].length
  }
  if (last < line.length) out.push(line.slice(last))
  return out
}

export function visibleSummary(text: string): ReactNode[] {
  const lines = text.split('\n')
  const out: ReactNode[] = []
  for (let i = 0; i < lines.length; i++) {
    let j = i
    while (j < lines.length && lines[j].trim() === '') j++
    if (j - i > BLANKS_KEPT) {
      out.push(<span key={`b${i}`} className="mffai-blank">{`⋯ ${j - i} 空行`}</span>)
      if (j < lines.length) out.push('\n')
      i = j - 1
      continue
    }
    out.push(...escapes(lines[i], `l${i}`))
    if (i < lines.length - 1) out.push('\n')
  }
  return out
}

function resolvedLabel(r: NonNullable<ApprovalItem['resolved']>): string {
  const base = r.by === 'timeout' ? '超时拒绝' : r.by === 'cancel' ? '已取消' : r.decision === 'allow' ? '已允许' : '已拒绝'
  return base + viaLabel(r.via)
}

export function ApprovalCard({ approval }: { sessionId: string; approval: ApprovalItem }) {
  const [sent, setSent] = useState(false)
  const [failed, setFailed] = useState(false)
  /** 后台回 ok:false:这个审批它已经不认了(别处答过、重启后) */
  const [gone, setGone] = useState(false)
  const inflight = useRef(false)

  const respond = async (decision: Decision) => {
    if (inflight.current) return
    inflight.current = true
    setSent(true)
    setFailed(false)
    try {
      const r = await call('approval.respond', { approvalId: approval.approvalId, decision })
      if (!r.ok) setGone(true)
    } catch (e) {
      console.error('mffai approval.respond', toCallError(e))
      inflight.current = false
      setSent(false)
      setFailed(true)
    }
  }

  const done = approval.resolved ? resolvedLabel(approval.resolved) : approval.stale || gone ? '已取消' : undefined
  if (done) {
    return (
      <div className="mffai-approval mffai-approval-done" data-approval={approval.approvalId}>
        <span className="mffai-tool">{approval.tool}</span>
        <code className="mffai-summary-line" title={approval.summary}>{approval.summary}</code>
        <Chip tone={approval.resolved?.decision === 'allow' ? 'ok' : 'muted'}>{done}</Chip>
      </div>
    )
  }
  return (
    <div className="mffai-card mffai-approval" data-approval={approval.approvalId}>
      <div className="mffai-card-head">
        <span className="mffai-tool">{approval.tool}</span>
        {approval.unsandboxed && <Chip tone="bad">未隔离</Chip>}
      </div>
      <pre className="mffai-summary">{visibleSummary(approval.summary)}</pre>
      <div className="mffai-card-actions">
        <button className="set-btn mffai-primary" disabled={sent} onClick={() => void respond('allow')}>允许</button>
        {approval.key !== undefined && <button className="set-btn" disabled={sent} onClick={() => void respond('allow_session')}>本会话允许</button>}
        <button className="set-btn" disabled={sent} onClick={() => void respond('deny')}>拒绝</button>
        {failed && <span className="mffai-fail">失败</span>}
      </div>
    </div>
  )
}

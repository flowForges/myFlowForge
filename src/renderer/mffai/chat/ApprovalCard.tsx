// 审批卡片(08 §8.3):工具名、summary(后台给的原样,等宽、完整、当文字;看不见的字符显示成 \u{…},长串空行收成 ⋯ N 空行)、未隔离、允许 / 本会话允许(有 key 才有)/ 拒绝。
// 点了之后按钮变灰直到 approval.resolved;已决的缩成一行,via 有值时加 · Telegram。mcp 的卡片不特殊处理。
// 08b:待批 = 琥珀左轨卡(未隔离换红);允许 / 本会话允许在左,弹簧,拒绝在右。命令在 pre 里原样;shell 类工具的 `$ ` 提示符是 CSS 加的,不进文字。
import { useRef, useState, type ReactNode } from 'react'
import { call, toCallError } from '../rpc'
import { Chip } from '../ui/Chip'
import { Icon, type IconName } from '../shell/icons'
import { visibleChars, visibleText } from '../ui/visible'
import type { ApprovalItem } from './reduce'

type Decision = 'allow' | 'allow_session' | 'deny'

function viaLabel(via: string | undefined): string {
  if (!via) return ''
  return ` · ${/^telegram(:|$)/i.test(via) ? 'Telegram' : via}`
}

/** 连续超过两行的空行收成一行 ⋯ N 空行:后面的命令不会被挤出视野 */
const BLANKS_KEPT = 2

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
    out.push(...visibleChars(lines[i], `l${i}`))
    if (i < lines.length - 1) out.push('\n')
  }
  return out
}

function resolvedLabel(r: NonNullable<ApprovalItem['resolved']>): string {
  const base = r.by === 'timeout' ? '超时拒绝' : r.by === 'cancel' ? '已取消' : r.decision === 'allow' ? '已允许' : '已拒绝'
  return base + viaLabel(r.via)
}

/** 已决一行的图标和色调(08b):允许 ✓、拒绝 ✕、超时 钟、取消 禁 */
function doneMark(a: ApprovalItem): { icon: IconName; tone: string } {
  const r = a.resolved
  if (!r) return { icon: 'ban', tone: 'muted' }
  if (r.by === 'timeout') return { icon: 'clock', tone: 'warn' }
  if (r.by === 'cancel') return { icon: 'ban', tone: 'muted' }
  return r.decision === 'allow' ? { icon: 'check', tone: 'ok' } : { icon: 'x', tone: 'bad' }
}

/** shell 一类的工具(含 mcp 的 __bash 等):命令块前面加 `$ ` 提示符;别的工具的摘要不是命令,不加 */
const SHELL_TOOL = /(^|__)(shell|bash|sh|zsh|exec|terminal|run_command)$/i

/** pos:这张在会话全部待批里排第几(n / m,只有多于一张时显示),纯显示 */
export function ApprovalCard({ approval, pos }: { sessionId: string; approval: ApprovalItem; pos?: { n: number; m: number } }) {
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
    const mark = doneMark(approval)
    return (
      <div className="mffai-approval mffai-approval-done" data-approval={approval.approvalId}>
        <span className={`mffai-done-ic ${mark.tone}`}><Icon name={mark.icon} size={13} /></span>
        <Chip tone={approval.resolved?.decision === 'allow' ? 'ok' : 'muted'}>{done}</Chip>
        <span className="mffai-tool">{approval.tool}</span>
        <code className="mffai-summary-line" title={visibleText(approval.summary)}>{visibleSummary(approval.summary)}</code>
      </div>
    )
  }
  const unsb = !!approval.unsandboxed
  return (
    <div className={`mffai-card mffai-approval mffai-appr${unsb ? ' unsb' : ''}`} data-approval={approval.approvalId}>
      <div className="mffai-card-head mffai-appr-h">
        <span className="mffai-appr-ic"><Icon name={unsb ? 'shieldx' : 'term'} size={14} /></span>
        <span className="mffai-appr-t" title={`${approval.tool} 待审批`}><span className="mffai-tool">{approval.tool}</span> 待审批</span>
        {unsb && <Chip tone="bad"><Icon name="alert" />未隔离</Chip>}
        <span className="mffai-spring" />
        {pos && pos.m > 1 && <span className="mffai-appr-pos">{`${pos.n} / ${pos.m}`}</span>}
      </div>
      <pre className={`mffai-summary${SHELL_TOOL.test(approval.tool) ? ' mffai-sh' : ''}`}>{visibleSummary(approval.summary)}</pre>
      <div className="mffai-card-actions mffai-appr-f">
        <button className="set-btn mffai-primary" disabled={sent} onClick={() => void respond('allow')}><Icon name="check" size={13} />允许</button>
        {approval.key !== undefined && <button className="set-btn" disabled={sent} onClick={() => void respond('allow_session')}>本会话允许</button>}
        {failed && <span className="mffai-fail">失败</span>}
        <span className="mffai-spring" />
        <button className="set-btn mffai-danger" disabled={sent} onClick={() => void respond('deny')}><Icon name="x" size={13} />拒绝</button>
      </div>
    </div>
  )
}

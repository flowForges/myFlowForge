// 活动面板(08b §4.3):头部「活动」+ 待处理 N + 本轮 / 会话 + › 收起。
// 本轮 = 开着的那一轮,没有就最后一轮:待你处理(待批审批)、委派运行、本轮改动 N(数字来自快照,点了滚到那一轮的轮尾,R12)。
// 会话 = 全部轮:审批(待批整卡、已决一行,ApprovalCard 自己决定)、委派运行。卡片由 SessionPane 经 render* 给出,props 和对话流里一样(R3)。
// drawer:窄窗浮层,带遮罩;Esc、遮罩、› 关。
import { useEffect, type ReactNode } from 'react'
import { Chip } from '../ui/Chip'
import { Icon } from '../shell/icons'
import { ACT_PANEL_ID } from './ChatHeader'
import type { ApprovalItem, RunItem, SessionView, TurnView } from './reduce'

export type PanelScope = 'turn' | 'session'

export const isPending = (a: ApprovalItem): boolean => !a.resolved && !a.stale

/** 本轮:开着的那一轮,没有就最后一轮 */
export function scopeTurn(view: SessionView): TurnView | undefined {
  return (view.open && view.turns.find((t) => t.turnId === view.open!.turnId)) || view.turns.at(-1)
}

const bySeq = <T extends { seq: number }>(xs: T[]) => [...xs].sort((a, b) => a.seq - b.seq)

function Section({ label, n, children }: { label: string; n: number; children?: ReactNode }) {
  return (
    <section className="mffai-act-sec">
      <div className="mffai-act-h">{label}{' '}<span className="mffai-act-n">{n}</span></div>
      {children}
    </section>
  )
}

export function ActivityPanel({ view, scope, onScope, drawer, onClose, renderApproval, renderRun, onJumpTail }: {
  view: SessionView
  sessionId: string
  scope: PanelScope
  onScope(s: PanelScope): void
  drawer: boolean
  onClose(): void
  renderApproval(a: ApprovalItem): ReactNode
  renderRun(r: RunItem): ReactNode
  onJumpTail(turnId: string): void
}) {
  useEffect(() => {
    if (!drawer) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      // 卡片里开着的确认框先收
      if (e.target instanceof Element && e.target.closest('[role="dialog"]')) return
      onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [drawer, onClose])

  const pending = view.turns.reduce((n, t) => n + t.approvals.filter(isPending).length, 0)
  const turn = scopeTurn(view)

  let body: ReactNode
  if (scope === 'turn') {
    const approvals = bySeq(turn?.approvals.filter(isPending) ?? [])
    const runs = bySeq([...(turn?.runs.values() ?? [])])
    const changed = turn?.snapshot?.changed
    body = (
      <>
        <Section label="待你处理" n={approvals.length}>{approvals.map(renderApproval)}</Section>
        <Section label="委派运行" n={runs.length}>{runs.map(renderRun)}</Section>
        {turn && changed !== undefined && (
          <Section label="本轮改动" n={changed}>
            <button type="button" className="mffai-act-jump" onClick={() => onJumpTail(turn.turnId)}>
              {`本轮改动 ${changed}`}<Icon name="chevr" size={12} />
            </button>
          </Section>
        )}
      </>
    )
  } else {
    const approvals = view.turns.flatMap((t) => bySeq(t.approvals))
    const runs = view.turns.flatMap((t) => bySeq([...t.runs.values()]))
    body = (
      <>
        <Section label="审批" n={approvals.length}>{approvals.map(renderApproval)}</Section>
        <Section label="委派运行" n={runs.length}>{runs.map(renderRun)}</Section>
      </>
    )
  }

  return (
    <>
      {drawer && <div className="mffai-scrim" onClick={onClose} />}
      <aside id={ACT_PANEL_ID} className={`mffai-act${drawer ? ' drawer' : ''}`} aria-label="活动">
        <div className="mffai-act-head">
          <span className="mffai-act-title">活动</span>
          {pending > 0 && <Chip tone="warn">{`待处理 ${pending}`}</Chip>}
          <span className="mffai-spring" />
          <div className="mffai-seg sm" role="group" aria-label="范围">
            <button type="button" aria-pressed={scope === 'turn'} onClick={() => onScope('turn')}>本轮</button>
            <button type="button" aria-pressed={scope === 'session'} onClick={() => onScope('session')}>会话</button>
          </div>
          <button type="button" className="mffai-act-close" aria-label="收起" title="收起" onClick={onClose}><Icon name="chevr" size={14} /></button>
        </div>
        <div className="mffai-act-body">{body}</div>
      </aside>
    </>
  )
}

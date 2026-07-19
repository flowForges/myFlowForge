import { useState } from 'react'
import type { RunEvent } from '../../main/run/events'
import type { GateDecision, LaneDecision } from '../../main/run/decisions'
import type { ArtifactRef } from '../../main/orchestrator/types'
import type { DesignDocRef } from '@shared/types'
import type { FrozenRunCard } from '../views/chat/runCards'
import { Markdown } from '../views/chat/markdown'
// Reuses the wfo-act/am/arow/wfo-inp/wfo-btn classes ported straight from the deleted
// WorkflowOverlay's RunNodeGate action block (see `git show 9c9780e~1:src/renderer/components/
// WorkflowOverlay.tsx` for the ancestor markup) — same import pattern as LaunchGateCard.tsx/
// RunExecPanel.tsx, which already pull this stylesheet for the same classes.
import './workflowOverlay.css'

// P3-2: in-chat card for a single run2 inbox event (or its frozen/resolved record once the live
// event is gone — see runCards.ts's toRunCardEntries, wired in by P3-4). Outer wrapper reuses the
// `.msg-req`/`.req-head`/`.req-body`/`.req-kind`/`.req-title`/`.req-sub` family (ReqCard.tsx is the
// sibling for forge_ask cards) so this looks native inside the chat timeline, not a bolted-on panel.
export interface RunEventCardProps {
  event?: RunEvent
  frozen?: FrozenRunCard
  onGate: (eventId: string, d: GateDecision) => void
  onLane: (eventId: string, d: LaneDecision) => void
  // Opens one of the gate's full artifact files (e.g. design.md) in the app's full-screen viewer.
  // Same `DesignDocRef` shape ReqCard.tsx already uses for its docs list — so WorkspaceView's existing
  // `openDoc` handler (see WorkspaceView.tsx's `openDoc = (doc) => openBrowse(...)`) can be passed here
  // as-is, no adapter needed.
  onOpenDoc?: (doc: DesignDocRef) => void
}

// Document icon for the "打开文档" buttons — copied 1:1 from ReqCard.tsx's DOC_ICON (kept duplicated,
// not shared, matching how kindLabel above already duplicates reqKindLabel: each *Card.tsx stays
// self-contained rather than reaching into its sibling).
const DOC_ICON = '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/>'

// Bridges a run2 GateEvent's `docs` (ArtifactRef[] — see controller.ts's `store.writeArtifact`, which
// writes each stage's artifact under `<runDir>/artifacts/...` and returns an ABSOLUTE path) to the
// DesignDocRef shape `openDoc` expects ({path, cwd, name}). Unlike the old orchestrator's DesignDocRef
// (path relative to a project worktree cwd), ArtifactRef has no `cwd` — it doesn't need one, its path
// is already absolute. We still have to hand back a syntactically valid, TRUTHY cwd because:
//   - FilePreview's readers resolve via `join(cwd, file)` (see git/diff.ts): `join('/', absPath)`
//     round-trips back to the same absolute path (verified), so cwd:'/' reads the right file.
//   - previewTarget.ts's `pickPreviewCwd`/openBrowse gate the whole open on `if (target)` — cwd:'' is
//     falsy and would silently no-op the click, so '/' (truthy) is the correct default, not ''.
// `name` (required on DesignDocRef) is the artifact's file name, taken from the last path segment.
function toDesignDoc(r: ArtifactRef): DesignDocRef {
  return { path: r.path, cwd: '/', name: r.path.split('/').pop() || r.path }
}

function DocList({ docs, onOpenDoc }: { docs: ArtifactRef[]; onOpenDoc?: (doc: DesignDocRef) => void }) {
  return (
    <div className="req-docs">
      {docs.map((r, i) => {
        const d = toDesignDoc(r)
        return (
          <button key={`${i}-${d.path}`} className="req-doc" title={d.path} onClick={() => onOpenDoc?.(d)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              dangerouslySetInnerHTML={{ __html: DOC_ICON }} />
            <span className="req-doc-info">
              <span className="req-doc-name">{d.name}</span>
              <span className="req-doc-path">{d.path}</span>
            </span>
            <span className="req-doc-copy" role="button" tabIndex={0} title="复制路径"
              onClick={(e) => { e.stopPropagation(); void navigator.clipboard?.writeText(d.path) }}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); void navigator.clipboard?.writeText(d.path) } }}>复制</span>
          </button>
        )
      })}
    </div>
  )
}

// `finalize`: P4-3 — a GateEvent (or its frozen record) with `finalize: true` is the run-completion
// "收尾确认" gate (see events.ts), not an ordinary per-stage review gate; only meaningful when
// `kind === 'gate'`, so callers pass it as `undefined` for every other kind.
// 'aborted' (deferred fix P4-3): synthetic marker kind, only ever reaches this frozen-only branch
// (never live) — see FrozenRunCard's doc (chat/runCards.ts).
function kindLabel(kind: RunEvent['kind'] | 'aborted', finalize?: boolean): string {
  switch (kind) {
    case 'gate': return finalize ? '收尾确认' : '阶段评审'
    case 'auth': return '需要授权'
    case 'question': return '需要回答'
    case 'doubt': return '方案存疑'
    case 'failure': return '阶段执行失败'
    case 'aborted': return '运行已终止'
  }
}

function fmtAt(ms: number): string {
  try {
    return new Date(ms).toLocaleString()
  } catch {
    return String(ms)
  }
}

export function RunEventCard({ event, frozen, onGate, onLane, onOpenDoc }: RunEventCardProps) {
  // Local-only feedback/targetKey text collection (task brief "Before You Begin": no existing
  // mechanism to route free text into a gate/doubt decision from here, so a plain local textarea/
  // input is the simplest correct thing — mirrors LaunchGateCard's supplement textarea). Trimmed to
  // undefined when empty so callers never see a stray `feedback: ''`.
  const [feedback, setFeedback] = useState('')
  const [showJumpForm, setShowJumpForm] = useState(false)
  const [jumpTarget, setJumpTarget] = useState('')
  const [answer, setAnswer] = useState('')

  if (frozen) {
    return (
      <div className={`msg-req k-${frozen.kind} done`} data-req={frozen.id}>
        <div className="req-head">
          <span className="req-kind">{kindLabel(frozen.kind, frozen.finalize)}</span>
        </div>
        <div className="req-body">
          <div className="req-title">{frozen.title}</div>
          {frozen.body ? <div className="req-sub">{frozen.body}</div> : null}
          {frozen.kind === 'gate' && frozen.docs?.length ? <DocList docs={frozen.docs} onOpenDoc={onOpenDoc} /> : null}
          <div className="req-sub">决定：{frozen.decision}</div>
          <div className="req-sub">{fmtAt(frozen.at)}</div>
        </div>
      </div>
    )
  }

  if (!event) return null

  const fb = () => (feedback.trim() ? feedback.trim() : undefined)

  return (
    <div className={`msg-req k-${event.kind}`} data-req={event.id}>
      <div className="req-head">
        <span className="req-kind">{kindLabel(event.kind, event.kind === 'gate' ? event.finalize : undefined)}</span>
      </div>
      <div className="req-body">
        {event.kind === 'gate' && event.finalize && (
          // P4-3: run-completion "收尾确认" gate — 合并并完成 merges the run's temp branch onto every
          // participating project's target branch (mergeTempBranch); 丢弃本次 deletes it instead
          // (discardTempBranch). Both route through onGate → resolveGate, same as the ordinary gate
          // buttons below — just a different GateDecision.type ('merge'/'discard').
          <div className="wfo-act">
            {event.body ? <div className="req-plan"><Markdown text={event.body} /></div> : null}
            <div className="arow">
              <button className="wfo-btn pri" onClick={() => onGate(event.id, { type: 'merge' })}>合并并完成</button>
              <button className="wfo-btn ghost" onClick={() => onGate(event.id, { type: 'discard' })}>丢弃本次</button>
            </div>
          </div>
        )}

        {event.kind === 'gate' && !event.finalize && (
          <>
            {event.body ? <div className="req-plan"><Markdown text={event.body} /></div> : null}
            {/* 技术方案等阶段产物已落盘 —— 让用户在批准/打回前打开全文(design.md 等),而不是只看 body 摘要。 */}
            {event.docs?.length ? <DocList docs={event.docs} onOpenDoc={onOpenDoc} /> : null}
            <div className="wfo-act">
              <div className="wfo-goal">
                <textarea
                  placeholder="补充说明（可选，打回/回退时附带）"
                  value={feedback}
                  onChange={(e) => setFeedback(e.target.value)}
                  rows={2}
                />
              </div>
              {showJumpForm ? (
                <input
                  className="wfo-inp"
                  placeholder="回退目标阶段 key"
                  value={jumpTarget}
                  onChange={(e) => setJumpTarget(e.target.value)}
                />
              ) : null}
              <div className="arow">
                <button className="wfo-btn pri" onClick={() => onGate(event.id, { type: 'advance' })}>通过</button>
                <button className="wfo-btn ghost" onClick={() => onGate(event.id, { type: 'redo', feedback: fb() })}>打回本阶段</button>
                {showJumpForm ? (
                  <button
                    className="wfo-btn ghost"
                    disabled={!jumpTarget.trim()}
                    onClick={() => onGate(event.id, { type: 'jumpBack', targetKey: jumpTarget.trim(), feedback: fb() })}
                  >确认回退</button>
                ) : (
                  <button className="wfo-btn ghost" onClick={() => setShowJumpForm(true)}>回退到某阶段</button>
                )}
              </div>
            </div>
          </>
        )}

        {event.kind === 'auth' && (
          <div className="wfo-act">
            <div className="am">{event.where ? `${event.title} · ${event.where}` : event.title}</div>
            <div className="arow">
              <button className="wfo-btn pri" onClick={() => onLane(event.id, { type: 'authorize' })}>批准</button>
              <button className="wfo-btn ghost" onClick={() => onLane(event.id, { type: 'deny' })}>拒绝</button>
            </div>
          </div>
        )}

        {event.kind === 'failure' && (
          <div className="wfo-act">
            <div className="am">{event.error}（已重试 {event.attempts} 次）</div>
            <div className="arow">
              <button className="wfo-btn pri" onClick={() => onLane(event.id, { type: 'retry' })}>重跑</button>
              <button className="wfo-btn ghost" onClick={() => onLane(event.id, { type: 'skipLane' })}>跳过</button>
            </div>
          </div>
        )}

        {event.kind === 'doubt' && (
          <div className="wfo-act">
            <div className="am">{event.note}</div>
            <div className="wfo-goal">
              <textarea
                placeholder="补充说明（继续时可选附带）"
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                rows={2}
              />
            </div>
            <div className="arow">
              <button className="wfo-btn ghost" onClick={() => onLane(event.id, { type: 'jumpBack' })}>回退改方案</button>
              <button className="wfo-btn ghost" onClick={() => onLane(event.id, { type: 'dismiss' })}>驳回继续</button>
              <button className="wfo-btn pri" onClick={() => onLane(event.id, { type: 'redo', feedback: fb() })}>补充说明后继续</button>
              <button className="wfo-btn ghost" onClick={() => onLane(event.id, { type: 'abort' })}>终止运行</button>
            </div>
          </div>
        )}

        {event.kind === 'question' && (
          <div className="wfo-act">
            <div className="am">{event.title}</div>
            <div className="arow">
              <input
                className="wfo-inp"
                placeholder={event.placeholder ?? ''}
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
              />
              <button className="wfo-btn pri" onClick={() => onLane(event.id, { type: 'answer', value: answer })}>提交</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

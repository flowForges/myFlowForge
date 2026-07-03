import { useState } from 'react'
import type { PendingAction, ResolvePayload, DesignDocRef } from '@shared/types'
import { reqKindLabel, REQ_KIND_ICON } from '@shared/reqMeta'
import { Markdown } from '../views/chat/markdown'

interface ReqCardProps {
  action: PendingAction
  onResolve: (p: ResolvePayload) => void
  onOpenDoc?: (doc: DesignDocRef) => void
}

// Document icon for the "打开文档" buttons on a design gate.
const DOC_ICON = '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/>'
// .msg-req card — ported 1:1 from the prototype renderReq (confirm / input / select).
export function ReqCard({ action, onResolve, onOpenDoc }: ReqCardProps) {
  const [value, setValue] = useState('')
  const provClass = action.provider ? `p-${action.provider}` : 'p-claude'

  return (
    <div className={`msg-req k-${action.kind}`} data-req={action.id}>
      <div className="req-head">
        <span className="req-from">
          <span className={`pdot ${provClass}`} />
          <span className="who">{action.agentName}</span> 子代理
          {action.role ? <span className="role"> · {action.role}</span> : null}
        </span>
        <span className="req-kind">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            dangerouslySetInnerHTML={{ __html: REQ_KIND_ICON[action.kind] }} />
          {reqKindLabel(action.kind)}
        </span>
      </div>
      <div className="req-body">
        {action.note ? <div className="req-note">{action.note}</div> : null}
        {/* title/sub are UNTRUSTED (forge_ask question / CLI permission hook). Render as plain text — JSX auto-escapes. */}
        <div className="req-title">{action.title}</div>
        {action.sub ? <div className="req-sub">{action.sub}</div> : null}
        {/* Gate review body (e.g. the design stage's technical plan). LLM output — Markdown renders
            to React elements (no raw HTML), so it can't inject markup. */}
        {action.kind === 'confirm' && action.body ? (
          <div className="req-plan"><Markdown text={action.body} /></div>
        ) : null}
        {/* 技术方案文档已落盘 —— 引导用户在 App 内的全屏文件查看器打开(格式化 markdown、可放大)。 */}
        {action.kind === 'confirm' && action.docs?.length ? (
          <div className="req-docs">
            {action.docs.map((d, i) => (
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
            ))}
          </div>
        ) : null}
        {action.kind === 'confirm' && action.where ? (
          <div className="req-sub"><span className="req-file">{action.where}</span></div>
        ) : null}

        {action.kind === 'confirm' && (
          <div className="req-actions">
            <button className="req-ok" onClick={() => onResolve({ id: action.id, decision: 'allow' })}>允许并继续</button>
            <button className="req-no" onClick={() => onResolve({ id: action.id, decision: 'deny' })}>拒绝</button>
          </div>
        )}

        {action.kind === 'input' && (
          <div className="req-inrow">
            <input
              type="text"
              placeholder={action.placeholder ?? ''}
              value={value}
              onChange={e => setValue(e.target.value)}
            />
            <button onClick={() => onResolve({ id: action.id, decision: 'allow', value })}>提交</button>
          </div>
        )}

        {action.kind === 'select' && (
          <div className="req-opts">
            {action.options.map((o, i) => (
              <button key={`${i}-${o.t}`} className="req-opt" onClick={() => onResolve({ id: action.id, decision: 'allow', choice: i })}>
                <span className="ok-pick" />
                <span>
                  <span className="ot">{o.t}</span>
                  <span className="od">{o.d}</span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

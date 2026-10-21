import { memo, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ChatMessage } from '@shared/types'
import type { CouncilCandidate, CouncilResult } from '@shared/council'
import { Markdown } from '../markdown'
import { OpenFileCtx } from '../openFile'
import './council.css'

// 结论超过这么多行 / 字就先收起,只露开头(§6.3)。
const LONG_LINES = 12
const LONG_CHARS = 800

const COPY_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h8" /></svg>
)
const FILE_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>
)
const CHEV_ICON = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9" /></svg>
const CHECK_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><polyline points="20 6 9 17 4 12" /></svg>
)

/** 推荐的候选排第一,其余保持领导者给的顺序。 */
function orderCandidates(r: CouncilResult): CouncilCandidate[] {
  const rec = r.recommended?.name
  const i = rec ? r.candidates.findIndex(c => c.name === rec) : -1
  return i <= 0 ? r.candidates : [r.candidates[i], ...r.candidates.filter((_, j) => j !== i)]
}

/**
 * 「复制 Markdown」的内容。
 * ★没有读结果文件的 IPC,就在渲染端按同一套小节(结论 / 候选 / 推荐 / 分歧)拼出来 —— 只是结果本身,
 *  不含文件里的各轮总结和追问附录。
 */
export function councilResultMarkdown(
  topic: string | undefined, result: CouncilResult | undefined, fallback: string, chosen: string | undefined,
  seatLabel: (id: string) => string,
): string {
  const out: string[] = []
  if (topic?.trim()) out.push(`# AI 共商:${topic.trim()}`, '')
  if (!result) return [...out, fallback].join('\n').trim() + '\n'
  out.push(result.conclusion, '')
  if (result.candidates.length) {
    out.push('## 候选', '')
    for (const c of orderCandidates(result)) {
      out.push(`### ${c.name}${result.recommended?.name === c.name ? ' ★' : ''}${chosen === c.name ? ' ✓' : ''}`, '')
      if (c.points) out.push(c.points, '')
      if (c.pros) out.push(`- 优点:${c.pros}`)
      if (c.cons) out.push(`- 代价/风险:${c.cons}`)
      if (c.supporters.length) out.push(`- 支持者:${c.supporters.map(seatLabel).join('、')}`)
      for (const d of c.dissenters) out.push(`- 保留意见(${seatLabel(d.seat)}):${d.reason}`)
      out.push('')
    }
  }
  if (result.recommended) out.push('## 推荐', '', `${result.recommended.name}:${result.recommended.reason}`, '')
  if (result.disagreements.length) {
    out.push('## 未解决的分歧', '')
    for (const d of result.disagreements) out.push(`- ${seatLabel(d.seat)} · ${d.point}:${d.reason}`)
    out.push('')
  }
  return out.join('\n').replace(/\n+$/, '\n')
}

function Conclusion({ text }: { text: string }) {
  const long = text.length > LONG_CHARS || text.split('\n').length > LONG_LINES
  const [open, setOpen] = useState(false)
  return (
    <div className={`council-conclusion${long && !open ? ' clamped' : ''}`}>
      <div className="msg-body ans"><Markdown text={text} /></div>
      {long && (
        <button type="button" className="council-more" aria-expanded={open} aria-label={open ? '收起' : '展开'} onClick={() => setOpen(o => !o)}>
          {CHEV_ICON}
        </button>
      )}
    </div>
  )
}

type Props = {
  /** 领导者的最终发言(stage 'final')。 */
  final: ChatMessage
  topic?: string
  chosen?: string
  resultFile?: string
  seatLabel: (id: string) => string
  onChoose: (name: string) => void
}

function CouncilResultCardImpl({ final, topic, chosen, resultFile, seatLabel, onChoose }: Props) {
  const result = final.councilResult
  const candidates = useMemo(() => (result ? orderCandidates(result) : []), [result])
  const [tab, setTab] = useState(0)
  const [copied, setCopied] = useState(false)
  const opener = useContext(OpenFileCtx)
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(copiedTimer.current), [])
  const cur = candidates[Math.min(tab, candidates.length - 1)]

  const copy = () => {
    const md = councilResultMarkdown(topic, result, final.text, chosen, seatLabel)
    navigator.clipboard?.writeText(md).then(() => {
      setCopied(true)
      clearTimeout(copiedTimer.current)
      copiedTimer.current = setTimeout(() => setCopied(false), 1600)
    }).catch(() => { /* clipboard unavailable */ })
  }

  return (
    <div className="council-result">
      {result ? <Conclusion text={result.conclusion} /> : <Conclusion text={final.text} />}

      {candidates.length > 0 && cur && (
        <div className="council-cands">
          <div className="council-tabs" role="tablist">
            {candidates.map((c, i) => (
              <button
                key={c.name + i}
                type="button"
                role="tab"
                aria-selected={c === cur}
                data-chosen={chosen === c.name ? 'true' : undefined}
                className={c === cur ? 'on' : ''}
                onClick={() => setTab(i)}
              >
                {result?.recommended?.name === c.name && <span className="council-star">★</span>}
                {c.name}
                {chosen === c.name && <span className="council-chosen-mark" aria-hidden="true">{CHECK_ICON}</span>}
              </button>
            ))}
          </div>
          <div className="council-cand" role="tabpanel">
            {cur.points && <div className="msg-body ans"><Markdown text={cur.points} /></div>}
            {(cur.pros || cur.cons) && (
              <div className="council-pc">
                <div className="council-pros"><span className="council-pc-ico" aria-hidden="true">＋</span><Markdown text={cur.pros} /></div>
                <div className="council-cons"><span className="council-pc-ico" aria-hidden="true">－</span><Markdown text={cur.cons} /></div>
              </div>
            )}
            {(cur.supporters.length > 0 || cur.dissenters.length > 0) && (
              <div className="council-sides">
                {cur.supporters.length > 0 && (
                  <div className="council-side ok">
                    {cur.supporters.map(s => <span key={s} className="council-who">✓ {seatLabel(s)}</span>)}
                  </div>
                )}
                {cur.dissenters.length > 0 && (
                  <div className="council-side no">
                    {cur.dissenters.map((d, i) => (
                      <div key={d.seat + i} className="council-dissent"><span className="council-who">✕ {seatLabel(d.seat)}</span><span>{d.reason}</span></div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {result?.recommended?.name === cur.name && result.recommended.reason && (
              <div className="council-rec"><span className="council-star">★</span>{result.recommended.reason}</div>
            )}
            <div className="council-cand-actions">
              <button
                type="button"
                className={`council-choose${chosen === cur.name ? ' on' : ''}`}
                aria-pressed={chosen === cur.name}
                aria-label="选定"
                onClick={() => onChoose(cur.name)}
              >
                {chosen === cur.name ? CHECK_ICON : null}选定
              </button>
            </div>
          </div>
        </div>
      )}

      {result && result.disagreements.length > 0 && (
        <ul className="council-disagree">
          {result.disagreements.map((d, i) => (
            <li key={i}><span className="council-who">{seatLabel(d.seat)}</span><b>{d.point}</b><span>{d.reason}</span></li>
          ))}
        </ul>
      )}

      <div className="council-result-actions">
        <button type="button" className={`mm-copy${copied ? ' done' : ''}`} aria-label="复制 Markdown" onClick={copy}>
          {copied ? CHECK_ICON : COPY_ICON}<span className="mm-lab">复制 Markdown</span>
        </button>
        {resultFile && opener && (
          <button type="button" className="mm-copy" aria-label="打开文件" onClick={() => { void opener.open(resultFile) }}>
            {FILE_ICON}<span className="mm-lab">打开文件</span>
          </button>
        )}
      </div>
    </div>
  )
}

export const CouncilResultCard = memo(CouncilResultCardImpl)

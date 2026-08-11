import { useState } from 'react'
import type { AskAnswers, AskQuestion } from '@shared/types'
import { reqKindLabel, REQ_KIND_ICON } from '@shared/reqMeta'

interface AskQuestionCardProps {
  id: string
  questions: AskQuestion[]
  agentName: string
  provider?: string
  onResolve: (p: { id: string; decision: 'allow' | 'deny'; answers?: AskAnswers; response?: string }) => void
}

/**
 * claude 的 AskUserQuestion 门:模型在问人,而不是在申请权限。
 *
 * 之前这道门走的是普通确认卡,只剩「AskUserQuestion 请求执行 / 允许并继续 / 拒绝」—— 选项在
 * can_use_tool 的 input 里躺着却从没画出来,而「允许」并不等于回答,CLI 会拿空 answers 把工具跑完并告诉
 * 模型 "The user did not answer the questions."。这张卡把选项画成可点的按钮,并把选择经
 * ConfirmDecision 一路送回 provider(见 claudeControl.ts 的 controlAnswerLine)。
 *
 * 单选点一下即答;多选先勾再「提交」。底部永远留一个自由输入框 —— 选项都不合适时直接写,走 CLI 的
 * `response` 通道(模型看到的是「The user responded: …」)。
 *
 * 复用 ReqCard 那套 .msg-req/.req-opts/.req-opt 样式,外观与既有的选择卡一致。
 */
export function AskQuestionCard({ id, questions, agentName, provider, onResolve }: AskQuestionCardProps) {
  // 每题选中的 option label;单选题里恒为 0 或 1 个。key 是问题原文(CLI 就按原文回查)。
  const [picked, setPicked] = useState<AskAnswers>({})
  const [free, setFree] = useState('')
  const provClass = provider ? `p-${provider}` : 'p-claude'

  const multi = questions.some(q => q.multiSelect)
  // 单选且只有一题 = 点一下就该直接答完,不该再逼用户点一次「提交」。任何一题多选、或有多题要一起答,
  // 就切成「先选后提交」,否则第一次点击会把还没答的题一起送出去。
  const instant = questions.length === 1 && !multi

  const toggle = (q: AskQuestion, label: string) => {
    if (instant) { onResolve({ id, decision: 'allow', answers: { [q.question]: [label] } }); return }
    setPicked(p => {
      const cur = p[q.question] ?? []
      if (!q.multiSelect) return { ...p, [q.question]: [label] }
      return { ...p, [q.question]: cur.includes(label) ? cur.filter(l => l !== label) : [...cur, label] }
    })
  }
  const isPicked = (q: AskQuestion, label: string) => (picked[q.question] ?? []).includes(label)
  const anyPicked = Object.values(picked).some(v => v.length > 0)

  return (
    <div className="msg-req k-select" data-req={id}>
      <div className="req-head">
        <span className="req-from">
          <span className={`pdot ${provClass}`} />
          <span className="who">{agentName}</span>
        </span>
        <span className="req-kind">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            dangerouslySetInnerHTML={{ __html: REQ_KIND_ICON.select }} />
          {reqKindLabel('select')}
        </span>
      </div>
      <div className="req-body">
        {questions.map((q, qi) => (
          <div key={`${qi}-${q.question}`} className="req-q">
            {/* 问题与选项文本都是模型输出(不可信) —— 一律当纯文本渲染,JSX 自动转义。 */}
            {q.header ? <div className="req-q-header">{q.header}</div> : null}
            <div className="req-title">{q.question}</div>
            {q.multiSelect ? <div className="req-sub">可多选</div> : null}
            <div className="req-opts">
              {q.options.map((o, oi) => (
                <button
                  key={`${oi}-${o.label}`}
                  className={`req-opt${isPicked(q, o.label) ? ' picked' : ''}`}
                  aria-pressed={isPicked(q, o.label)}
                  onClick={() => toggle(q, o.label)}
                >
                  <span className="ok-pick">{isPicked(q, o.label) ? <span className="ok-dot" /> : null}</span>
                  <span>
                    <span className="ot">{o.label}</span>
                    {o.description ? <span className="od">{o.description}</span> : null}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ))}

        {/* 自由输入:选项都不合适时的出口(也是「实在点不动就打字回答」的兜底)。走 CLI 的 response 通道。 */}
        <div className="req-inrow req-opt-custom">
          <input
            type="text"
            placeholder="以上都不合适？直接输入你的回答…"
            value={free}
            onChange={e => setFree(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && (free.trim() || anyPicked)) onResolve({ id, decision: 'allow', answers: picked, response: free.trim() || undefined }) }}
          />
          <button
            disabled={!free.trim() && !anyPicked}
            onClick={() => onResolve({ id, decision: 'allow', answers: picked, response: free.trim() || undefined })}
          >提交</button>
        </div>

        <div className="req-actions">
          {/* 不回答就走人:CLI 收到 deny,模型明确知道用户跳过了,而不是干等。 */}
          <button className="req-no" onClick={() => onResolve({ id, decision: 'deny' })}>不回答</button>
        </div>
      </div>
    </div>
  )
}

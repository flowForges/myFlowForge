import { useState } from 'react'
import type { AskAnswers, AskQuestion } from '@shared/types'

interface AskQuestionPickerProps {
  questions: AskQuestion[]
  onAnswer: (p: { answers: AskAnswers; response?: string }) => void
  onSkip: () => void
  /** 「不回答」按钮的文案 —— 工作流那边整套按钮叫「拒绝」,跟随各自卡片的用词。 */
  skipLabel?: string
}

/**
 * claude AskUserQuestion 的选择器主体:问题 + 可点的选项 + 自由输入兜底。
 *
 * 只做「选什么、怎么送出去」,不带卡片外壳 —— 聊天(AskQuestionCard,.msg-req)和工作流
 * (RunEventCard 的 auth 分支,.wfo-act)两处外观不同但选择逻辑必须一模一样,所以抽在这里共用。
 *
 * 单选且只有一题 = 点一下即答完;任何一题多选、或一次问了多题,就切成「先选后提交」,否则第一次点击会把
 * 还没答的题一起送出去。底部永远留一个自由输入框(走 CLI 的 response 通道),这样即便选项渲染不合心意,
 * 用户也总有办法把话说出去。
 */
export function AskQuestionPicker({ questions, onAnswer, onSkip, skipLabel = '不回答' }: AskQuestionPickerProps) {
  // 每题选中的 option label;单选题里恒为 0 或 1 个。key 是问题原文(CLI 就按原文回查)。
  const [picked, setPicked] = useState<AskAnswers>({})
  const [free, setFree] = useState('')

  const instant = questions.length === 1 && !questions.some(q => q.multiSelect)

  const toggle = (q: AskQuestion, label: string) => {
    if (instant) { onAnswer({ answers: { [q.question]: [label] } }); return }
    setPicked(p => {
      const cur = p[q.question] ?? []
      if (!q.multiSelect) return { ...p, [q.question]: [label] }
      return { ...p, [q.question]: cur.includes(label) ? cur.filter(l => l !== label) : [...cur, label] }
    })
  }
  const isPicked = (q: AskQuestion, label: string) => (picked[q.question] ?? []).includes(label)
  const anyPicked = Object.values(picked).some(v => v.length > 0)
  const submit = () => onAnswer({ answers: picked, response: free.trim() || undefined })

  return (
    <>
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
          onKeyDown={e => { if (e.key === 'Enter' && (free.trim() || anyPicked)) submit() }}
        />
        <button disabled={!free.trim() && !anyPicked} onClick={submit}>提交</button>
      </div>

      <div className="req-actions">
        {/* 不回答就走人:CLI 收到 deny,模型明确知道用户跳过了,而不是干等。 */}
        <button className="req-no" onClick={onSkip}>{skipLabel}</button>
      </div>
    </>
  )
}

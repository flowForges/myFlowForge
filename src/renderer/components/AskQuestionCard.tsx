import type { AskAnswers, AskQuestion } from '@shared/types'
import { reqKindLabel, REQ_KIND_ICON } from '@shared/reqMeta'
import { AskQuestionPicker } from './AskQuestionPicker'

interface AskQuestionCardProps {
  id: string
  questions: AskQuestion[]
  agentName: string
  provider?: string
  onResolve: (p: { id: string; decision: 'allow' | 'deny'; answers?: AskAnswers; response?: string }) => void
}

/**
 * 聊天时间线里的 claude AskUserQuestion 门:模型在问人,而不是在申请权限。
 *
 * 之前这道门走的是普通确认卡,只剩「AskUserQuestion 请求执行 / 允许并继续 / 拒绝」—— 选项在
 * can_use_tool 的 input 里躺着却从没画出来,而「允许」并不等于回答,CLI 会拿空 answers 把工具跑完并告诉
 * 模型 "The user did not answer the questions."。这张卡把选项画成可点的按钮,并把选择经
 * ConfirmDecision 一路送回 provider(见 claudeControl.ts 的 controlAnswerLine)。
 *
 * 外壳复用 ReqCard 那套 .msg-req 样式,选择器本体与工作流的授权卡共用 AskQuestionPicker。
 */
export function AskQuestionCard({ id, questions, agentName, provider, onResolve }: AskQuestionCardProps) {
  const provClass = provider ? `p-${provider}` : 'p-claude'
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
        <AskQuestionPicker
          questions={questions}
          onAnswer={({ answers, response }) => onResolve({ id, decision: 'allow', answers, response })}
          onSkip={() => onResolve({ id, decision: 'deny' })}
        />
      </div>
    </div>
  )
}

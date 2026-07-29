import type { AgentProvider } from '../agents/types'

// Gate Q&A (工作流交互): at a review gate — especially the 技术方案设计 gate — a user sometimes types a
// QUESTION rather than a supplement or approval, e.g. "这个待澄清项到底是什么意思？我要你解释给我听". The old
// engine could only fold gate text into a `redo`, which re-ran the ENTIRE stage (10+ min) and regenerated
// an essentially identical doc — never answering. This one-shot answers the question over the ROOT
// provider using the current stage doc + the original requirement as context, WITHOUT touching the stage
// machine (no re-run). Modeled on runSummary.ts's fail-open oneShot (provider.chat + delta 累加 + timeout
// 兜底 + never throws / never writes chat history).

export function buildGateAnswerPrompt(stageName: string, doc: string, question: string, task?: string): string {
  const seed = task ? `【本次需求原文】\n${task}\n\n` : ''
  return [
    `你是 Forge 工作流的答疑助手。当前正处在「${stageName}」阶段的评审环节,用户看完下面这份产出后向你提了一个问题。`,
    '请直接、简明地回答用户的问题(中文)。**这不是让你重做这个阶段,也不要重新输出整份方案**——只回答问题本身:',
    '把用户问的那一点解释清楚(是什么意思 / 为什么这样设计 / 你的建议是什么);若涉及取舍,给出你的推荐。',
    '',
    `${seed}【当前「${stageName}」阶段产出】\n${doc}`,
    '',
    `【用户的问题】\n${question}`,
  ].join('\n')
}

export interface GateAnswerArgs {
  stageName: string
  doc: string
  question: string
  task?: string
  model: string
  cwd: string
  env: NodeJS.ProcessEnv
  // Best-effort ceiling so a hung answer never blocks the gate. Injectable for tests.
  timeoutMs?: number
  setTimer?: (fn: () => void, ms: number) => { clear: () => void }
}

let answerSeq = 0

/**
 * One-shot gate answerer. Returns the AI's answer text, or '' when the provider has no `.chat`, errors,
 * yields nothing, or exceeds timeoutMs (the caller shows a fallback and keeps the gate open). Never
 * throws and never writes to any chat history (no sessionId) — it's a pure Q&A over the given doc.
 */
export function runGateAnswer(provider: AgentProvider | undefined, args: GateAnswerArgs): Promise<string> {
  if (!provider?.chat) return Promise.resolve('')
  const prompt = buildGateAnswerPrompt(args.stageName, args.doc, args.question, args.task)
  const timeoutMs = args.timeoutMs ?? 120_000
  const setTimer = args.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); return { clear: () => clearTimeout(t) } }) // eslint-disable-line
  return new Promise<string>((resolve) => {
    let out = ''
    let settled = false
    let timer: { clear: () => void } | null = null
    const finish = () => { if (settled) return; settled = true; timer?.clear(); resolve(out.trim()) }
    timer = setTimer(finish, timeoutMs)
    try {
      const session = provider.chat!(
        { id: `gate-answer-${++answerSeq}`, prompt, model: args.model, cwd: args.cwd },
        { onSession: () => {}, onAssistantDelta: (t) => { out += t }, onThinkDelta: () => {}, onDone: finish, onError: finish },
        args.env,
      )
      session.done.then(finish, finish)
    } catch { finish() }
  })
}

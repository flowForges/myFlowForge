import type { AgentProvider } from '../agents/types'

// 归一化解释文本:折叠所有空白为单空格、去首尾、截断到 120 字(卡片上一行足矣)。
export function normalizeNote(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, 120)
}

// 一句话解释的提示词:让"主控助手"视角用不超过 40 字说明该请求在问什么、要用户关注什么。
export function buildExplainPrompt(name: string, question: string, options?: { t: string; d: string }[]): string {
  const opt = options?.length ? '\n可选项: ' + options.map(o => o.t).join(' / ') : ''
  return [
    `你是 Forge 工作流的主控助手。子代理「${name}」在执行中向用户发起了一个${options?.length ? '选择' : '输入/确认'}请求。`,
    '请用不超过 40 字的一句中文,向用户说明这个请求大概在问什么、需要用户关注什么,便于用户快速决定。',
    '不要复述原文,不要客套,只输出这一句。',
    '',
    `请求内容: ${question}${opt}`,
  ].join('\n')
}

// fire-and-forget one-shot 解释调用。照搬 summarizeWorkspace 的 oneShot:provider.chat + onAssistantDelta
// 累加 + session.done.then(finish, finish) 兜底 + fail-open。任何失败/无 chat 能力/空结果都静默不回调,
// 绝不阻塞或影响卡片本身。不写入对话历史(不传 sessionId)。
let explainSeq = 0
export function runExplain(
  provider: AgentProvider | undefined,
  args: { pendingId: string; name: string; model: string; cwd: string; question: string; options?: { t: string; d: string }[]; env: NodeJS.ProcessEnv },
  onNote: (pendingId: string, note: string) => void,
): void {
  if (!provider?.chat) return
  const prompt = buildExplainPrompt(args.name, args.question, args.options)
  let out = ''
  let settled = false
  const finish = () => {
    if (settled) return
    settled = true
    const note = normalizeNote(out)
    if (note) onNote(args.pendingId, note)
  }
  try {
    const session = provider.chat(
      { id: `explain-${++explainSeq}`, prompt, model: args.model, cwd: args.cwd },
      { onSession: () => {}, onAssistantDelta: (t) => { out += t }, onThinkDelta: () => {}, onDone: finish, onError: finish },
      args.env,
    )
    session.done.then(finish, finish)
  } catch { finish() }
}

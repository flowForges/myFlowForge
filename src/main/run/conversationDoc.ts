// ④ 对话兜底契约(2026-08-12)
//
// 执行 lane 是全新的 CLI 会话:它看不到任何聊天上下文,只吃 forge-docs/*.md(见 controller.forgeDocsDirective)
// 和一段简短需求。跑「技术方案设计」阶段时这没问题——那一步会把方案落到 forge-docs/design.md,那就是
// 跨 provider 的契约。可用户如果把方案阶段去掉、聊完直接进开发,forge-docs 是空的,之前聊的全部丢失,
// agent 只能凭一句需求猜。
//
// 兜底:这种情况下把对话本身落成一份文档,让它照样走「读整份文档」那条既有的路。
//
// 刻意**不做 LLM 蒸馏**:一来又要多跑一次模型、又是一次可能被截断的总结(正是这轮在修的毛病);二来
// 用户已经定过原则——文档是契约、读整份不蒸馏。原始对话啰嗦但完整,而且用户自己能打开看、能改。
import type { StagePlan } from './machine'

/** 相对工作区根的落盘路径。必须落在 forge-docs/ 下,否则 forgeDocsDirective 扫不到、等于没写。 */
export const CONVERSATION_DOC_REL = 'forge-docs/conversation.md'

// 文档最多这么长。取最近的部分——最新结论优先,而不是保留开头那些已被推翻的想法。
export const DOC_CHAR_CAP = 60_000

/**
 * 这次运行要不要写对话兜底文档:工作流里**没有**任何产出文档的阶段(技术方案设计/需求评估)时才写。
 * 有那种阶段就别写——它产出的才是契约,再塞一份原始对话只会稀释重点。
 */
export function needsConversationDoc(stages: Pick<StagePlan, 'producesDoc'>[]): boolean {
  return stages.length > 0 && !stages.some((s) => s.producesDoc)
}

/** 把聊天消息拼成一份人能读、agent 能读的 markdown。没有任何有效消息 → '',调用方据此不写文件。 */
export function buildConversationDoc(msgs: { who: string; text: string }[], cap = DOC_CHAR_CAP): string {
  const body = msgs
    .filter((m) => m.text?.trim())
    .map((m) => `## ${m.who === 'user' ? '用户' : '助手'}\n\n${m.text.trim()}`)
    .join('\n\n')
  if (!body) return ''
  const clipped = body.length > cap ? `（前文过长已省略，以下是最近的对话）\n\n${body.slice(-cap)}` : body
  return `# 本次需求的对话记录（原文，未经提炼）\n\n`
    + `这是用户与 AI 在启动本次工作流之前的完整讨论，**不是**已经定稿的技术方案。\n`
    + `本次工作流没有「技术方案设计」这一步，所以这份对话就是你能拿到的全部背景：请据此理解用户到底要什么、`
    + `有哪些已经达成的结论和明确排除的做法（以最新的结论为准，中途被推翻的想法不要再捡回来）。\n`
    + `有拿不准的地方，用 forge_ask 问用户，不要自行发挥。\n\n---\n\n${clipped}\n`
}

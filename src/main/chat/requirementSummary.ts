// 启动门里那段「原始需求」:把整段对话提炼成一句可执行的需求,作为工作流的背景摘要。
//
// 两条硬教训写在这里(2026-08-12 用户实测「总结是截断的」):
//  1. 超时/出错时**绝不能**把已经流出来的半截当成果返回。原意就是「失败就回退到原始对话摘录」,可只要流
//     出过一个字,调用方的 `s && s.trim() ? s : rawSeed` 就当成功了 —— 回退路径实际上只在一个字都没出来
//     时才生效,而那恰恰最少见。于是用户拿到一句被切断的需求,还被当作「以此为准」发给每个阶段的 agent。
//  2. 喂进去的对话必须有上限。这里原来把**整个会话**塞进 prompt(实测单个会话文件到过 1.2 MB),聊得越多
//     越慢、越容易撞上超时 —— 越是「聊了很多轮」这种最需要总结的场景,越总结不出来。
//
// 纯逻辑 + 注入依赖,便于单测(不必真起 CLI)。
export interface SummaryDeps {
  // 跑一次一次性对话。**只有正常跑完**才给出文本;超时/出错一律给 null,由本模块收敛成「没有总结」。
  summarize: (prompt: string) => Promise<string | null>
}

/** 参与总结的一条消息(who 已归一化成 用户/助手)。 */
export interface SummaryMessage { who: string; text: string }

// 对话取最近这么多字符。够覆盖十几轮实质讨论,又不至于让 prompt 大到跑不完。
export const TRANSCRIPT_CHAR_CAP = 24_000

/**
 * 把消息拼成喂给模型的对话文本,并从**尾部**截断到上限 —— 保留最近的讨论(最新结论优先),而不是保留
 * 开头那些已经被推翻的想法。真发生截断时显式标注,免得模型把半截当全貌。
 */
export function buildTranscript(msgs: SummaryMessage[], cap = TRANSCRIPT_CHAR_CAP): string {
  const full = msgs.map((m) => `${m.who}: ${m.text}`).join('\n')
  if (full.length <= cap) return full
  return `（前文过长已省略，以下是最近的对话）\n${full.slice(-cap)}`
}

export function buildSummaryPrompt(transcript: string): string {
  return [
    '下面是用户与 AI 的完整对话,他们在讨论接下来要开发的一个需求。请把这段对话提炼成一段清晰、准确、可直接执行的中文需求描述,作为即将启动的开发工作流的「需求原文」。',
    '要求:抓住用户真正想实现的目标与关键约束/决策;把多轮讨论里达成的最终结论合并进来(以最新结论为准,忽略中途被推翻的想法);去掉寒暄和过程细节;直接输出需求正文,控制在几句话内,不要加「以下是」之类的前缀。',
    '对话:', transcript,
  ].join('\n')
}

/**
 * 生成需求总结。拿不到完整结果就返回 '' —— 调用方据此回退到原始对话摘录(啰嗦但完整,好过半句)。
 * 空对话同样返回 '',连模型都不必打搅。
 */
export async function summarizeRequirement(msgs: SummaryMessage[], deps: SummaryDeps): Promise<string> {
  const real = msgs.filter((m) => m.text?.trim())
  if (!real.length) return ''
  const out = await deps.summarize(buildSummaryPrompt(buildTranscript(real)))
  return (out ?? '').trim()
}

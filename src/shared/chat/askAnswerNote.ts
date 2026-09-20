import type { AskQuestion } from '../types'

/**
 * 把「代理问了什么、你选了什么」写成一条留在对话里的记录。
 *
 * ★★★为什么必须留:答完之后卡片就消失了,而**对话里一个字都没有** —— 问题没了、选择也没了。
 *  用户原话:「我选择后,这个输出内容里,没有我之前的选择,感觉中间中断了似的,感觉很不好」。
 *  后面所有输出都建立在这个选择上,读的人却看不到前提,那段对话就变成了无源之水。
 *
 * ★★这和「权限门自己答的不留痕」**不矛盾**,两者是不同的东西:
 *  · 权限门问的是「准不准做这件事」—— 答案是一次授权,它的痕迹该落在**那次调用的工具卡**上;
 *  · 选择门问的是「你想要哪个」—— 答案是**内容**,是对话的一部分,后面的每一句都以它为前提。
 *  把两者按同一条规矩处理,才是之前漏掉这条的原因。
 *
 * ★零 import(除了类型),纯字符串拼接 —— 能在 node 下直接测。
 */
export function askAnswerNote(
  questions: readonly AskQuestion[] | undefined,
  answers: Record<string, string[]> | undefined,
  response: string | undefined,
): string | null {
  const picked: string[] = []
  for (const q of questions ?? []) {
    const chosen = answers?.[q.question]
    if (!chosen?.length) continue
    // ★问题原文一起写进去。只写答案的话,过几天回头看会看到一句没头没尾的「全都不要,纯静态就行」。
    picked.push(`**${q.question}**\n${chosen.map((c) => `- ${c}`).join('\n')}`)
  }
  // 「以上都不合适,直接输入」那一格。★它和选项**可以同时有**,所以是追加不是二选一。
  const free = response?.trim()
  if (free) picked.push(`**你补充的**\n${free}`)
  if (!picked.length) return null
  return `📝 你的选择\n\n${picked.join('\n\n')}`
}

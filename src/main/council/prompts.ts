import type { CouncilConfig, CouncilSeat } from '@shared/council'
import type { Utterance } from './transcript'

/**
 * 通用提示词:只描述讨论规则(独立作答 / 回应他人 / 总结不表态 / 输出结构),
 * ★不假设议题类型 —— 议题可能是方案、代码审查、共同撰写,内容由议题自己决定。
 */

const READONLY_RULE = '你处于只读讨论环境:不要修改、创建或删除任何文件,不要执行会改变状态的命令;需要产出的文本或代码直接写在回答里。'

export const COUNCIL_RESULT_FENCE = '```forge:council-result'

export function labelLine(u: Utterance): string {
  return `【${u.label}】\n${u.text}`
}

function joinItems(items: Utterance[]): string {
  return items.map(labelLine).join('\n\n')
}

function topicBlock(cfg: CouncilConfig, materialsText: string): string {
  const parts = [`## 议题\n${cfg.topic}`]
  if (materialsText.trim()) parts.push(`## 参考材料\n${materialsText}`)
  return parts.join('\n\n')
}

export function answerPrompt(cfg: CouncilConfig, materialsText: string, seat: CouncilSeat): string {
  // seat 仅用于调用方区分会话;第 1 轮提示词里不出现任何席位名,避免互相锚定
  void seat
  return [
    '你是一场多方讨论中的一位讨论者。多位讨论者各自独立地回答同一个议题,最后会汇总。',
    topicBlock(cfg, materialsText),
    '## 本轮要求',
    '- 现在是第 1 轮:请独立给出你自己的完整答案,你看不到其他讨论者的内容,也不要猜测他们会怎么说。',
    '- 议题是什么就回答什么(可能是方案、问题清单、一段文本或代码等),按议题本身的需要组织内容。',
    '- 观点要明确,有依据;不确定的地方直接说明。',
    READONLY_RULE,
  ].join('\n\n')
}

export function critiquePrompt(
  cfg: CouncilConfig, seat: CouncilSeat, round: number, summary: Utterance | undefined,
  delta: Utterance[], resumed: boolean, materialsText: string,
): string {
  void seat
  // ★§5.1:第 2 轮起只看「上一轮总结 + 本轮前面的发言 + 插话」。总结由 summary 参数单独给(delta 里的去掉,免得出现两次),
  //  更早轮次的发言已被总结代表,丢掉;插话不受轮次限制,必须保留。
  delta = delta.filter(u => u.stage !== 'summary' && (u.round >= round || u.stage === 'interject'))
  const parts: string[] = []
  // ★没有原生续会话的席位(如 ACP)每次是新会话,必须把议题和材料再带一遍
  if (resumed) parts.push(`现在是第 ${round} 轮讨论。`)
  else parts.push('你是一场多方讨论中的一位讨论者。', topicBlock(cfg, materialsText), `现在是第 ${round} 轮讨论。`)
  if (summary) parts.push(`## 上一轮领导者总结\n${labelLine(summary)}`)
  if (delta.length) parts.push(`## 你还没看过的发言(含用户插话)\n${joinItems(delta)}`)
  parts.push([
    '## 本轮要求',
    '- 回应其他讨论者的观点,并在必要时修订你自己的答案。',
    '- 你必须至少指出一个具体的问题或风险;如果你认为完全同意,必须明确论证为什么完全同意,不能只是附和。',
    '- 不要为了达成一致而放弃你认为正确的立场;有分歧就直说原因。',
    '- 给出修订后的完整立场(或明确说明沿用原答案)。',
    READONLY_RULE,
  ].join('\n'))
  return parts.join('\n\n')
}

export function summaryPrompt(cfg: CouncilConfig, round: number, roundItems: Utterance[]): string {
  return [
    `你是本场讨论的领导者。下面是议题和第 ${round} 轮各讨论者的发言,请做本轮总结。`,
    `## 议题\n${cfg.topic}`,
    `## 第 ${round} 轮发言\n${joinItems(roundItems)}`,
    [
      '## 要求',
      '- 只总结,不表态:不加入自己的观点,不评判谁对谁错,不给出你自己的答案。',
      '- 内容包括:有几种思路/结论、各自的要点和提出者、已经一致的地方、存在分歧的地方及分歧点。',
      '- 保持中立、简洁,忠实于原话,不要补充发言里没有的内容。',
      READONLY_RULE,
    ].join('\n'),
  ].join('\n\n')
}

export function consensusDraftPrompt(cfg: CouncilConfig, round: number, roundItems: Utterance[]): string {
  return [
    `你是本场讨论的领导者。下面是议题和第 ${round} 轮各讨论者的发言,请整理一份「目前各方的共同点」草稿。`,
    `## 议题\n${cfg.topic}`,
    `## 第 ${round} 轮发言\n${joinItems(roundItems)}`,
    [
      '## 要求',
      '- 把多数讨论者已经认可的内容中立地合并成一份草稿;只收录已被多数认可的点,有争议的点不要收。',
      '- 不表态,不加入自己的观点,不替讨论者做取舍或新增结论。',
      '- 只输出草稿正文,不要加开场白。',
      READONLY_RULE,
    ].join('\n'),
  ].join('\n\n')
}

export function consensusVotePrompt(seat: CouncilSeat, draft: string): string {
  void seat
  return [
    '下面是领导者整理的「目前各方的共同点」草稿。请判断你是否同意它可以作为共识。',
    `## 草稿\n${draft}`,
    [
      '## 回复格式',
      '- 第一个词必须是「同意」或「不同意」,后面跟一句理由(一句话)。',
      '- 只有在草稿没有违背你的立场、也没有遗漏你认为关键的点时才回复「同意」。',
      '- 不要输出其他内容。',
      READONLY_RULE,
    ].join('\n'),
  ].join('\n\n')
}

export function finalPrompt(cfg: CouncilConfig, summaries: Utterance[], lastRound: Utterance[], unresolved: string[]): string {
  const parts = [
    '你是本场讨论的领导者。讨论结束,请基于全部讨论输出最终的「共识结果」。',
    `## 议题\n${cfg.topic}`,
  ]
  if (summaries.length) parts.push(`## 各轮总结\n${joinItems(summaries)}`)
  if (lastRound.length) parts.push(`## 最后一轮发言\n${joinItems(lastRound)}`)
  if (unresolved.length) parts.push(`## 未能达成共识的点\n${unresolved.map(x => `- ${x}`).join('\n')}\n这些点必须写进 disagreements。`)
  parts.push([
    '## 输出要求',
    '- 先用 Markdown 写出结果:结论(讨论得出的主要产出,形式由议题决定)、候选(如有几种都站得住的做法)、推荐及理由、未解决的分歧。',
    '- 忠实汇总讨论内容,折中各方意见;不要引入讨论中没出现过的新观点。',
    '- 候选最多 4 个,没有多种做法时 candidates 为空数组;没有推荐时省略 recommended;没有分歧时 disagreements 为空数组。',
    '- 回答的最后必须输出一个围栏代码块(围栏首行必须恰好是下面的标记),块内是 JSON,结构如下:',
    COUNCIL_RESULT_FENCE,
    `{
  "conclusion": "Markdown 字符串:主要产出",
  "candidates": [
    {
      "name": "候选名称",
      "points": "要点",
      "pros": "优点",
      "cons": "代价/风险",
      "supporters": ["支持者的名字"],
      "dissenters": [{ "seat": "保留意见者的名字", "reason": "理由" }]
    }
  ],
  "recommended": { "name": "推荐的候选名称", "reason": "推荐理由" },
  "disagreements": [{ "seat": "谁", "point": "在什么点上", "reason": "为什么不同意" }]
}`,
    '```',
    '- 围栏之后不要再输出任何内容。supporters / seat 使用讨论者的名字(如 Codex · 6.1)。',
    READONLY_RULE,
  ].join('\n'))
  return parts.join('\n\n')
}

export function followupPrompt(question: string, delta: Utterance[]): string {
  const parts = ['讨论已经结束,用户有一个追问,请直接回答。']
  if (delta.length) parts.push(`## 你还没看过的内容\n${joinItems(delta)}`)
  parts.push(`## 追问\n${question}`, READONLY_RULE)
  return parts.join('\n\n')
}

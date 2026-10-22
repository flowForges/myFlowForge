import type { CouncilCandidate, CouncilResult, CouncilTag } from '../../../src/shared/council'

/**
 * AI 共商在手机对话流里的分组和区块里用到的纯逻辑。
 *
 * ★规则**照抄电脑端** `src/renderer/views/chat/timeline.ts`(分组)和 `council/CouncilBlock.tsx`(分段 / 标题行):
 *  同一场共商在两块屏幕上长得不一样,读起来就是「手机上少了一段」。改规则两边一起改。
 * ★这个文件只 import 类型,好在 node 环境下单测(同 `providerSwitch.ts`)。
 */

type Tagged = { id: string; who: 'user' | 'ai'; council?: CouncilTag }

export type CouncilGroup<M> = { kind: 'council'; id: string; messages: M[] }

export function isCouncilGroup<M>(e: M | CouncilGroup<M>): e is CouncilGroup<M> {
  return (e as CouncilGroup<M>).kind === 'council'
}

/**
 * 流式事件(assistant-delta / think-delta / assistant-replace)带的 council 标记落到消息上。
 * ★同电脑端 useChat 的 `withCouncil`:assistant-start 丢了或晚到时,消息由 delta 新建 —— 不补标记的话
 *  这条发言整段画进普通对话,直到 done 才跳回区块。已有的标记不覆盖。
 */
export function withCouncil<M extends { council?: CouncilTag }>(m: M, council?: CouncilTag): M {
  return council && !m.council ? { ...m, council } : m
}

/**
 * 同一场共商(council.id 相同)的全部消息收成一个区块,落在它第一条消息的位置(§6.4)。
 * ★之后才到的追问也归进这个区块,不在普通对话里另起一段。
 */
export function groupCouncil<M extends Tagged>(msgs: M[]): (M | CouncilGroup<M>)[] {
  const out: (M | CouncilGroup<M>)[] = []
  const blocks = new Map<string, CouncilGroup<M>>()
  for (const m of msgs) {
    const cid = m.council?.id
    if (!cid) {
      out.push(m)
      continue
    }
    const b = blocks.get(cid)
    if (b) b.messages.push(m)
    else {
      const g: CouncilGroup<M> = { kind: 'council', id: cid, messages: [m] }
      blocks.set(cid, g)
      out.push(g)
    }
  }
  return out
}

/** 区块内分段:议题、各轮(按轮次升序)、领导者最终发言、追问。 */
export function splitCouncil<M extends Tagged>(messages: M[]): {
  topic?: M
  rounds: [number, M[]][]
  final?: M
  followups: M[]
} {
  // ★追问在最终结果之后:第一条追问起的全部消息都归「追问」段,不混进最后一轮
  const fu = messages.findIndex((m) => m.council?.stage === 'followup')
  const main = fu < 0 ? messages : messages.slice(0, fu)
  const topic = main.find((m) => m.council?.stage === 'topic')
  const finals = main.filter((m) => m.council?.stage === 'final')
  const final = finals[finals.length - 1]
  const rounds = new Map<number, M[]>()
  for (const m of main) {
    if (m === topic || m === final) continue
    const r = m.council?.round ?? 1
    rounds.set(r, [...(rounds.get(r) ?? []), m])
  }
  return {
    topic,
    rounds: [...rounds.entries()].sort((a, b) => a[0] - b[0]),
    final,
    followups: fu < 0 ? [] : messages.slice(fu),
  }
}

const chars = (s: string, n: number) => Array.from(s.trim()).slice(0, n).join('')

/** 「AI 共商 · 议题前 20 字 · N 方 · R 轮 · M 分钟」 */
export function councilHeader(a: { topic: string; seats: number; rounds: number; elapsedMs: number }): string {
  const min = a.elapsedMs > 0 ? Math.max(1, Math.round(a.elapsedMs / 60_000)) : 0
  return `AI 共商 · ${chars(a.topic, 20)} · ${a.seats} 方 · ${a.rounds} 轮 · ${min} 分钟`
}

const pad = (n: number) => String(n).padStart(2, '0')
export function mmss(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`
}

export const isLeaderSeat = (seat?: string) => !!seat && seat.startsWith('leader:')

/** 和主进程 parseVote 同一判法:先判「不同意」(它包含「同意」)。 */
export function voteOf(text: string): 'agree' | 'disagree' | 'unknown' {
  const head = text.replace(/^[\s*_#>`~\-"'“「【[(（]+/, '')
  if (head.startsWith('不同意')) return 'disagree'
  if (head.startsWith('同意')) return 'agree'
  return 'unknown'
}

/** 推荐的候选排第一,其余保持领导者给的顺序。 */
export function orderCandidates(r: CouncilResult): CouncilCandidate[] {
  const rec = r.recommended?.name
  const i = rec ? r.candidates.findIndex((c) => c.name === rec) : -1
  return i <= 0 ? r.candidates : [r.candidates[i], ...r.candidates.filter((_, j) => j !== i)]
}

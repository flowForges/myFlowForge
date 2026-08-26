/**
 * 一个会话里「这一条是换了代理之后的第一条」—— 该在它**前面**插一条换代理提示。
 *
 * ★规则**照抄电脑端** `src/renderer/views/chat/timeline.ts` 的 `messageEntries`
 *  (那边把它和时间线归并混在一起,手机端只要这一小块,所以是重写一遍而不是共用一份文件)。
 *  两处漂移的表现是「同一个会话在电脑上有分割线、在手机上没有」,所以规则改动必须两边一起改。
 *
 * ★★**粘滞**:没带 `provider` 的 ai 消息(2026-07 之前的老消息、运行时的「系统」note、
 *  还在流式吐字的占位)跳过,但**不清空**已知的上一个 provider。清空的话,一条无 provider 的
 *  消息夹在 codex 末条与切换总结之间时,本该出现的提示会**消失** —— 电脑端「切模型丢分割线」
 *  那个 bug 的根因就是这个。
 *
 * ★这个文件刻意不 import 任何东西,好在 node 环境下单测(同 `sessionStatus.ts` / `timeSep.ts`)。
 */
export type Switch = { from: string; to: string }

export function providerSwitches(
  msgs: { id: string; who: 'user' | 'ai'; provider?: string }[],
): Map<string, Switch> {
  const out = new Map<string, Switch>()
  let prev: string | undefined
  for (const m of msgs) {
    if (m.who !== 'ai' || !m.provider) continue
    if (prev && m.provider !== prev) out.set(m.id, { from: prev, to: m.provider })
    prev = m.provider
  }
  return out
}

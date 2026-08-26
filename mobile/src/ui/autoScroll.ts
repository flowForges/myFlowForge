/**
 * 「这一次该不该落到底、要不要带动画」。
 *
 * ★为什么要一个状态机而不是一行 `scrollToEnd({animated:true})`:
 *  真机验收当场报的「进会话时历史哗哗刷一遍才落到最后一条」就是那一行。`animated: true`
 *  对**每一次**消息数变化都生效,而进屏那一次是 0 → N —— RN 真的会把整个内容高度 animate
 *  一遍,人看到的是历史从头滚到尾。第一次必须瞬间到位。
 *
 * ★这个文件刻意**不 import 任何东西**(和 `sessionStatus.ts` 同一个理由):它只吃一个数字,
 *  所以能在 node 环境里单测 —— vitest 的 mobile project 跑不了 import react-native 的文件。
 *
 * `armed` = 「下一次有消息时要瞬间到位」。换会话时 `useChat` 会把 msgs 清回 0
 * (见 `useChat.ts` 的「换会话就清空」),这里据此重新武装 —— 否则第二次进别的会话
 * 又会哗哗刷一遍。
 */
export type AutoScrollState = {
  /** 下一次落底要不要瞬间到位(true = 还没落过底) */
  armed: boolean
  /** 上一次看到的消息条数。没变就不重复滚。 */
  count: number
}

export const initialAutoScroll = (): AutoScrollState => ({ armed: true, count: 0 })

export function nextScroll(
  s: AutoScrollState,
  count: number,
): { state: AutoScrollState; scroll: false | { animated: boolean } } {
  // 空了 = 换会话(或者还没拉到历史)。重新武装,并且不滚 —— 空会话滚一下只会闪一下。
  if (count === 0) return { state: { armed: true, count: 0 }, scroll: false }
  // 数量没变:可能只是别的 state 触发的重渲染。滚了会把正在往上翻历史的人拽回底部。
  if (count === s.count) return { state: s, scroll: false }
  return { state: { armed: false, count }, scroll: { animated: !s.armed } }
}

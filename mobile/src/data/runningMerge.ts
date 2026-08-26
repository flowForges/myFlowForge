/**
 * 「哪些会话在跑」的合并规则,从 `useRunning.ts` 里拆出来的纯函数。
 *
 * ★这个文件刻意**不 import 任何东西**。它只吃普通对象/数组,所以能在 node 环境里单测
 *  (vitest 的 mobile project 跑不了 import react-native 的文件,详见 `sessionStatus.ts` 的同一句话)。
 *
 * 两条规则配对着看:
 * - `mergeSnapshot`(快照路径)只在**这一桶还没有实时数据**时才写 —— 已经有实时数据
 *   说明事件比快照先到,那份更新,不能被旧快照盖回去。
 * - `applyEvent`(事件路径)整桶替换 —— 事件本身就是最新状态,不需要合并判断。
 */

export type RunningByWs = Record<string, string[]>

/**
 * 「哪些会话在跑」这个扁平集合的 key。
 *
 * ★**必须带上工作区**,不能拿裸 sessionId 当 key。会话 id 是 `s-${Date.now()}-${++seq}`
 *  (`src/main/chat/sessionStore.ts`),`seq` 是**进程级**的、每次开 app 从头数 ——
 *  所以两个不同工作区、在两次运行里同一毫秒建出来的会话完全可能拿到同一个 id。
 *  撞了的症状是某条毫不相干的会话上亮起「⚡ 执行中」,而且不会有任何报错。
 *
 * 分隔符用 NUL(`\0`):空格、逗号、冒号都是 POSIX 路径里的合法字符,拿它们做分隔
 * 会让两个不同的 (工作区, 会话) 拼出同一个 key。`app/index.tsx` 的气泡 key 用的是同一个理由。
 */
export function runningKey(wsPath: string, sessionId: string): string {
  return `${wsPath}\0${sessionId}`
}

/**
 * 快照落地。`wsPath` 已经在 `prev` 里(哪怕值是空数组)就原样返回 `prev`——
 * 必须是**同一个对象**,不能是内容相同的新对象:调用方拿它当 React state,
 * identity 不变才不会触发无谓的重渲染/重算。
 */
export function mergeSnapshot(prev: RunningByWs, wsPath: string, ids: string[]): RunningByWs {
  if (wsPath in prev) return prev
  return { ...prev, [wsPath]: ids }
}

/** 实时事件落地。事件就是最新状态,直接整桶替换,不看这一桶之前有没有数据。 */
export function applyEvent(prev: RunningByWs, wsPath: string, ids: string[]): RunningByWs {
  return { ...prev, [wsPath]: ids }
}

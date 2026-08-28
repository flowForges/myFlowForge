/**
 * 「这条会话能不能删」——**唯一**的判据。
 *
 * ★★为什么必须有它:服务端的 `closeSession`(src/main/chat/sessionStore.ts:99)在
 *  「只剩最后一条可写会话」时**原样返回、什么都不做,也不报错**。
 *  UI 上不拦的话,左滑会露出一颗红色的「删除」,按下去屏幕一动不动 ——
 *  这套代码已经在别处栽过好几次「点了没反应」,而这一次连服务端都不会告诉你为什么。
 *
 * ★零 RN import,能在 node 那套 vitest 里被直接测。
 */

export type CanDelete = { ok: true } | { ok: false; why: string }

/** 只取判据要用的那两个字段(不 import `ChatSession`:它那条链上挂着一堆别的东西)。 */
export type SessionLite = { id: string; readonly?: true }

/**
 * 「只剩最后一条,删不掉」的**唯一**措辞。
 *
 * ★★别处也要用这句话,原样引用,不要另编一句意思相同的话:按下删除之前 `sessionCanDelete`
 *  已经拦过一次,但还有一条更窄的竞态缝——两个客户端连着同一台机器,另一端刚把这行的
 *  兄弟会话删掉,这一端的「删除」格还没来得及消失。真正调用 `session:close` 之后,
 *  服务端如果还是原样返回(这条 id 仍在响应里),唯一诚实、也是唯一可能的解释就是这句话。
 */
export const LAST_SESSION_WHY = '这是这个工作区里最后一条会话,删不掉。先新建一条,再回来删它。'

export function sessionCanDelete(sessions: readonly SessionLite[], sessionId: string): CanDelete {
  const target = sessions.find((s) => s.id === sessionId)
  if (!target) return { ok: false, why: '找不到这条会话,刷新一下再试。' }
  // ★只读(导入来的)会话走的是服务端另一条路:记住这次关闭(dismissedImported),不受数量限制。
  if (target.readonly) return { ok: true }
  const writable = sessions.filter((s) => !s.readonly)
  if (writable.length <= 1) {
    // ★必须是一句**能照着做**的话。「操作失败」等于什么都没说。
    return { ok: false, why: LAST_SESSION_WHY }
  }
  return { ok: true }
}

/**
 * `session:close` 打过去、服务端**响应回来之后**,这条会话到底删没删。
 *
 * ★★这不是 `sessionCanDelete` 的活。`sessionCanDelete` 判的是**按下之前**那一刻的快照——
 *  真正的 `invoke` 打过去之间还有一条更窄的竞态缝:两个客户端连着同一台机器,这行打开着
 *  的时候,另一端刚把它的兄弟会话删掉,这一端的「删除」格还没来得及消失。`sessionCanDelete`
 *  管不到这条缝,真相只能从服务端的响应里读——传去的这条 id 还在返回的 `sessions` 里,
 *  就是没删掉(服务端的 `closeSession` 在拒绝时原样返回,不报错,原因见 `LAST_SESSION_WHY`)。
 */
export function sessionCloseWasRefused(sessionsAfter: readonly SessionLite[], sessionId: string): boolean {
  return sessionsAfter.some((s) => s.id === sessionId)
}

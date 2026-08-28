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

export function sessionCanDelete(sessions: readonly SessionLite[], sessionId: string): CanDelete {
  const target = sessions.find((s) => s.id === sessionId)
  if (!target) return { ok: false, why: '找不到这条会话,刷新一下再试。' }
  // ★只读(导入来的)会话走的是服务端另一条路:记住这次关闭(dismissedImported),不受数量限制。
  if (target.readonly) return { ok: true }
  const writable = sessions.filter((s) => !s.readonly)
  if (writable.length <= 1) {
    return {
      ok: false,
      // ★必须是一句**能照着做**的话。「操作失败」等于什么都没说。
      why: '这是这个工作区里最后一条会话,删不掉。先新建一条,再回来删它。',
    }
  }
  return { ok: true }
}

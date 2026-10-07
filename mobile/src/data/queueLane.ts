/**
 * 这个会话里「排着队、还没开跑」的那几条。
 *
 * ★★为什么要有(2026-10-07):执行中能打字、能点发送了,主机那边也确实排进了队列 —— 但手机上
 *  **什么都看不见**:输入框清空了,消息流里没有,只能干等这一轮跑完它才冒出来。人会以为没发出去,
 *  再发一遍,结果排了两条。数据其实一直在 `chat:queue-event` 里(电脑端「队列中 N 条指令」那一条
 *  画的就是它),手机只拿它算了 busy,把 `queue` 扔了。
 * ★队列事件是**整个工作区**的广播,里面混着同一工作区别的会话排的 —— 必须按 sessionId 筛,
 *  否则在 A 会话里会看到 B 会话排的话(电脑端 useChat 同样这么筛)。
 * ★老主机 / 演示连接回的东西可能没有 `queue`(demo 回的是 `{ queued: 0 }`):当空队列处理,不报错。
 */
export type QueuedItem = { id: string; text: string; source: string }

export function queuedFor(evt: unknown, sessionId: string | null): QueuedItem[] {
  if (!sessionId || !evt || typeof evt !== 'object') return []
  const q = (evt as { queue?: unknown }).queue
  if (!Array.isArray(q)) return []
  return q
    .filter((t): t is { id: string; text: string; source?: string; sessionId: string } =>
      !!t && typeof t === 'object' && (t as { sessionId?: unknown }).sessionId === sessionId && typeof (t as { id?: unknown }).id === 'string')
    .map((t) => ({ id: t.id, text: String(t.text ?? ''), source: t.source ?? '' }))
}

/** 「来自哪」那个小标签:自己(手机)发的不标,只标从别处排进来的(电脑上敲的叫「你」,机器人叫「飞书」…)。 */
export function queuedSourceLabel(source: string): string | null {
  if (!source || source === '手机') return null
  return source === '你' ? '来自电脑' : `来自${source}`
}

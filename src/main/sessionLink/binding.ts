import { open, stat } from 'node:fs/promises'
import { readBinding, readMessages, writeBinding, type ExtSyncCursor } from '../chat/chatStore'
import { readExternal } from './index'
import { locateExternal } from './locate'
import { isOwnTurnLive, liveTurnSessions } from './ownTurns'
import type { ExtProvider, ExtRead } from './types'

// 绑定 ↔ 外部记录文件的小工具:找文件(带缓存)、首次定位、记录「我方写者安静下来」。都不抛。

export interface BindingDeps { roots?: Record<ExtProvider, string>; now?: () => number }

const LINKED = new Set<string>(['codex', 'claude', 'qoder'])
/** chat-session.json 的 agent 键 → 能和官方 App 互通的 provider;其它家 undefined。 */
export const asExtProvider = (agent: string): ExtProvider | undefined => (LINKED.has(agent) ? agent as ExtProvider : undefined)

/** 找不到外部记录的 (agent, resumeId) 记一阵,别让每次打开会话都去扫一遍目录。 */
export const MISS_TTL_MS = 10 * 60_000
const misses = new Map<string, number>()   // `${agent}\0${resumeId}` → 到这个时刻之前不再找

/**
 * 绑定的外部记录文件:缓存的 extFile 还在就用,否则重新找并缓存。没有绑定 / 找不到 → undefined。
 * 找不到的结果记 MISS_TTL_MS;fresh = 不信这条记录(我方一轮刚写完,文件一定在)。
 */
export async function resolveBindingFile(ws: string, sid: string, agent: string, deps: BindingDeps & { fresh?: boolean } = {}): Promise<string | undefined> {
  const p = asExtProvider(agent)
  const b = p && readBinding(ws, sid, agent)
  if (!p || !b) return undefined
  if (b.extFile && await stat(b.extFile).then(s => s.isFile(), () => false)) return b.extFile
  const missKey = `${agent}\0${b.resumeId}`
  const now = (deps.now ?? Date.now)()
  if (!deps.fresh && (misses.get(missKey) ?? 0) > now) return undefined
  const f = await locateExternal(p, b.resumeId, { roots: deps.roots, cwd: b.cwd ?? ws }).catch(() => undefined)
  if (f) misses.delete(missKey); else misses.set(missKey, now + MISS_TTL_MS)
  // 找的期间 resume id 变了(新的外部会话):别把旧文件缓存到新绑定上
  if (f && f !== b.extFile && readBinding(ws, sid, agent)?.resumeId === b.resumeId) writeBinding(ws, sid, agent, { extFile: f })
  return f
}

/** 文件里最后一个 `\n` 之后的位置(写到一半的末行不算)。 */
async function eofCursor(file: string): Promise<{ cursor: ExtSyncCursor; size: number; mtimeMs: number } | undefined> {
  const fh = await open(file, 'r').catch(() => null)
  if (!fh) return undefined
  try {
    const st = await fh.stat()
    const CH = 64 << 10
    let end = st.size
    while (end > 0) {
      const start = Math.max(0, end - CH)
      const buf = Buffer.alloc(end - start)
      await fh.read(buf, 0, buf.length, start)
      const i = buf.lastIndexOf(0x0a)
      if (i >= 0) return { cursor: { offset: start + i + 1 }, size: st.size, mtimeMs: st.mtimeMs }
      end = start
    }
    return { cursor: { offset: 0 }, size: st.size, mtimeMs: st.mtimeMs }
  } catch { return undefined } finally { await fh.close().catch(() => {}) }
}

/**
 * 我方新建(origin 'forge')、还没有 syncedTo 的绑定(老数据,或换了 resume id):定位到文件当前末尾,不补齐 ——
 * 那之前的内容是我们自己的历史,绝不能再当「在 <App> 中」显示一遍。返回此刻的 syncedTo(没有绑定 / 文件时 undefined)。
 * ★调用方:我方一轮还在跑时不要调它,也不要补齐(那段是我们自己正在写的)。
 */
export async function ensureSyncedTo(ws: string, sid: string, agent: string, deps: BindingDeps = {}): Promise<ExtSyncCursor | undefined> {
  const b = asExtProvider(agent) && readBinding(ws, sid, agent)
  if (!b) return undefined
  if (b.syncedTo) return b.syncedTo
  if (b.origin !== 'forge') return undefined
  const f = await resolveBindingFile(ws, sid, agent, deps)
  const eof = f && await eofCursor(f)
  if (!eof) return undefined
  writeBinding(ws, sid, agent, { syncedTo: eof.cursor })
  return eof.cursor
}

/** 空白折叠后的文本,用来比对「外部记录里的用户消息」和「Forge 发出去的那条」(外部那条常被 provider 包了上下文/指令)。 */
export const norm = (t: string): string => t.replace(/\s+/g, ' ').trim()
/**
 * CLI 留驻进程自己起的一轮(后台任务完成通知)。当作我方的跳过 —— 已接受的风险:官方 App 里跑的后台任务完成时
 * 也会写一条这样的记录,在它前面若没有一条对不上的用户记录,它那一轮的回复就不会显示成「在 <App> 中」
 * (只丢这一段显示,外部记录本身不受影响;App 那边的用户提问总会先出现并让游标停住)。
 */
export const NOTIFICATION = /^<task-notification[\s>]/

export interface Sent { id: string; text: string }
/**
 * 从 syncedTo 起只跳过我方自己的轮次:用户记录的文本包含 Forge 发出的、还没对上过的某条用户消息(按顺序),连同其后的
 * 助手/工具记录。遇到第一条对不上的用户记录就停在它前面,留给下一次补齐显示「在 <App> 中」。
 * 返回新游标 + 最后一条对上的 Forge 消息 id。
 */
function pastOwnTurns(r: ExtRead, from: ExtSyncCursor, sent: Sent[]): { cursor: ExtSyncCursor; mark?: string } {
  let cands = sent
  let mark: string | undefined
  const offs = r.offsets ?? []
  for (let i = 0; i < r.turns.length; i++) {
    const t = r.turns[i]
    if (t.who !== 'user') continue
    const text = norm(t.text)
    if (NOTIFICATION.test(text)) continue
    const k = cands.findIndex(c => text.includes(c.text))
    if (k < 0) return { cursor: offs[i] === undefined || offs[i] <= from.offset ? from : { offset: offs[i] }, mark }
    mark = cands[k].id
    cands = cands.slice(k + 1)
  }
  return { cursor: r.next, mark }
}

/** Forge 自己发的用户消息(补齐进来的官方 App 消息不算)里排在水位(ownMsgMark)之后的那些。水位那条已不在(删过消息)→ 全部。 */
export function sentAfter(ws: string, sid: string, mark: string | undefined): Sent[] {
  const users = readMessages(ws, sid).filter(m => m.who === 'user' && !m.ext)
  const at = mark ? users.findIndex(m => m.id === mark) : -1
  return users.slice(at + 1).map(m => ({ id: m.id, text: norm(m.text) })).filter(m => m.text)
}

/**
 * 我方写者安静下来了:记下文件此刻的大小 + mtime(ownEnd),并把 syncedTo 推过我方自己的轮次(只推过我们的,见 pastOwnTurns)。
 * 调用点:Claude 聊天进程退出(ChatBackgroundHooks.onExit);Codex exec 进程退出 / app-server turn 完成、Qoder 进程退出
 * (这三者都在 sendTurn 收尾之前发生)。读的期间 resume id 变了 → 什么都不写。
 */
export async function recordOwnEnd(ws: string, sid: string, agent: string, deps: BindingDeps = {}): Promise<void> {
  try {
    const p = asExtProvider(agent)
    const b0 = p && readBinding(ws, sid, agent)
    if (!p || !b0) return
    const f = await resolveBindingFile(ws, sid, agent, { ...deps, fresh: true })
    const eof = f && await eofCursor(f)
    if (!f || !eof) return
    let syncedTo: ExtSyncCursor | undefined
    let ownMsgMark: string | undefined
    if (!b0.syncedTo) {
      syncedTo = b0.origin === 'forge' ? eof.cursor : undefined   // 老的我方绑定:之前全是我们自己的历史
    } else {
      const r = await readExternal(p, f, b0.syncedTo, { offsets: true })
      if (!r.exists) return
      if (!r.reset) {   // 游标对不上:不动它,交给下一次补齐的 reset 处理
        // 按消息水位挑候选,不按墙钟:claude 换进程时旧进程退出会先写 ownLastWriteAt,比这轮用户消息的 ts 还晚。
        const walked = pastOwnTurns(r, b0.syncedTo, sentAfter(ws, sid, b0.ownMsgMark))
        syncedTo = walked.cursor
        ownMsgMark = walked.mark
      }
    }
    const b1 = readBinding(ws, sid, agent)
    if (!b1 || b1.resumeId !== b0.resumeId) return
    writeBinding(ws, sid, agent, { ownEnd: { offset: eof.size, mtimeMs: eof.mtimeMs }, ownLastWriteAt: (deps.now ?? Date.now)(), syncedTo, ownMsgMark })
  } catch { /* 记不下就退回 mtime 规则 */ }
}

/**
 * 发送前要传给 isOccupied 的「我方写者」状态。ownLive:这个 Forge 会话自己有一轮在途(一轮结束后留驻的进程不算);
 * otherLive:另一个 Forge 会话正有一轮跑在同一个外部 id 上 —— 它是另一个写者。
 */
export function ownWriters(ws: string, sid: string, agent: string): { ownLive: boolean; otherLive: boolean } {
  const ownLive = isOwnTurnLive(ws, sid, agent)
  const b = readBinding(ws, sid, agent)
  const otherLive = !!b && liveTurnSessions(agent).some(o => !(o.ws === ws && o.sid === sid) && readBinding(o.ws, o.sid, agent)?.resumeId === b.resumeId)
  return { ownLive, otherLive }
}

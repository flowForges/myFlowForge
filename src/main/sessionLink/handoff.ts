import type { ChatMessage, ToolActivity } from '@shared/types'
import { appendMessages, readBinding, readMessages, readSessionAgents, readWatermark, writeBinding, writeWatermark } from '../chat/chatStore'
import { asExtProvider, ensureSyncedTo, norm, NOTIFICATION, ownWriters, resolveBindingFile, sentAfter, type BindingDeps, type Sent } from './binding'
import { readExternal } from './index'
import { appName, FORGE_APP, isOccupied } from './occupancy'
import { isOwnTurnLive } from './ownTurns'
import type { ExtRead, ExtTurn } from './types'

// 会话互通 · 回到我方:把官方 App 里新增的轮次补进我方会话(标签「在 <App> 中」),以及发送前的占用检查。
// 只读外部记录,从不写它。都不抛。

/** 一次补齐最多落这么多条消息,更早的折成一行「更早的 N 条」。 */
export const MAX_SHOWN = 200
export interface HandoffDeps extends BindingDeps { maxShown?: number }

/** codex 拒绝第二个写者时的报错(app-server / exec resume 都是这句)。 */
export const isActiveWriterError = (message: string): boolean => /active writer/i.test(message)

// 同一个绑定的补齐排队做:打开会话和发送前可能同时触发,并发读同一段会显示两遍。
const locks = new Map<string, Promise<unknown>>()
function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (locks.get(key) ?? Promise.resolve()).then(fn, fn)
  const tail = run.catch(() => undefined)
  locks.set(key, tail)
  void tail.then(() => { if (locks.get(key) === tail) locks.delete(key) })
  return run
}

const yieldNow = () => new Promise<void>(r => setImmediate(r))
const YIELD_EVERY = 5000

/**
 * 外部新增的轮次里哪些是官方 App 的:用户记录对上 Forge 发出的消息(按顺序,同 recordOwnEnd)= 我方的,
 * 连同其后的助手/工具记录一起跳过;后台任务通知 = 我方留驻进程的,跳过;其余用户记录及其后续 = App 的。
 * 开头没有用户记录的那几条接着上一次:我方会话最后一条是补齐进来的 → App 的,否则是我方的。
 * reset(整份重读):候选是 Forge 发过的全部消息。
 */
async function appTurns(r: ExtRead, cands0: Sent[], lastWasApp: boolean): Promise<{ shown: ExtTurn[]; mark?: string }> {
  let cands = cands0
  let mark: string | undefined
  let app = lastWasApp
  const shown: ExtTurn[] = []
  for (let i = 0; i < r.turns.length; i++) {
    if (i && i % YIELD_EVERY === 0) await yieldNow()
    const t = r.turns[i]
    if (t.who === 'user') {
      const text = norm(t.text)
      if (NOTIFICATION.test(text)) { app = false; continue }
      const k = cands.findIndex(c => text.includes(c.text))
      if (k >= 0) { app = false; mark = cands[k].id; cands = cands.slice(k + 1); continue }
      app = true
    }
    if (app) shown.push(t)
  }
  return { shown, mark }
}

const isoOf = (ts: number): string => new Date(ts > 0 ? ts : Date.now()).toISOString()

/** 外部轮次 → 消息:用户一条一条;助手文字和工具调用并成一条回复,工具调用落成折叠的「执行」块(只有摘要标题)。 */
export function toMessages(turns: ExtTurn[], app: string, maxShown = MAX_SHOWN): ChatMessage[] {
  const out: ChatMessage[] = []
  let ai: ChatMessage | null = null
  for (const t of turns) {
    if (t.who === 'user') {
      ai = null
      out.push({ id: `ext-${t.id}`, who: 'user', text: t.text, ts: isoOf(t.ts), ext: { app, id: t.id } })
      continue
    }
    if (!ai) {
      ai = { id: `ext-${t.id}`, who: 'ai', text: '', ts: isoOf(t.ts), ext: { app, id: t.id } }
      out.push(ai)
    }
    if (t.who === 'assistant') ai.text = ai.text ? `${ai.text}\n\n${t.text}` : t.text
    else (ai.tools ??= []).push({ id: t.id, title: t.text, status: 'ok' } satisfies ToolActivity)
  }
  if (out.length <= maxShown) return out
  const kept = out.slice(out.length - maxShown)
  const earlier = out.length - maxShown
  return [{ id: `ext-earlier-${kept[0].id}`, who: 'ai', text: '', ts: kept[0].ts, ext: { app, id: '', earlier } }, ...kept]
}

/**
 * 把这个绑定在官方 App 里新增的轮次补进我方会话:落盘、推进 syncedTo(并记下外部记录里的 cwd),返回补进来的消息。
 * 我方一轮在途时不补(那一段是我们自己正在写的)。我方新建、还没定位过的绑定只定位到文件末尾,不补。
 */
export function catchUp(ws: string, sid: string, agent: string, deps: HandoffDeps = {}): Promise<ChatMessage[]> {
  return serialized(`${ws}\0${sid}\0${agent}`, async () => {
    try {
      const p = asExtProvider(agent)
      const b0 = p && readBinding(ws, sid, agent)
      if (!p || !b0 || isOwnTurnLive(ws, sid, agent)) return []
      const file = await resolveBindingFile(ws, sid, agent, deps)
      if (!file) return []
      if (b0.origin === 'forge' && !b0.syncedTo) { await ensureSyncedTo(ws, sid, agent, deps); return [] }
      const b = readBinding(ws, sid, agent)
      if (!b) return []
      const from = b.syncedTo ?? { offset: 0 }
      const r = await readExternal(p, file, from)
      if (!r.exists) return []
      // 读的期间我方开了一轮 / 换了外部会话 / 我方收尾挪过游标:这次的结果作废,下一次重来
      const b1 = readBinding(ws, sid, agent)
      if (isOwnTurnLive(ws, sid, agent) || !b1 || b1.resumeId !== b.resumeId || b1.syncedTo?.offset !== b.syncedTo?.offset) return []
      const existing = readMessages(ws, sid)
      const cands = r.reset ? sentAfter(ws, sid, undefined) : sentAfter(ws, sid, b.ownMsgMark)
      const lastWasApp = !r.reset && !!existing[existing.length - 1]?.ext
      const { shown, mark } = await appTurns(r, cands, lastWasApp)
      const have = new Set(existing.map(m => m.id))
      const msgs = toMessages(shown, appName(p), deps.maxShown ?? MAX_SHOWN).filter(m => !have.has(m.id))
      if (msgs.length) {
        // 这个 provider 原本是跟上的:补进来的这些就在它自己的原生会话里,别再当「错过的历史」喂一遍
        const caughtUp = readWatermark(ws, sid, agent) >= existing.length
        appendMessages(ws, sid, msgs)
        if (caughtUp) writeWatermark(ws, sid, agent, existing.length + msgs.length)
      }
      writeBinding(ws, sid, agent, { syncedTo: r.next, cwd: r.cwd, ownMsgMark: mark })
      return msgs
    } catch { return [] }
  })
}

/** 打开 / 切回一个会话:它绑定的每家外部会话都补一遍。 */
export async function catchUpSession(ws: string, sid: string, deps: HandoffDeps = {}): Promise<ChatMessage[]> {
  const out: ChatMessage[] = []
  for (const agent of Object.keys(readSessionAgents(ws, sid))) {
    if (asExtProvider(agent)) out.push(...await catchUp(ws, sid, agent, deps))
  }
  return out
}

/**
 * 发送前:先补齐,再查占用。busy = 占着它的 App 名(另一个 Forge 会话占着时是 myFlowForge)。
 * ★必须在这一轮登记成我方在途(beginOwnTurn)之前调用,否则我方自己永远算「在写」。
 */
export async function preSend(ws: string, sid: string, agent: string, deps: HandoffDeps = {}): Promise<{ appended: ChatMessage[]; busy?: string }> {
  try {
    const p = asExtProvider(agent)
    if (!p || !readBinding(ws, sid, agent)) return { appended: [] }
    const appended = await catchUp(ws, sid, agent, deps)
    const b = readBinding(ws, sid, agent)
    if (!b) return { appended }
    const { ownLive, otherLive } = ownWriters(ws, sid, agent)
    const file = await resolveBindingFile(ws, sid, agent, deps)
    if (!file) return otherLive ? { appended, busy: FORGE_APP } : { appended }
    const occ = await isOccupied(p, file, (deps.now ?? Date.now)(), { ownLive, otherLive, ownEnd: b.ownEnd, ownLastWriteAt: b.ownLastWriteAt })
    return occ.busy ? { appended, busy: occ.app ?? appName(p) } : { appended }
  } catch { return { appended: [] } }
}

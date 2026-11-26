import { existsSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ContinueResult, DiscoveredSession } from '@shared/types'
import { appendMessages, findBoundSessions, forgetSession, writeBinding, writeWatermark } from '../chat/chatStore'
import { closeSession, dropSession, newSession, readSessions, setSessionModel } from '../chat/sessionStore'
import { wsForgeDir } from '../config/paths'
import { readWorkspaceRegistry, unregisterWorkspace } from '../config/store'
import { asExtProvider } from '../sessionLink/binding'
import { MAX_SHOWN, toMessages } from '../sessionLink/handoff'
import { readExternal } from '../sessionLink/index'
import { locateExternal } from '../sessionLink/locate'
import { appName } from '../sessionLink/occupancy'
import type { ExtProvider } from '../sessionLink/types'
import { importWorkspace } from './importWorkspace'

// 导入页「在 myFlowForge 继续」:接管官方 App 的会话 —— 同一个外部 id,不是只读副本。
// 建(或复用)一个 Forge 会话,绑定 {resumeId: 外部 id, origin: 'imported'},把历史写成 `来源: <App>` 的消息;
// 之后发送就走 provider 原生的 resume。只读外部记录,从不写它。

export interface TakeoverDeps {
  roots?: Record<ExtProvider, string>
  /** 已登记的工作区路径。 */
  workspaces?: () => string[]
  /** 把外部 cwd 登记成轻量工作区。 */
  register?: (cwd: string) => void
  /** 接管失败时撤销本次的登记。 */
  unregister?: (cwd: string) => void
  /** 这家 provider 的用户默认模型(外部记录里的模型不强加)。 */
  defaultModel?: (agent: string) => Promise<string> | string
  maxShown?: number
}

const isDir = (p: string): boolean => { try { return statSync(p).isDirectory() } catch { return false } }
const isFile = (p: string): boolean => { try { return statSync(p).isFile() } catch { return false } }

async function transcriptOf(p: ExtProvider, s: DiscoveredSession, roots?: Record<ExtProvider, string>): Promise<string | undefined> {
  // claude / codex 扫描到的就是那份记录;qoder 扫描的是运行日志分段,记录本身要去 projects 下找
  if (p !== 'qoder' && s.filePaths[0] && isFile(s.filePaths[0])) return s.filePaths[0]
  const cwd = s.cwd && s.cwd !== 'unknown' ? s.cwd : undefined
  return locateExternal(p, s.externalId, { roots, cwd }).catch(() => undefined)
}

/** 这个会话能不能「在 myFlowForge 继续」。qoder 存储不在 / 找不到记录 → false(入口不显示,不报错)。 */
export async function canContinue(s: DiscoveredSession, deps: Pick<TakeoverDeps, 'roots'> = {}): Promise<boolean> {
  const p = asExtProvider(s.source)
  if (!p) return false
  if (p !== 'qoder') return true
  return !!await transcriptOf(p, s, deps.roots)
}

/** 扫描时给每个会话标上能不能接着聊;最多 limit 个同时查(qoder 每个都要去目录里找记录)。顺序不变。 */
export async function markContinuable(sessions: DiscoveredSession[], check: (s: DiscoveredSession) => Promise<boolean> = canContinue, limit = 8): Promise<DiscoveredSession[]> {
  const out: DiscoveredSession[] = new Array(sessions.length)
  let next = 0
  const worker = async () => {
    while (next < sessions.length) {
      const i = next++
      out[i] = { ...sessions[i], continuable: await check(sessions[i]).catch(() => false) }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, sessions.length) }, worker))
  return out
}

/** 已经绑定这个外部 id、且还开着的 Forge 会话(任一登记过的工作区里)。关掉的会话在 chat-session.json 里还留着条目,跳过它们。 */
function findTaken(wsPaths: string[], agent: string, resumeId: string): { wsPath: string; sessionId: string } | undefined {
  for (const ws of wsPaths) {
    if (!existsSync(join(wsForgeDir(ws), 'sessions.json'))) continue
    const sids = findBoundSessions(ws, agent, resumeId)
    if (!sids.length) continue
    const live = new Set(readSessions(ws).sessions.filter(x => !x.readonly).map(x => x.id))
    const sid = sids.find(id => live.has(id))
    if (sid) return { wsPath: ws, sessionId: sid }
  }
  return undefined
}

/** 比较路径用:真实路径(/var → /private/var),去掉末尾斜杠。不存在 → undefined。 */
function realDir(p: string): string | undefined {
  try { return realpathSync(p.length > 1 ? p.replace(/\/+$/, '') : p) } catch { return undefined }
}

// 同一个外部 id 的接管排队做:连点两下 / 两处同时点,也只建一个会话。
const locks = new Map<string, Promise<unknown>>()
function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (locks.get(key) ?? Promise.resolve()).then(fn, fn)
  const tail = run.catch(() => undefined)
  locks.set(key, tail)
  void tail.then(() => { if (locks.get(key) === tail) locks.delete(key) })
  return run
}

export function continueExternal(s: DiscoveredSession, deps: TakeoverDeps = {}): Promise<ContinueResult> {
  return serialized(`${s.source}\0${s.externalId}`, () => takeOver(s, deps))
}

async function takeOver(s: DiscoveredSession, deps: TakeoverDeps): Promise<ContinueResult> {
  const p = asExtProvider(s.source)
  if (!p) return { ok: false, error: '这个来源不能接着聊' }
  const agent: string = p
  const wsPaths = (deps.workspaces ?? (() => readWorkspaceRegistry().map(w => w.path)))()
  const taken = findTaken(wsPaths, agent, s.externalId)
  if (taken) return { ok: true, ...taken, created: false, wsAdded: false }

  const file = await transcriptOf(p, s, deps.roots)
  if (!file) return { ok: false, error: '找不到这个会话的记录' }
  const r = await readExternal(p, file, { offset: 0 })
  if (!r.exists) return { ok: false, error: '找不到这个会话的记录' }
  // 续接必须在外部记录里的 cwd 上(claude 的会话按 cwd 存放):它说了算,扫描时的 cwd 只作回退
  const raw = r.cwd ?? (s.cwd !== 'unknown' ? s.cwd : '')
  const real = raw ? realDir(raw) : undefined
  if (!real || !isDir(real)) return { ok: false, error: '原目录已不存在' }
  // 已登记的工作区按真实路径认(登记时的写法可能是 /var/… 或带斜杠);用登记里的那个路径,会话才落在侧栏那一项里
  const cwd = wsPaths.find(w => realDir(w) === real) ?? real

  const wsAdded = !wsPaths.includes(cwd)
  if (wsAdded) (deps.register ?? importWorkspace)(cwd)
  let sid: string | undefined
  try {
    sid = newSession(cwd, s.title || undefined).activeSessionId
    const model = await Promise.resolve(deps.defaultModel?.(agent) ?? '').catch(() => '')
    setSessionModel(cwd, sid, agent, model)
    const app = appName(p)
    const msgs = toMessages(r.turns, { app, agent, resumeId: s.externalId }, deps.maxShown ?? MAX_SHOWN)
      .map(m => ({ ...m, ext: { ...m.ext!, imported: true } }))
    appendMessages(cwd, sid, msgs)
    writeBinding(cwd, sid, agent, { resumeId: s.externalId, origin: 'imported', extFile: file, cwd, syncedTo: r.next })
    // 这些就在它自己的原生会话里:续接时别再当「错过的历史」喂一遍
    writeWatermark(cwd, sid, agent, msgs.length)
    // 以前「导入」过的只读副本:接管之后它就是重复的那一份
    const ro = `ext-${s.source}-${s.externalId}`
    if (readSessions(cwd).sessions.some(x => x.id === ro && x.readonly)) closeSession(cwd, ro)
  } catch (e) {
    // 半路失败:撤掉这次建的会话,以及这次才登记的工作区
    if (sid) { try { dropSession(cwd, sid); forgetSession(cwd, sid) } catch { /* best effort */ } }
    if (wsAdded) { try { (deps.unregister ?? unregisterWorkspace)(cwd) } catch { /* best effort */ } }
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  return { ok: true, wsPath: cwd, sessionId: sid, created: true, wsAdded }
}

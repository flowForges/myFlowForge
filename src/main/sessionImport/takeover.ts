import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ContinueResult, DiscoveredSession } from '@shared/types'
import { appendMessages, findBoundSession, writeBinding, writeWatermark } from '../chat/chatStore'
import { closeSession, newSession, readSessions, setSessionModel } from '../chat/sessionStore'
import { wsForgeDir } from '../config/paths'
import { readWorkspaceRegistry } from '../config/store'
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

/** 已经绑定这个外部 id 的 Forge 会话(任一登记过的工作区里,且会话还在)。 */
function findTaken(wsPaths: string[], agent: string, resumeId: string): { wsPath: string; sessionId: string } | undefined {
  for (const ws of wsPaths) {
    if (!existsSync(join(wsForgeDir(ws), 'sessions.json'))) continue
    const sid = findBoundSession(ws, agent, resumeId)
    if (sid && readSessions(ws).sessions.some(x => x.id === sid && !x.readonly)) return { wsPath: ws, sessionId: sid }
  }
  return undefined
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
  const cwd = r.cwd ?? (s.cwd !== 'unknown' ? s.cwd : '')
  if (!cwd || !isDir(cwd)) return { ok: false, error: '原目录已不存在' }

  const wsAdded = !wsPaths.includes(cwd)
  if (wsAdded) (deps.register ?? importWorkspace)(cwd)
  const sid = newSession(cwd, s.title || undefined).activeSessionId
  const model = await Promise.resolve(deps.defaultModel?.(agent) ?? '').catch(() => '')
  setSessionModel(cwd, sid, agent, model)
  // 以前「导入」过的只读副本:接管之后它就是重复的那一份
  const ro = `ext-${s.source}-${s.externalId}`
  if (readSessions(cwd).sessions.some(x => x.id === ro && x.readonly)) closeSession(cwd, ro)

  const app = appName(p)
  const msgs = toMessages(r.turns, { app, agent, resumeId: s.externalId }, deps.maxShown ?? MAX_SHOWN)
    .map(m => ({ ...m, ext: { ...m.ext!, imported: true } }))
  appendMessages(cwd, sid, msgs)
  writeBinding(cwd, sid, agent, { resumeId: s.externalId, origin: 'imported', extFile: file, cwd, syncedTo: r.next })
  // 这些就在它自己的原生会话里:续接时别再当「错过的历史」喂一遍
  writeWatermark(cwd, sid, agent, msgs.length)
  return { ok: true, wsPath: cwd, sessionId: sid, created: true, wsAdded }
}

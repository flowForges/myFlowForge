import { open, stat } from 'node:fs/promises'
import { readBinding, writeBinding, type ExtSyncCursor } from '../chat/chatStore'
import { isClaudeChatLive } from '../agents/providers/claude'
import { locateExternal } from './locate'
import type { ExtProvider } from './types'

// 绑定 ↔ 外部记录文件的小工具:找文件(带缓存)、首次定位、记录「我方写者安静下来」。都不抛。

export interface BindingDeps { roots?: Record<ExtProvider, string>; now?: () => number }

const LINKED = new Set<string>(['codex', 'claude', 'qoder'])
/** chat-session.json 的 agent 键 → 能和官方 App 互通的 provider;其它家 undefined。 */
export const asExtProvider = (agent: string): ExtProvider | undefined => (LINKED.has(agent) ? agent as ExtProvider : undefined)

/** 绑定的外部记录文件:缓存的 extFile 还在就用,否则重新找并缓存。没有绑定 / 找不到 → undefined。 */
export async function resolveBindingFile(ws: string, sid: string, agent: string, deps: BindingDeps = {}): Promise<string | undefined> {
  const p = asExtProvider(agent)
  const b = p && readBinding(ws, sid, agent)
  if (!p || !b) return undefined
  if (b.extFile && await stat(b.extFile).then(s => s.isFile(), () => false)) return b.extFile
  const f = await locateExternal(p, b.resumeId, { roots: deps.roots, cwd: b.cwd ?? ws }).catch(() => undefined)
  if (f && f !== b.extFile) writeBinding(ws, sid, agent, { extFile: f })
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

/**
 * 我方写者安静下来了:记下文件此刻的大小 + mtime(ownEnd),并把 syncedTo 推到末尾(刚写的是我们自己的一轮)。
 * 调用点:Claude 聊天进程退出(ChatBackgroundHooks.onExit);Codex exec 进程退出 / app-server turn 完成、Qoder 进程退出
 * (这三者都在 sendTurn 收尾之前发生)。★前提:发这一轮前已经补齐过外部新增(Task 3 发送前检查)。
 */
export async function recordOwnEnd(ws: string, sid: string, agent: string, deps: BindingDeps = {}): Promise<void> {
  try {
    const f = await resolveBindingFile(ws, sid, agent, deps)
    const eof = f && await eofCursor(f)
    if (!eof) return
    writeBinding(ws, sid, agent, { ownEnd: { offset: eof.size, mtimeMs: eof.mtimeMs }, ownLastWriteAt: (deps.now ?? Date.now)(), syncedTo: eof.cursor })
  } catch { /* 记不下就退回 mtime 规则 */ }
}

/**
 * 我方进程此刻还握着这个外部会话?Claude:留驻 / 正在跑的聊天进程(cwd = 工作区)。
 * Codex app-server 线程是否仍订阅由调用方自己知道(传 ownLive);这里对 codex / qoder 返回 false。
 */
export function ownLiveFor(provider: ExtProvider, ws: string, resumeId: string): boolean {
  return provider === 'claude' ? isClaudeChatLive(ws, resumeId) : false
}

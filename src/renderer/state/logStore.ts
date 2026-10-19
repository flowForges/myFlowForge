import type { ChatEvent } from '@shared/types'
import {
  LogLine,
  appendLines, appendLineText, chatEventToLines, logStamp,
} from './logReducer'

// ★ 实时日志的状态放在 React 之外。以前它是 App 里的 useState:每个流式 token 都 setLogs(prev.map…),
// 于是整个 App(侧栏、工作区、对话区…)跟着每个 token 重渲。现在日志写进这个外部 store,只有真正
// 显示日志的组件(日志台、状态栏的日志小点)用 useSyncExternalStore 订阅,App 本身不再随日志重渲。
// 写入立即落到「工作态」,通知按动画帧合并:一帧里来 100 个 token 也只通知一次。

export interface LogSnapshot {
  logs: LogLine[]
  busy: boolean
}

export interface LogStore {
  getSnapshot: () => LogSnapshot
  subscribe: (listener: () => void) => () => void
  push: (lines: LogLine[]) => void
  handleChat: (e: ChatEvent, now?: Date) => void
  clear: () => void
  /** Publish pending changes now instead of waiting for the next frame. */
  flush: () => void
  /** Drop pending frame + per-turn bookkeeping (on unmount). */
  dispose: () => void
}

type Schedule = (cb: () => void) => () => void

const nextFrame: Schedule = (cb) => {
  if (typeof requestAnimationFrame === 'function') {
    const id = requestAnimationFrame(cb)
    return () => cancelAnimationFrame(id)
  }
  const id = setTimeout(cb, 16)
  return () => clearTimeout(id)
}

const EMPTY: LogSnapshot = { logs: [], busy: false }

export function createLogStore(schedule: Schedule = nextFrame): LogStore {
  let published: LogSnapshot = EMPTY
  let working: LogSnapshot = EMPTY
  let cancelFrame: (() => void) | null = null
  const listeners = new Set<() => void>()
  // 流式行:assistant message id → 当前那条日志行的 id
  const streamingLines = new Map<string, string>()

  const flush = () => {
    cancelFrame?.()
    cancelFrame = null
    if (published === working) return
    published = working
    for (const l of [...listeners]) l()
  }

  const set = (next: LogSnapshot) => {
    if (next === working) return
    working = next
    if (!cancelFrame) cancelFrame = schedule(() => { cancelFrame = null; flush() })
  }
  const setLogs = (fn: (prev: LogLine[]) => LogLine[]) => {
    const logs = fn(working.logs)
    if (logs !== working.logs) set({ ...working, logs })
  }
  const setBusy = (busy: boolean) => {
    if (busy !== working.busy) set({ ...working, busy })
  }

  const push = (incoming: LogLine[]) => {
    if (!incoming.length) return
    setLogs(prev => appendLines(prev, incoming))
  }

  const streamLine = (e: ChatEvent & { id: string }, id: string, level: 'think' | 'out', text: string, now: Date): LogLine => ({
    id, t: logStamp(now), level, src: '主代理', color: 'var(--accent)',
    ws: e.workspacePath, sess: e.sessionId,
    text, streaming: true,
  })

  const handleChat = (e: ChatEvent, now: Date = new Date()) => {
    // Coalesce streaming think/out deltas into a single STREAMING line
    if (e.type === 'assistant-start') {
      setBusy(true)
      // Create a new streaming 'out' line for this message
      const lineId = `stream-${e.id}`
      streamingLines.set(e.id, lineId)
      push([streamLine(e, lineId, 'out', '', now)])
      return
    }

    if (e.type === 'think-delta' || e.type === 'assistant-delta') {
      const level = e.type === 'think-delta' ? 'think' : 'out'
      const lineId = streamingLines.get(e.id)
      if (lineId) {
        // Update the streaming line in-place
        setLogs(prev => prev.map(l => l.id === lineId
          ? { ...l, level, text: appendLineText(l.text, e.text), streaming: true }
          : l
        ))
      } else {
        // No streaming line yet — create one
        const newId = `stream-${level}-${e.id}`
        streamingLines.set(e.id, newId)
        push([streamLine(e, newId, level, e.text, now)])
      }
      return
    }

    // 主代理的工具调用 → 「执行」页签。之前这条线完全没接:对话区的执行块显示着「共 21 步」,而实时日志
    // 的「执行」页签是空的 —— 日志里只剩一条指令和一条输出,看着像「AI 什么都没干」。
    // 每个工具一行(按 tool.id 就地更新):start 时建行,done 时补上输出和成败,不为同一次调用刷两行。
    if (e.type === 'tool-activity') {
      const lineId = `tool-${e.id}-${e.tool.id}`
      const done = e.tool.status !== 'run'
      const body = e.tool.output?.trim()
      // 输出可能很长(整个文件、整片 rg 结果),日志是滚动流不是阅读器 —— 截断,完整内容在对话区的执行块里。
      const clipped = body && body.length > 400 ? `${body.slice(0, 400)}…` : body
      const text = done && clipped ? `${e.tool.title}\n${clipped}` : e.tool.title
      setLogs(prev => prev.some(l => l.id === lineId)
        ? prev.map(l => l.id === lineId ? { ...l, text, streaming: !done, level: e.tool.status === 'error' ? 'exec' : l.level } : l)
        : appendLines(prev, [{
          id: lineId, t: logStamp(now), level: 'exec' as const, src: '主代理',
          color: e.tool.status === 'error' ? 'var(--err)' : 'var(--muted)',
          ws: e.workspacePath, sess: e.sessionId, text, streaming: !done,
        }]))
      return
    }

    if (e.type === 'done') {
      setBusy(false)
      const lineId = streamingLines.get(e.message.id)
      if (lineId) {
        // Clear streaming flag
        setLogs(prev => prev.map(l => l.id === lineId ? { ...l, streaming: false } : l))
        streamingLines.delete(e.message.id)
      }
      return
    }

    if (e.type === 'error') {
      // ★ 出错的回合后面不会再有 done:不在这里收尾的话,这一轮的流式行和还在跑的工具行会一直挂着
      // streaming 光标,streamingLines 里的条目也永远不删。
      setBusy(false)
      const lineId = streamingLines.get(e.id)
      streamingLines.delete(e.id)
      const toolPrefix = `tool-${e.id}-`
      setLogs(prev => prev.some(l => l.streaming && (l.id === lineId || l.id.startsWith(toolPrefix)))
        ? prev.map(l => l.streaming && (l.id === lineId || l.id.startsWith(toolPrefix)) ? { ...l, streaming: false } : l)
        : prev)
    }

    // user / error → use pure mappers. Stamp the session so the log can auto-scope to it.
    const lines = chatEventToLines(e, now)
    if (lines.length) push(lines.map(l => ({ ...l, ws: e.workspacePath, sess: e.sessionId })))
  }

  const clear = () => {
    if (working.logs.length) set({ ...working, logs: [] })
    streamingLines.clear()
  }

  return {
    getSnapshot: () => published,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    push,
    handleChat,
    clear,
    flush,
    dispose: () => {
      cancelFrame?.()
      cancelFrame = null
      streamingLines.clear()
    },
  }
}

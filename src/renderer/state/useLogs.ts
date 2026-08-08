import { useEffect, useRef, useState } from 'react'
import type { EngineEvent, ChatEvent, ChangesEvent } from '@shared/types'
import type { RunLogLine } from '../../main/run/controller'
import {
  LogLine, MAX_LOGS,
  appendLines, chatEventToLines, pendingAddToLine,
  agentLogToLine, agentStateLine, changeItemToLine, logStamp, run2LogToLine,
} from './logReducer'

export interface LogsApi {
  logs: LogLine[]
  busy: boolean
  push: (lines: LogLine[]) => void
  clear: () => void
}

export function useLogs(): LogsApi {
  const [logs, setLogs] = useState<LogLine[]>([])
  const [busy, setBusy] = useState(false)

  // Track per-agent previous state for run:update diffing
  const agentPrevState = useRef<Map<string, string>>(new Map())

  // Track streaming lines: messageId → current line id
  const streamingLines = useRef<Map<string, string>>(new Map())

  const push = (incoming: LogLine[]) => {
    if (!incoming.length) return
    setLogs(prev => appendLines(prev, incoming))
  }

  const clear = () => {
    setLogs([])
    agentPrevState.current.clear()
    streamingLines.current.clear()
  }

  useEffect(() => {
    const offChat = window.forge.onChatEvent((e: ChatEvent) => {
      const now = new Date()

      // Coalesce streaming think/out deltas into a single STREAMING line
      if (e.type === 'assistant-start') {
        setBusy(true)
        // Create a new streaming 'out' line for this message
        const t = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`
        const lineId = `stream-${e.id}`
        streamingLines.current.set(e.id, lineId)
        const line: LogLine = {
          id: lineId, t, level: 'out', src: '主代理', color: 'var(--accent)',
          ws: e.workspacePath, sess: e.sessionId,
          text: '', streaming: true,
        }
        setLogs(prev => appendLines(prev, [line]))
        return
      }

      if (e.type === 'think-delta') {
        const lineId = streamingLines.current.get(e.id)
        if (lineId) {
          // Update the streaming line in-place (think level)
          setLogs(prev => prev.map(l => l.id === lineId
            ? { ...l, level: 'think', text: l.text + e.text, streaming: true }
            : l
          ))
        } else {
          // No streaming line yet — create one
          const t = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`
          const newId = `stream-think-${e.id}`
          streamingLines.current.set(e.id, newId)
          const line: LogLine = {
            id: newId, t, level: 'think', src: '主代理', color: 'var(--accent)',
            ws: e.workspacePath, sess: e.sessionId,
            text: e.text, streaming: true,
          }
          setLogs(prev => appendLines(prev, [line]))
        }
        return
      }

      if (e.type === 'assistant-delta') {
        const lineId = streamingLines.current.get(e.id)
        if (lineId) {
          setLogs(prev => prev.map(l => l.id === lineId
            ? { ...l, level: 'out', text: l.text + e.text, streaming: true }
            : l
          ))
        } else {
          const t = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`
          const newId = `stream-out-${e.id}`
          streamingLines.current.set(e.id, newId)
          const line: LogLine = {
            id: newId, t, level: 'out', src: '主代理', color: 'var(--accent)',
            ws: e.workspacePath, sess: e.sessionId,
            text: e.text, streaming: true,
          }
          setLogs(prev => appendLines(prev, [line]))
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
        const lineId = streamingLines.current.get(e.message.id)
        if (lineId) {
          // Clear streaming flag
          setLogs(prev => prev.map(l => l.id === lineId ? { ...l, streaming: false } : l))
          streamingLines.current.delete(e.message.id)
        }
        return
      }

      // user / error → use pure mappers. Stamp the session so the log can auto-scope to it.
      const lines = chatEventToLines(e, now)
      if (lines.length) push(lines.map(l => ({ ...l, ws: e.workspacePath, sess: e.sessionId })))
    })

    return () => { offChat() }
  }, [])

  // The legacy orchestrator engine-event log stream (pending:add / agent:log / agent:stalled /
  // run:update per-agent state lines) is gone with the orchestrator. run2 feeds this console via its
  // own RunLogLine stream (below); nothing subscribes to the removed engine bus here anymore.

  // run2 (P0 Task 4): the new headless run controller doesn't emit EngineEvents — it broadcasts
  // its own RunLogLine stream (see Tasks 1-3). Feed those into the same console so the bottom log
  // panel isn't empty during a run2 workflow run.
  useEffect(() => {
    const r = window.forge?.run2
    if (!r?.onLog) return
    const off = r.onLog((p: { workspacePath: string; log: unknown }) => {
      push([run2LogToLine({ workspacePath: p.workspacePath, log: p.log as RunLogLine }, new Date())])
    })
    return () => { off() }
  }, [])

  useEffect(() => {
    if (!window.forge.onChangesEvent) return
    const offChanges = window.forge.onChangesEvent((e: ChangesEvent) => {
      const now = new Date()
      const lines = e.changes.map(c => changeItemToLine(c, e.cwd, now))
      if (lines.length) push(lines)
    })
    return () => { offChanges() }
  }, [])

  return { logs, busy, push, clear }
}

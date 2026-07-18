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
            text: e.text, streaming: true,
          }
          setLogs(prev => appendLines(prev, [line]))
        }
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

      // user / error → use pure mappers
      const lines = chatEventToLines(e, now)
      if (lines.length) push(lines)
    })

    return () => { offChat() }
  }, [])

  useEffect(() => {
    const offEngine = window.forge.onEngineEvent((e: EngineEvent) => {
      const now = new Date()

      if (e.type === 'pending:add') {
        push([pendingAddToLine(e, now)])
        return
      }

      if (e.type === 'agent:log') {
        push([agentLogToLine(e, now)])
        return
      }

      if (e.type === 'agent:heartbeat') {
        return
      }

      if (e.type === 'agent:stalled') {
        const secs = Math.round(e.silentMs / 1000)
        const t = logStamp(now)
        push([{
          id: `${t}-stalled-${e.agentId}`,
          t, level: 'exec', src: e.agentName, color: 'var(--warn)',
          text: `仍在推理中:${secs}s 无输出(长时间思考属正常,静默满 6 分钟才会终止)`, streaming: false,
        }])
        return
      }

      if (e.type === 'run:update') {
        const status = e.run.status
        if (status === 'run') setBusy(true)
        else if (status === 'ok' || status === 'err') setBusy(false)

        const newLines: LogLine[] = []
        // Diff per-agent state
        for (const stage of e.run.stages) {
          for (const agent of stage.agents) {
            const prev = agentPrevState.current.get(agent.id)
            const cur = agent.state
            if (prev !== cur && (cur === 'run' || cur === 'stalled' || cur === 'awaiting' || cur === 'ok' || cur === 'err')) {
              newLines.push(agentStateLine(agent.id, agent.name, cur, now))
            }
            agentPrevState.current.set(agent.id, cur)
          }
        }
        if (newLines.length) push(newLines)
        return
      }
    })

    return () => { offEngine() }
  }, [])

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

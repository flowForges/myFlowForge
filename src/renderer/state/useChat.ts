import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentContextMeta, AgentContextRef, ChatConfirm, ChatEvent, ChatMessage, ChatSendPayload } from '@shared/types'
import type { PlanReq } from '../components/PlanCard'

export interface ChatQueueItem { id: string; text: string; source: string }

export interface AskReq { id: string; title: string; options?: { t: string; d: string }[]; agentName?: string; ts: string }
export interface ChatApi {
  messages: ChatMessage[]
  streamingIds: Set<string>
  confirms: ChatConfirm[]
  asks: AskReq[]
  plans: PlanReq[]
  busy: boolean
  queue: ChatQueueItem[]
  running: { id: string; text: string } | null
  delegateActive: boolean
  send: (payload: Omit<ChatSendPayload, 'workspacePath' | 'sessionId'>) => void
  resolveConfirm: (payload: { id: string; decision: 'allow' | 'deny'; value?: string }) => void
  resolveAsk: (payload: { id: string; decision: 'allow' | 'deny'; value?: string; choice?: number }) => void
  resolvePlan: (payload: { id: string; decision: 'allow' | 'deny' | 'modify'; value?: string; selection?: { stages: string[]; stageProjects: Record<string, string[]> } }) => void
  cancelQueued: (id: string) => void
  clearQueue: () => void
  stop: () => void
}

function mergeRefs(a: AgentContextRef[] = [], b: AgentContextRef[] = []): AgentContextRef[] {
  const map = new Map<string, AgentContextRef>()
  for (const item of a) map.set(item.path, item)
  for (const item of b) map.set(item.path, { ...(map.get(item.path) ?? {}), ...item })
  return Array.from(map.values())
}

function mergeContext(a?: AgentContextMeta, b?: AgentContextMeta): AgentContextMeta | undefined {
  if (!a) return b
  if (!b) return a
  return {
    skills: mergeRefs(a.skills, b.skills),
    rules: mergeRefs(a.rules, b.rules),
    mcps: mergeRefs(a.mcps ?? [], b.mcps ?? []),
  }
}

export function useChat(
  workspacePath: string | undefined,
  sessionId: string | undefined,
  onModeChanged?: (mode: 'chat' | 'workflow', runId?: string) => void,
): ChatApi {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streamingIds, setStreamingIds] = useState<Set<string>>(new Set())
  const [confirms, setConfirms] = useState<ChatConfirm[]>([])
  const [asks, setAsks] = useState<AskReq[]>([])
  const [plans, setPlans] = useState<PlanReq[]>([])
  const [busy, setBusy] = useState(false)
  const [queue, setQueue] = useState<ChatQueueItem[]>([])
  const [running, setRunning] = useState<{ id: string; text: string } | null>(null)
  // True while any fire-and-forget delegate sub-agent is still running for this session (the chat turn
  // already ended). Lets the composer show a running/stop state across the fire-and-forget boundary.
  const [delegateActive, setDelegateActive] = useState(false)
  const api = useRef(window.forge)
  const onModeChangedRef = useRef(onModeChanged)
  onModeChangedRef.current = onModeChanged

  useEffect(() => {
    if (!workspacePath || !sessionId) { setMessages([]); setConfirms([]); setPlans([]); setBusy(false); setQueue([]); setRunning(null); setDelegateActive(false); return }
    setMessages([]); setStreamingIds(new Set()); setConfirms([]); setPlans([]); setBusy(false); setQueue([]); setRunning(null); setDelegateActive(false)
    let live = true
    void api.current.chatHistory(workspacePath, sessionId).then((h: ChatMessage[]) => { if (live) setMessages(h) })
    return () => { live = false }
  }, [workspacePath, sessionId])

  useEffect(() => {
    const off = api.current.onChatQueueEvent(e => {
      if (e.workspacePath !== workspacePath) return
      setBusy(e.busy)
      setQueue(e.queue)
      setRunning(e.running ?? null)
    })
    return () => { off() }
  }, [workspacePath])

  useEffect(() => {
    const off = api.current.onChatEvent((e: ChatEvent) => {
      if (e.workspacePath !== workspacePath || e.sessionId !== sessionId) return
      // NOTE: delta/done/error UPSERT by id. A turn can start (assistant-start) while this chat view is
      // unmounted — e.g. a command sent from the pet while the app is on the home view. When the view then
      // opens mid-turn it never saw assistant-start, so a plain `.map` would drop every delta/done and the
      // reply would never appear. Creating the message on first sight of any of its events fixes that.
      const blankAi = (id: string): ChatMessage => ({ id, who: 'ai', text: '', ts: '', think: { label: '主代理思考中…', steps: [] } })
      if (e.type === 'user') setMessages(m => [...m, e.message])
      else if (e.type === 'assistant-start') {
        setStreamingIds(s => new Set(s).add(e.id))
        setMessages(m => m.some(x => x.id === e.id) ? m : [...m, { ...blankAi(e.id), model: e.model, context: e.context }])
      }
      else if (e.type === 'assistant-delta') {
        setStreamingIds(s => s.has(e.id) ? s : new Set(s).add(e.id))
        setMessages(m => m.some(x => x.id === e.id)
          ? m.map(x => x.id === e.id ? { ...x, text: x.text + e.text } : x)
          : [...m, { ...blankAi(e.id), text: e.text }])
      }
      else if (e.type === 'think-delta') {
        setStreamingIds(s => s.has(e.id) ? s : new Set(s).add(e.id))
        const apply = (x: ChatMessage): ChatMessage => ({
          ...x,
          context: mergeContext(x.context, e.context),
          think: { label: x.think?.label ?? '主代理思考中…', steps: [...(x.think?.steps ?? []), e.text] },
        })
        setMessages(m => m.some(x => x.id === e.id) ? m.map(x => x.id === e.id ? apply(x) : x) : [...m, apply(blankAi(e.id))])
      }
      else if (e.type === 'subagent') {
        setStreamingIds(s => s.has(e.id) ? s : new Set(s).add(e.id))
        const upsert = (x: ChatMessage): ChatMessage => {
          const list = x.subagents ?? []
          const i = list.findIndex(s => s.id === e.sub.id)
          return { ...x, subagents: i >= 0 ? list.map(s => s.id === e.sub.id ? e.sub : s) : [...list, e.sub] }
        }
        setMessages(m => m.some(x => x.id === e.id) ? m.map(x => x.id === e.id ? upsert(x) : x) : [...m, upsert(blankAi(e.id))])
      }
      else if (e.type === 'done') {
        setMessages(m => m.some(x => x.id === e.message.id) ? m.map(x => x.id === e.message.id ? e.message : x) : [...m, e.message])
        setStreamingIds(s => { const n = new Set(s); n.delete(e.message.id); return n })
      }
      else if (e.type === 'error') {
        setMessages(m => m.some(x => x.id === e.id)
          ? m.map(x => x.id === e.id ? { ...x, text: x.text || `错误: ${e.error}`, think: undefined } : x)
          : [...m, { ...blankAi(e.id), text: `错误: ${e.error}`, think: undefined }])
        setStreamingIds(s => { const n = new Set(s); n.delete(e.id); return n })
      }
      else if (e.type === 'confirm-request') setConfirms(c => [...c, { id: e.id, title: e.title, where: e.where, ts: new Date().toISOString() }])
      else if (e.type === 'confirm-resolved') setConfirms(c => c.filter(x => x.id !== e.id))
      else if (e.type === 'ask-request') setAsks(a => [...a, { id: e.id, title: e.title, options: e.options, agentName: e.agentName, ts: new Date().toISOString() }])
      else if (e.type === 'ask-resolved') setAsks(a => a.filter(x => x.id !== e.id))
      else if (e.type === 'plan-request') setPlans(p => [...p, { id: e.id, approach: e.approach, stages: e.stages, hooks: e.hooks, allProjects: e.allProjects, task: e.task, workflowId: e.workflowId, workflowName: e.workflowName, workflowOptions: e.workflowOptions, recommendReason: e.recommendReason, ts: new Date().toISOString() }])
      else if (e.type === 'plan-resolved') setPlans(p => p.filter(x => x.id !== e.id))
      else if (e.type === 'delegate-busy') setDelegateActive(e.active)
      else if (e.type === 'mode-changed') onModeChangedRef.current?.(e.mode, e.runId)
    })
    return () => { off() }
    // re-subscribe when the active workspace changes — otherwise the listener
    // closes over a stale workspacePath and silently drops every live event.
  }, [workspacePath, sessionId])

  const send = useCallback((payload: Omit<ChatSendPayload, 'workspacePath' | 'sessionId'>) => {
    if (!workspacePath || !sessionId) return
    void api.current.sendChat({ ...payload, workspacePath, sessionId })
  }, [workspacePath, sessionId])

  const resolveConfirm = useCallback((payload: { id: string; decision: 'allow' | 'deny'; value?: string }) => {
    if (!workspacePath) return
    setConfirms(c => c.filter(x => x.id !== payload.id))
    void api.current.chatResolve({ ...payload, value: payload.value, workspacePath })
  }, [workspacePath])

  const resolveAsk = useCallback((payload: { id: string; decision: 'allow' | 'deny'; value?: string; choice?: number }) => {
    if (!workspacePath) return
    setAsks(a => a.filter(x => x.id !== payload.id))
    void api.current.chatResolve({ ...payload, workspacePath })
  }, [workspacePath])

  const resolvePlan = useCallback((payload: { id: string; decision: 'allow' | 'deny' | 'modify'; value?: string; selection?: { stages: string[]; stageProjects: Record<string, string[]> } }) => {
    if (!workspacePath) return
    setPlans(p => p.filter(x => x.id !== payload.id))
    void api.current.chatResolve({ ...payload, workspacePath })
  }, [workspacePath])

  const cancelQueued = useCallback((id: string) => {
    if (!workspacePath) return
    void api.current.chatCancelQueued({ workspacePath, id })
  }, [workspacePath])

  const clearQueue = useCallback(() => {
    if (!workspacePath) return
    void api.current.chatClearQueue({ workspacePath })
  }, [workspacePath])

  const stop = useCallback(() => {
    if (!workspacePath) return
    void api.current.chatStop({ workspacePath })
  }, [workspacePath])

  return { messages, streamingIds, confirms, asks, plans, busy, queue, running, delegateActive, send, resolveConfirm, resolveAsk, resolvePlan, cancelQueued, clearQueue, stop }
}

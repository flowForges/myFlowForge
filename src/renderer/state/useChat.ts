import { useCallback, useEffect, useRef, useState } from 'react'
import { useHostReadySeq, useToolOutputFetchable } from './useHostKey'
import type { AgentContextMeta, AgentContextRef, AskAnswers, ChatConfirm, ChatEvent, ChatMessage, ChatSendPayload } from '@shared/types'
import { phaseLabel } from '@shared/types'
import type { CouncilTag } from '@shared/council'
import type { PlanReq } from '../components/PlanCard'
import { DESKTOP_TOOL_OUTPUT_CAP, omitLargeToolOutput, omitLargeToolOutputs } from '../views/chat/toolOutput'

export interface ChatQueueItem { id: string; text: string; source: string }

export interface AskReq { id: string; title: string; options?: { t: string; d: string }[]; agentName?: string; ts: string }
export interface ChatApi {
  messages: ChatMessage[]
  streamingIds: Set<string>
  /**
   * 历史还在路上(进会话 → `chat:history` 回来之前)。
   * ★★必须和「这个会话本来就没消息」分开。本机那个 RPC 几乎瞬时,所以这个区别一直不重要;
   *  走中转时同一个往返被放大成两秒,空屏就变成了「点进去什么都没有」(2026-09-17 真机)。
   */
  historyLoading: boolean
  confirms: ChatConfirm[]
  asks: AskReq[]
  plans: PlanReq[]
  busy: boolean
  queue: ChatQueueItem[]
  running: { id: string; text: string } | null
  send: (payload: Omit<ChatSendPayload, 'workspacePath' | 'sessionId'>) => void
  // answers/response 只在「请回答」的门(claude AskUserQuestion)上出现,它们就是用户选的选项 / 自己写的
  // 答案,必须一路带回 provider —— 光 decision:'allow' 等于没回答。
  resolveConfirm: (payload: { id: string; decision: 'allow' | 'deny'; value?: string; answers?: AskAnswers; response?: string }) => void
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

/** 一条消息在这一帧里攒下的流式增量(assistant-delta 的正文 + think-delta 的步骤/上下文)。 */
interface PendingDelta { text: string; steps: string[]; context?: AgentContextMeta; touchedThink: boolean; council?: CouncilTag }

/**
 * ★共商标签只补不改:历史重拉会丢掉引擎还没落盘的在途共商发言,之后的增量用 blankAi 重建它 —— 不补标签
 *  它就被当成普通消息画在共商区块外面。已有标签的消息原样返回(同一引用,不触发重渲)。
 */
const withCouncil = (x: ChatMessage, council?: CouncilTag): ChatMessage => council && !x.council ? { ...x, council } : x

/**
 * 增量的落地节拍:下一动画帧;★再挂一个 100ms 的兜底计时器,先到先刷。
 * ★★窗口隐藏时 rAF 整个停掉(Task 4 踩过):只靠 rAF 的话,藏着的窗口里增量会一直攒着不落地。
 *  非增量事件(done/error/工具…)到来时会先同步刷掉攒着的,所以顺序永远不乱、一个都不丢。
 */
function scheduleFlush(cb: () => void): () => void {
  let fired = false
  const run = () => { if (fired) return; fired = true; cancel(); cb() }
  const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(run) : null
  const timer = setTimeout(run, 100)
  const cancel = () => { if (raf !== null) cancelAnimationFrame(raf); clearTimeout(timer) }
  return () => { fired = true; cancel() }
}

export function useChat(
  workspacePath: string | undefined,
  sessionId: string | undefined,
  onModeChanged?: (mode: 'chat' | 'workflow', runId?: string) => void,
): ChatApi {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  /** 历史还在路上。★区分「还没到」和「这个会话本来就没消息」—— 两者在屏幕上长得一样。 */
  const [historyLoading, setHistoryLoading] = useState(false)
  const [streamingIds, setStreamingIds] = useState<Set<string>>(new Set())
  const [confirms, setConfirms] = useState<ChatConfirm[]>([])
  const [asks, setAsks] = useState<AskReq[]>([])
  const [plans, setPlans] = useState<PlanReq[]>([])
  const [busy, setBusy] = useState(false)
  const [queue, setQueue] = useState<ChatQueueItem[]>([])
  const [running, setRunning] = useState<{ id: string; text: string } | null>(null)
  const api = useRef(window.forge)
  /**
   * id → 下标。★★流式时每个 token 都要找「是哪条消息」,以前是 `some` + `map` 两遍全表扫;
   *  长会话几百条消息 × 每秒几十个 token。这里缓存的下标只对**当时那个数组**成立(`arr` 比引用),
   *  别处换了数组(拉历史、切会话)就整张重建 —— 不可能拿着过期下标改错消息。
   */
  const indexRef = useRef<{ arr: ChatMessage[]; idx: Map<string, number> } | null>(null)
  /** 找到 id 那条就用 `apply` 换掉;没有就在末尾追加 `create()`(不给 create = 没有就原样不动)。 */
  const upsertMsg = useCallback((m: ChatMessage[], id: string, apply: (x: ChatMessage) => ChatMessage, create?: () => ChatMessage): ChatMessage[] => {
    let c = indexRef.current
    if (!c || c.arr !== m) {
      const idx = new Map<string, number>()
      m.forEach((x, i) => { if (!idx.has(x.id)) idx.set(x.id, i) })
      c = { arr: m, idx }
    }
    const i = c.idx.get(id)
    let next: ChatMessage[]
    if (i === undefined) {
      if (!create) { indexRef.current = c; return m }
      const idx = new Map(c.idx).set(id, m.length)
      next = [...m, create()]
      indexRef.current = { arr: next, idx }
      return next
    }
    next = m.slice()
    next[i] = apply(m[i])
    indexRef.current = { arr: next, idx: c.idx }
    return next
  }, [])
  /** 这一帧攒着、还没落进 state 的流式增量(按消息 id)。见下面事件 effect 里的 flushDeltas。 */
  const pendingRef = useRef(new Map<string, PendingDelta>())
  const cancelFlushRef = useRef<(() => void) | null>(null)
  const dropPendingDeltas = useCallback(() => {
    cancelFlushRef.current?.()
    cancelFlushRef.current = null
    pendingRef.current.clear()
  }, [])
  const onModeChangedRef = useRef(onModeChanged)
  onModeChangedRef.current = onModeChanged

  // 重连后强制重跑下面那个 effect:它开头就把 confirms/asks 清空再从服务端拉一遍,
  // 正好就是「以服务端为准,不信本地缓存」。断线期间那边可能已经有人答了门,也可能新升了门。
  const hostReadySeq = useHostReadySeq()
  // ★实时大段工具输出只在**这台主机取得回来**时才摘(见 useToolOutputFetchable)。走 ref:事件 effect 不必为它重订阅。
  const toolOutputFetchable = useToolOutputFetchable()
  const fetchableRef = useRef(toolOutputFetchable)
  fetchableRef.current = toolOutputFetchable

  useEffect(() => {
    // asks 一直漏在重置之外 —— 换会话后上一个会话的提问卡还挂在新会话里(卡片本身按 workspace+session
    // 过滤事件,但已经进了 state 的那张不会自己走)。和 confirms 一起清。
    if (!workspacePath || !sessionId) { setMessages([]); setConfirms([]); setAsks([]); setPlans([]); setBusy(false); setQueue([]); setRunning(null); setHistoryLoading(false); return }
    setMessages([]); setStreamingIds(new Set()); setConfirms([]); setAsks([]); setPlans([]); setBusy(false); setQueue([]); setRunning(null)
    // ★★★进会话到历史回来之间,这一屏是**空的**。本机那个 RPC 几乎瞬时,所以一直没人注意到;
    //  走中转时同一个往返被放大成两秒,于是用户看到「点进去先是空白,过两秒才有内容」
    //  (2026-09-17 真机:另一台电脑连过来时)。空白和「这个会话本来就没消息」长得一模一样 ——
    //  分不清「还没到」和「没有」,正是这一类交互最糟的地方。
    // ★这个标志只管**历史**。门、队列那两个快照各拉各的,拉不到也不该让整屏显示成加载中。
    setHistoryLoading(true)
    let live = true
    // ★ 清空之后必须把主进程【还挂着的门】拉回来重建卡片。门是主进程的一个 Promise,一直阻塞着 provider;
    // 卡片只是这里的 state。切会话 / 离开再回来 / 刷新都会清掉这份 state,门却还在 —— 于是侧栏徽标和宠物
    // 一直喊「待确认」(它们各自的 state 不随聊天视图卸载),聊天里却连张能点的卡片都没有,那一轮就永远挂着,
    // 直到 CLI 超时。和下面 chatQueueState 的重新播种是同一个道理,当初只补了队列、漏了门。
    void api.current.chatGateState?.({ workspacePath })?.then((g) => {
      if (!live) return
      const sid = sessionId
      setConfirms(c => {
        const seen = new Set(c.map(x => x.id))
        return [...c, ...g.confirms.filter(x => x.sessionId === sid && !seen.has(x.id))
          .map(x => ({ id: x.id, title: x.title, where: x.where, questions: x.questions, ts: x.ts }))]
      })
      setAsks(a => {
        const seen = new Set(a.map(x => x.id))
        return [...a, ...g.asks.filter(x => x.sessionId === sid && !seen.has(x.id))
          .map(x => ({ id: x.id, title: x.title, options: x.options, agentName: x.agentName, ts: x.ts }))]
      })
    }).catch(() => { /* 拉不到快照不该拖垮聊天视图,live 事件仍然照常工作 */ })
    // The chat queue lives on the main side and its event only fires when the queue CHANGES. Switching
    // away and back resets this view to empty, so pull the current snapshot to re-seed THIS session's
    // lane — otherwise a message queued behind a running turn silently disappears on switch-back.
    void api.current.chatQueueState?.({ workspacePath })?.then((e) => {
      if (!live || e.workspacePath !== workspacePath) return
      const sid = sessionId
      setBusy(e.runningSessionIds.includes(sid))
      setQueue(e.queue.filter(q => q.sessionId === sid).map(q => ({ id: q.id, text: q.text, source: q.source })))
      const mine = e.runningTurns.find(r => r.sessionId === sid)
      setRunning(mine ? { id: mine.id, text: mine.text } : null)
    })
    // ★★大段工具输出**不跟着历史下发**,点开那张工具卡时再单独取(见 chat/toolOutput.ts)。
    //  用户 2026-10-03 报「点开会话都要加载一下」,剖了那个 1.2MB 的真会话:90% 的字节是
    //  `tools[].output`,而工具卡默认是折叠的 —— 下载下来只为了藏起来。省掉之后 1229KB → 197KB。
    //  ★老版本的远程主机不认这几个字段 = 照旧全量下发,只是慢一点,不会少东西(fail-open)。
    void api.current.chatHistory(workspacePath, sessionId, DESKTOP_TOOL_OUTPUT_CAP).then((h: ChatMessage[]) => {
      if (!live) return
      setHistoryLoading(false)
      // ★★攒着的增量**丢掉**,不是刷到 h 后面 —— 这和以前**逐字等价**:以前每个增量一到就落在旧数组上,
      //  随后被这一句 setMessages(h) 整个盖掉;现在只是它们还没来得及落地。若改成刷到 h 后面,
      //  h 那条在途消息(主进程 mergeLive 进来的)里已有的字会出现两遍。
      dropPendingDeltas()
      setMessages(h)
      // Restore the streaming affordance for an in-flight message folded in by the main-process live
      // buffer (ts:'' uniquely marks a not-yet-persisted assistant reply) — otherwise it renders as a
      // finished message with no spinner until the next delta upserts it.
      const inflight = h.filter(m => m.who === 'ai' && m.ts === '').map(m => m.id)
      if (inflight.length) setStreamingIds(new Set(inflight))
    }).catch(() => {
      // ★拉不回来也要**退出加载态** —— 否则永远转圈,而「一直加载中」比「空的」更让人干等。
      if (live) setHistoryLoading(false)
    })
    return () => { live = false }
  }, [workspacePath, sessionId, hostReadySeq, dropPendingDeltas])

  useEffect(() => {
    const off = api.current.onChatQueueEvent(e => {
      if (e.workspacePath !== workspacePath) return
      // The chat queue runs one turn PER SESSION concurrently, but each session's chat view must only
      // reflect ITS OWN lane — otherwise an idle session B shows session A's 执行中/排队 state and a 停止
      // button that would cancel A's turn. Filter the workspace-wide event down to this session.
      const sid = sessionId ?? ''
      setBusy(e.runningSessionIds.includes(sid))
      setQueue(e.queue.filter(q => q.sessionId === sid).map(q => ({ id: q.id, text: q.text, source: q.source })))
      const mine = e.runningTurns.find(r => r.sessionId === sid)
      setRunning(mine ? { id: mine.id, text: mine.text } : null)
    })
    return () => { off() }
  }, [workspacePath, sessionId])

  useEffect(() => {
    const blankAi = (id: string): ChatMessage => ({ id, who: 'ai', text: '', ts: '', think: { label: '主代理思考中…', steps: [] } })
    /**
     * ★★流式增量按动画帧合并:一帧里来 50 个 token 只 setMessages 一次(以前每个 token 一次,
     *  整条消息流跟着每个 token 重渲)。按消息 id 攒,Map 保留首次出现的顺序 = 原来逐条追加的顺序。
     * ★任何**非增量**事件到来前先同步刷掉攒着的(见下面 `flushDeltas()`),所以事件的先后关系和以前逐字一样。
     */
    const pending = pendingRef.current
    const flushDeltas = () => {
      cancelFlushRef.current?.()
      cancelFlushRef.current = null
      if (!pending.size) return
      const batch = [...pending]
      pending.clear()
      setStreamingIds(s => batch.every(([id]) => s.has(id)) ? s : batch.reduce((n, [id]) => n.add(id), new Set(s)))
      setMessages(m => batch.reduce((acc, [id, d]) => {
        const apply = (x0: ChatMessage): ChatMessage => {
          const x = withCouncil(x0, d.council)
          return d.touchedThink
          ? {
              ...x,
              text: x.text + d.text,
              context: mergeContext(x.context, d.context),
              think: { label: x.think?.label ?? '主代理思考中…', steps: [...(x.think?.steps ?? []), ...d.steps] },
            }
          : { ...x, text: x.text + d.text }
        }
        return upsertMsg(acc, id, apply, () => apply(blankAi(id)))
      }, m))
    }
    const queueDelta = (id: string, add: (d: PendingDelta) => void) => {
      let d = pending.get(id)
      if (!d) { d = { text: '', steps: [], touchedThink: false }; pending.set(id, d) }
      add(d)
      if (!cancelFlushRef.current) cancelFlushRef.current = scheduleFlush(() => { cancelFlushRef.current = null; flushDeltas() })
    }

    const off = api.current.onChatEvent((e: ChatEvent) => {
      if (e.workspacePath !== workspacePath || e.sessionId !== sessionId) return
      // NOTE: delta/done/error UPSERT by id. A turn can start (assistant-start) while this chat view is
      // unmounted — e.g. a command sent from the pet while the app is on the home view. When the view then
      // opens mid-turn it never saw assistant-start, so a plain `.map` would drop every delta/done and the
      // reply would never appear. Creating the message on first sight of any of its events fixes that.
      if (e.type === 'assistant-delta') { queueDelta(e.id, d => { d.text += e.text; d.council ??= e.council }); return }
      if (e.type === 'think-delta') {
        queueDelta(e.id, d => { d.touchedThink = true; d.steps.push(e.text); d.context = mergeContext(d.context, e.context); d.council ??= e.council })
        return
      }
      flushDeltas()
      if (e.type === 'user') setMessages(m => [...m, e.message])
      else if (e.type === 'assistant-start') {
        setStreamingIds(s => new Set(s).add(e.id))
        setMessages(m => upsertMsg(m, e.id, x => x, () => ({ ...blankAi(e.id), model: e.model, context: e.context, startedAt: Date.now(), ...(e.council ? { council: e.council } : {}) })))
      }
      else if (e.type === 'assistant-replace') {
        // Overwrite (not append) — the provider sent the authoritative full reply with real newlines.
        setStreamingIds(s => s.has(e.id) ? s : new Set(s).add(e.id))
        setMessages(m => upsertMsg(m, e.id, x => ({ ...withCouncil(x, e.council), text: e.text }), () => withCouncil({ ...blankAi(e.id), text: e.text }, e.council)))
      }
      // 「你的选择」锚在这条在途回复里答的那个位置(ChatMessage.answers)。上面的 flushDeltas() 已经把
      // 攒着的增量先落进正文 —— `at` 是主进程那边的正文长度,两边必须对得上。
      else if (e.type === 'answer-note') {
        setStreamingIds(s => s.has(e.id) ? s : new Set(s).add(e.id))
        const add = (x: ChatMessage): ChatMessage => x.answers?.some(a => a.at === e.at && a.text === e.text)
          ? x
          : { ...x, answers: [...(x.answers ?? []), { at: e.at, text: e.text }] }
        setMessages(m => upsertMsg(m, e.id, add, () => add(blankAi(e.id))))
      }
      // 这一轮换阶段了(在想 ↔ 在自动压缩)。只改 think 折叠块的标题 —— 压缩期间 provider 一个 token
      // 都不吐,不换标题的话界面和卡死没有区别。收尾时 done 会用落盘的那条消息整个替换掉它。
      else if (e.type === 'phase') {
        setMessages(m => upsertMsg(m, e.id, x => x.think ? { ...x, think: { ...x.think, label: phaseLabel(e.phase) } } : x))
      }
      else if (e.type === 'subagent') {
        setStreamingIds(s => s.has(e.id) ? s : new Set(s).add(e.id))
        const upsert = (x: ChatMessage): ChatMessage => {
          const list = x.subagents ?? []
          const i = list.findIndex(s => s.id === e.sub.id)
          return { ...x, subagents: i >= 0 ? list.map(s => s.id === e.sub.id ? e.sub : s) : [...list, e.sub] }
        }
        setMessages(m => upsertMsg(m, e.id, upsert, () => upsert(blankAi(e.id))))
      }
      // Main-agent tool call (执行 block): upsert by tool id, preserving execution order.
      else if (e.type === 'tool-activity') {
        setStreamingIds(s => s.has(e.id) ? s : new Set(s).add(e.id))
        // ★大段输出不进 state,和历史同一个阈值同一种形状(见 omitLargeToolOutput);点开时 ToolBlock 再去取。
        const tool = fetchableRef.current ? omitLargeToolOutput(e.tool) : e.tool
        const upsert = (x: ChatMessage): ChatMessage => {
          const list = x.tools ?? []
          const i = list.findIndex(t => t.id === tool.id)
          return { ...x, tools: i >= 0 ? list.map(t => t.id === tool.id ? tool : t) : [...list, tool] }
        }
        setMessages(m => upsertMsg(m, e.id, upsert, () => upsert(blankAi(e.id))))
      }
      // Live delegate-batch progress block (fire-and-forget sub-agents keep running after the main turn
      // ends). Main-side broadcasts these (handlers.ts onBatchStart/onAgentState/onComplete) but they were
      // previously dropped here, so the user never saw the background sub-agents execute. Live-only: the
      // block message (id `delegate-batch:<runId>`, blank text, carries `delegate`) is never persisted —
      // the aggregated result arrives afterwards as its own `done` message.
      else if (e.type === 'delegate-start') {
        setMessages(m => upsertMsg(m, e.id, x => ({ ...x, delegate: e.batch }), () => ({ id: e.id, who: 'ai', text: '', ts: '', delegate: e.batch })))
      }
      else if (e.type === 'delegate-progress') {
        setMessages(m => upsertMsg(m, e.id, x => {
          if (!x.delegate) return x
          const agents = x.delegate.agents.map(a => a.agentId === e.agentId
            ? { ...a, status: e.status, output: e.output ?? a.output, activity: e.activity ?? a.activity }
            : a)
          return { ...x, delegate: { ...x.delegate, agents } }
        }))
      }
      else if (e.type === 'delegate-done') {
        setMessages(m => upsertMsg(m, e.id, x => x.delegate
          ? { ...x, delegate: { ...x.delegate, done: true, agents: x.delegate.agents.map(a => a.status === 'run' ? { ...a, status: 'ok' as const } : a) } }
          : x))
      }
      else if (e.type === 'done') {
        // `e.message` is the freshly-persisted turn (from main) and REPLACES the streaming stub, so carry
        // the renderer-captured startedAt forward and stamp endedAt here — otherwise the turn timer loses
        // its start and can't show a 用时 total.
        // ★落盘的那条带着 tools 全文 —— 同样按阈值摘掉,点开时从磁盘取。
        const endedAt = Date.now()
        const msg = fetchableRef.current ? omitLargeToolOutputs(e.message) : e.message
        setMessages(m => upsertMsg(m, msg.id, x => ({ ...msg, startedAt: x.startedAt ?? msg.startedAt, endedAt }), () => ({ ...msg, endedAt })))
        setStreamingIds(s => { const n = new Set(s); n.delete(e.message.id); return n })
      }
      else if (e.type === 'error') {
        const endedAt = Date.now()
        // ★被「结束」取消的共商发言:引擎只广播 {error:'cancelled'}、不落盘(普通对话的 error 总带 message)。
        //  它不是失败 —— 把流式占位拿掉,不留错误气泡;没见过 start 的也不凭空造一条。
        const cancelledCouncil = e.error === 'cancelled' && !e.message
        setMessages(m => {
          if (cancelledCouncil) {
            const cur = m.find(x => x.id === e.id)
            if (!cur) return m
            if (cur.council) return m.filter(x => x.id !== e.id)
          }
          return upsertMsg(m, e.id,
            x => ({ ...x, text: x.text || `错误: ${e.error}`, think: undefined, endedAt }),
            () => ({ ...blankAi(e.id), text: `错误: ${e.error}`, think: undefined, endedAt }))
        })
        setStreamingIds(s => { const n = new Set(s); n.delete(e.id); return n })
      }
      // 按 id 去重:挂载时的 chatGateState 快照可能已经把同一个门种下了(广播恰好在快照回来之后到达),
      // 无脑 append 会画出两张一模一样的卡。
      else if (e.type === 'confirm-request') setConfirms(c => c.some(x => x.id === e.id) ? c : [...c, { id: e.id, title: e.title, where: e.where, questions: e.questions, ts: new Date().toISOString() }])
      else if (e.type === 'confirm-resolved') setConfirms(c => c.filter(x => x.id !== e.id))
      else if (e.type === 'ask-request') setAsks(a => a.some(x => x.id === e.id) ? a : [...a, { id: e.id, title: e.title, options: e.options, agentName: e.agentName, ts: new Date().toISOString() }])
      else if (e.type === 'ask-resolved') setAsks(a => a.filter(x => x.id !== e.id))
      else if (e.type === 'plan-request') setPlans(p => [...p, { id: e.id, approach: e.approach, stages: e.stages, hooks: e.hooks, allProjects: e.allProjects, task: e.task, workflowId: e.workflowId, workflowName: e.workflowName, workflowOptions: e.workflowOptions, recommendReason: e.recommendReason, ts: new Date().toISOString() }])
      else if (e.type === 'plan-resolved') setPlans(p => p.filter(x => x.id !== e.id))
      else if (e.type === 'mode-changed') onModeChangedRef.current?.(e.mode, e.runId)
    })
    return () => { off(); dropPendingDeltas() }
    // re-subscribe when the active workspace changes — otherwise the listener
    // closes over a stale workspacePath and silently drops every live event.
  }, [workspacePath, sessionId, upsertMsg, dropPendingDeltas])

  const send = useCallback((payload: Omit<ChatSendPayload, 'workspacePath' | 'sessionId'>) => {
    if (!workspacePath || !sessionId) return
    void api.current.sendChat({ ...payload, workspacePath, sessionId })
  }, [workspacePath, sessionId])

  const resolveConfirm = useCallback((payload: { id: string; decision: 'allow' | 'deny'; value?: string; answers?: AskAnswers; response?: string }) => {
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
    void api.current.chatStop({ workspacePath, sessionId })
  }, [workspacePath, sessionId])

  return { messages, streamingIds, historyLoading, confirms, asks, plans, busy, queue, running, send, resolveConfirm, resolveAsk, resolvePlan, cancelQueued, clearQueue, stop }
}

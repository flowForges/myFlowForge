import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { CH } from '../../../src/main/ipc/channels'
import type { AskQuestion, ChatSession, SessionsFile, WorkspaceMeta } from '../../../src/shared/types'
import { useConn } from '../net/conn'
import { useUnreadSet } from './useUnread'

/**
 * 一台主机上的「有什么」:工作区 → 会话 → 挂着的门。
 *
 * 门单独拎出来在这一层维护(而不是进了某个会话才去查),因为**手机端存在的唯一理由**就是
 * 「代理停在门上而你不在电脑前」。要一打开 app 就看得见有几道门,就得在会话列表之前先知道。
 */

export type GateKind =
  /** 执行确认:允许 / 拒绝 */
  | 'confirm'
  /** 选择题(claude 的 AskUserQuestion):一到四题,每题若干选项 */
  | 'questions'
  /** 委派子代理的 forge_ask:有选项就是单选,没选项就是自由输入 */
  | 'ask'

export type Gate = {
  id: string
  kind: GateKind
  wsPath: string
  sessionId: string
  title: string
  where?: string
  questions?: AskQuestion[]
  options?: { t: string; d: string }[]
  agentName?: string
  /** 收到这道门的时刻(毫秒)。用来显示「等待 03:12」—— 门等得越久越该显眼。 */
  since: number
}

export type WsGroup = {
  ws: WorkspaceMeta
  sessions: ChatSession[]
  activeSessionId: string
}

export type Selection = { wsPath: string; sessionId: string }

export type Store = {
  groups: WsGroup[]
  gates: Gate[]
  /** 首帧还没拉到数据。空态和「加载中」必须分得开,否则会闪一下「什么都没有」。 */
  loading: boolean
  error: string | null
  refresh: () => void
  gatesFor: (wsPath: string, sessionId?: string) => Gate[]
  /** 答一道门。答完不等广播,本地先摘掉 —— 但摘的是 id,重复答同一个 id 不会出事。 */
  answerGate: (
    g: Gate,
    a: { decision: 'allow' | 'deny'; answers?: Record<string, string[]>; response?: string; choice?: number },
  ) => Promise<void>
  wsName: (path: string) => string
  sessionTitle: (wsPath: string, sessionId: string) => string
  /** 当前在看哪个会话。切主机会清空(路径在新主机上不存在)。 */
  selected: Selection | null
  select: (sel: Selection | null) => void
  /** 哪些会话「跑完了但你没看」。key 由 @shared/chat/unread 的 key() 生成,别自己拼。 */
  unread: ReadonlySet<string>
}

const StoreCtx = createContext<Store | null>(null)

type ChatEvtLike = {
  workspacePath?: string
  sessionId?: string
  type?: string
  id?: string
  title?: string
  where?: string
  questions?: AskQuestion[]
  options?: { t: string; d: string }[]
  agentName?: string
}

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const { invoke, on, online, epoch } = useConn()
  const [groups, setGroups] = useState<WsGroup[]>([])
  const [gateMap, setGateMap] = useState<Map<string, Gate>>(() => new Map())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const [selected, setSelected] = useState<Selection | null>(null)

  // ★答掉/收到 resolved 的门 id。初始快照要拿它过滤:
  //  快照那个 promise 完全可能在实时 `confirm-resolved` **之后**才 resolve,
  //  不过滤就会把刚刚答完的门又画回来(桌面端 B 阶段栽过一次,现象是状态条闪一下就没了)。
  const resolved = useRef(new Set<string>())

  // 切主机时把一切清空。上一台机器的工作区路径在新主机上多半根本不存在。
  useEffect(() => {
    setGroups([])
    setGateMap(new Map())
    setLoading(true)
    setError(null)
    setSelected(null)
    resolved.current = new Set()
  }, [epoch])

  const dropGate = useCallback((id: string) => {
    resolved.current.add(id)
    setGateMap((m) => {
      if (!m.has(id)) return m
      const n = new Map(m)
      n.delete(id)
      return n
    })
  }, [])

  const addGate = useCallback((g: Gate) => {
    if (resolved.current.has(g.id)) return
    setGateMap((m) => {
      const n = new Map(m)
      n.set(g.id, g)
      return n
    })
  }, [])

  // ★先订阅,再拉快照。反过来写就会漏掉两者之间到达的事件 ——
  //  那段空窗正好是「连上的一瞬间」,而代理往往就是在那时候还挂着门。
  useEffect(() => {
    const offChat = on(CH.chatEvent, (payload) => {
      const e = payload as ChatEvtLike
      if (!e || typeof e !== 'object') return
      const wsPath = e.workspacePath ?? ''
      const sessionId = e.sessionId ?? ''
      if (e.type === 'confirm-request' && e.id) {
        addGate({
          id: e.id,
          // questions 非空 = 这不是「批准执行」而是「请回答」(见 shared/types.ts 的 ChatEvent 注释)
          kind: e.questions && e.questions.length ? 'questions' : 'confirm',
          wsPath,
          sessionId,
          title: e.title ?? '',
          where: e.where,
          questions: e.questions,
          since: Date.now(),
        })
      } else if (e.type === 'ask-request' && e.id) {
        addGate({
          id: e.id,
          kind: 'ask',
          wsPath,
          sessionId,
          title: e.title ?? '',
          options: e.options,
          agentName: e.agentName,
          since: Date.now(),
        })
      } else if ((e.type === 'confirm-resolved' || e.type === 'ask-resolved') && e.id) {
        dropGate(e.id)
      }
    })
    const offSessions = on(CH.sessionsChanged, (payload) => {
      const p = payload as { workspacePath?: string; file?: SessionsFile }
      if (!p?.workspacePath || !p.file) return
      setGroups((gs) =>
        gs.map((g) =>
          g.ws.path === p.workspacePath
            ? { ...g, sessions: p.file!.sessions, activeSessionId: p.file!.activeSessionId }
            : g,
        ),
      )
    })
    return () => {
      offChat()
      offSessions()
    }
  }, [on, addGate, dropGate])

  useEffect(() => {
    if (!online) return
    let alive = true
    setError(null)
    void (async () => {
      try {
        const wss = (await invoke(CH.workspacesList)) as WorkspaceMeta[]
        if (!alive) return
        const live = wss.filter((w) => !w.archived)
        // 会话与门逐工作区拉。allSettled 而不是 all —— 一个工作区读失败(比如目录被删了)
        // 不该让整个列表变成空白。
        const per = await Promise.allSettled(
          live.map(async (ws) => {
            const file = (await invoke(CH.sessionList, [ws.path])) as SessionsFile
            const snap = (await invoke(CH.chatGateState, [{ workspacePath: ws.path }])) as {
              confirms: { id: string; sessionId: string; title: string; where?: string; questions?: AskQuestion[]; ts: string }[]
              asks: { id: string; sessionId: string; title: string; options?: { t: string; d: string }[]; agentName?: string; ts: string }[]
            }
            return { ws, file, snap }
          }),
        )
        if (!alive) return
        const nextGroups: WsGroup[] = []
        const snapshotGates: Gate[] = []
        per.forEach((r, i) => {
          if (r.status !== 'fulfilled') {
            nextGroups.push({ ws: live[i], sessions: [], activeSessionId: '' })
            return
          }
          const { ws, file, snap } = r.value
          nextGroups.push({ ws, sessions: file.sessions ?? [], activeSessionId: file.activeSessionId ?? '' })
          for (const cf of snap?.confirms ?? [])
            snapshotGates.push({
              id: cf.id,
              kind: cf.questions && cf.questions.length ? 'questions' : 'confirm',
              wsPath: ws.path,
              sessionId: cf.sessionId,
              title: cf.title,
              where: cf.where,
              questions: cf.questions,
              since: Date.parse(cf.ts) || Date.now(),
            })
          for (const ak of snap?.asks ?? [])
            snapshotGates.push({
              id: ak.id,
              kind: 'ask',
              wsPath: ws.path,
              sessionId: ak.sessionId,
              title: ak.title,
              options: ak.options,
              agentName: ak.agentName,
              since: Date.parse(ak.ts) || Date.now(),
            })
        })
        setGroups(nextGroups)
        // 合并而不是替换:实时事件先到的那些门必须留着,快照里已被答掉的必须丢掉。
        setGateMap((m) => {
          const n = new Map(m)
          for (const g of snapshotGates) if (!resolved.current.has(g.id)) n.set(g.id, g)
          return n
        })
        setLoading(false)
      } catch (e) {
        if (!alive) return
        setError(e instanceof Error ? e.message : String(e))
        setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [online, invoke, epoch, tick])

  const gates = useMemo(() => [...gateMap.values()].sort((a, b) => a.since - b.since), [gateMap])

  // 进 app 默认落在哪个会话:**有门就落到那道门所在的会话**,否则落到最近说过话的那个。
  // 这条是原型定的(index.html「默认位」),也是手机端存在的理由的直接推论。
  useEffect(() => {
    if (selected || !groups.length) return
    const g = gates[0]
    if (g) {
      setSelected({ wsPath: g.wsPath, sessionId: g.sessionId })
      return
    }
    let best: { sel: Selection; at: number } | null = null
    for (const grp of groups)
      for (const ss of grp.sessions) {
        const at = ss.lastMessageAt ?? ss.createdAt
        if (!best || at > best.at) best = { sel: { wsPath: grp.ws.path, sessionId: ss.id }, at }
      }
    if (best) setSelected(best.sel)
  }, [groups, gates, selected])

  const answerGate = useCallback<Store['answerGate']>(
    async (g, a) => {
      // 先摘本地再发请求:门的响应在服务端要等 provider 回过神来,中间那一两秒卡片还杵在那里
      // 会让人以为没点上,于是再点一次。
      dropGate(g.id)
      try {
        await invoke(CH.chatResolve, [
          {
            id: g.id,
            decision: a.decision,
            answers: a.answers,
            response: a.response,
            choice: a.choice,
            workspacePath: g.wsPath,
          },
        ])
      } catch (e) {
        // ★请求没送到(断网、超时),门在服务端**还挂着**。乐观摘掉的卡片必须放回来 ——
        //  不放回来的话,人以为自己答完了,实际那条命令还卡在那里等着,而他已经把手机锁上了。
        resolved.current.delete(g.id)
        setGateMap((m) => {
          const n = new Map(m)
          n.set(g.id, g)
          return n
        })
        throw e
      }
    },
    [invoke, dropGate],
  )

  const unread = useUnreadSet(selected)

  const value = useMemo<Store>(() => {
    const nameOf = new Map(groups.map((g) => [g.ws.path, g.ws.name]))
    return {
      groups,
      gates,
      loading,
      error,
      refresh: () => setTick((t) => t + 1),
      gatesFor: (wsPath, sessionId) =>
        gates.filter((g) => g.wsPath === wsPath && (sessionId === undefined || g.sessionId === sessionId)),
      answerGate,
      wsName: (p) => nameOf.get(p) ?? p.split('/').pop() ?? p,
      sessionTitle: (wsPath, sessionId) =>
        groups.find((g) => g.ws.path === wsPath)?.sessions.find((s) => s.id === sessionId)?.title ?? '会话',
      selected,
      select: setSelected,
      unread,
    }
  }, [groups, gates, loading, error, answerGate, selected, unread])

  return <StoreCtx.Provider value={value}>{children}</StoreCtx.Provider>
}

export function useStore(): Store {
  const s = useContext(StoreCtx)
  if (!s) throw new Error('useStore 必须在 StoreProvider 里用')
  return s
}

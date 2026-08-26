import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { CH } from '../../../src/main/ipc/channels'
import type { AskQuestion, ChatSession, SessionsFile, WorkspaceMeta } from '../../../src/shared/types'
import { useConn } from '../net/conn'
import { useRunningSet } from './useRunning'
import { useUnreadSet } from './useUnread'
import { toggleExpanded, ensureExpanded } from '@shared/ui/expanded'
import { loadExpanded, saveExpanded } from './expanded'

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
  /**
   * 当前**选中**哪个会话 = 「进对话屏会打开哪一条」。切主机会清空(路径在新主机上不存在)。
   *
   * ★它**不等于**「你正看着哪一条」。根屏换成会话列表之后,冷启动就会自动选中一条
   *  (见下面那个 effect),而那一刻你看的是列表,一个字都没读。判断未读要用 `viewing`。
   */
  selected: Selection | null
  select: (sel: Selection | null) => void
  /**
   * 对话屏**正在前台显示**的那个会话;不在对话屏上就是 null。
   *
   * ★只有对话屏该写它(`app/chat.tsx` 的 useFocusEffect:聚焦时写、失焦/卸载时写回 null)。
   *  未读逻辑吃的是这个值 —— 拿 `selected` 喂进去的话,自动选中的那条会话**永远不会**变未读:
   *  它在后台跑挂了你也看不见任何徽章,而那正是手机端最该告诉你的一件事(设计文档 §4.5)。
   */
  viewing: Selection | null
  setViewing: (sel: Selection | null) => void
  /** 哪些会话「跑完了但你没看」。key 由 @shared/chat/unread 的 key() 生成,别自己拼。 */
  unread: ReadonlySet<string>
  /** 哪些会话正在跑。key 由 `runningKey(wsPath, sessionId)` 生成,别拿裸 sessionId 查。 */
  running: ReadonlySet<string>
  /**
   * 哪些工作区分组是展开的。★交互**照抄电脑端左侧栏**(见 @shared/ui/expanded):
   * 点一下切换、能同时展开多个、存盘、进一个区时自动展开。
   */
  expanded: ReadonlySet<string>
  toggleWs: (path: string) => void
  /** 进入某个区(点它下面的会话 / 在它里面新建会话)时自动展开,不用点第二下。 */
  ensureWs: (path: string) => void
  /** 置顶 / 取消置顶。置顶的排在最前(见 index.tsx 的 ordered) —— 那是你手动钉的,不是状态。
   *  ★服务端有上限,超了会 throw(`最多只能置顶 N 个工作区`)——那句话原样往上抛,不吞。 */
  setPinned: (wsPath: string, pinned: boolean) => Promise<void>
  /** 归档 = 只读封存。归档后从列表消失,回去的路在 设置 → 已归档的工作区。 */
  archive: (wsPath: string) => Promise<void>
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
  // ★和 `selected` 是两回事,别合并:`selected` 是「进去会打开哪条」,这个是「此刻屏幕上是哪条」。
  //  默认 null = 「谁都没在看」,所以根屏(会话列表)上任何会话跑完都算未读。
  const [viewing, setViewing] = useState<Selection | null>(null)

  // 哪些工作区分组展开着。★切主机时**不清空**:存的是路径,新主机上的路径多半根本对不上,
  //  于是那台机器的工作区自然全是收起的 —— 而切回来时你原来展开的那几个还在。
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  // 开机读一次存盘。★读回来之后**合并**而不是替换:读盘是异步的,这几百毫秒里用户
  //  完全可能已经点开了一个区(或者点进了一条会话触发 ensureWs),整体替换会把它又收回去。
  useEffect(() => {
    let alive = true
    void (async () => {
      const ids = await loadExpanded()
      if (!alive || !ids.length) return
      setExpanded((s) => new Set([...s, ...ids]))
    })()
    return () => { alive = false }
  }, [])

  const toggleWs = useCallback((path: string) => {
    setExpanded((s) => { const n = toggleExpanded(s, path); void saveExpanded([...n]); return n })
  }, [])
  const ensureWs = useCallback((path: string) => {
    // 已经展开着就返回同一个引用(见 @shared/ui/expanded),据此跳过一次白存盘 ——
    // 点每一条会话都会调它,不跳的话等于每次点击都写一遍 AsyncStorage。
    setExpanded((s) => { const n = ensureExpanded(s, path); if (n !== s) void saveExpanded([...n]); return n })
  }, [])

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
    setViewing(null)
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

  // ★拆成一个稳定的 useCallback,而不是留在 `value` 那个 useMemo 里就地拼 —— setPinned/archive
  //  两个动作、以及下面 `workspaces:changed` 的订阅都要在成功/收到广播之后拉一遍新列表,
  //  不能只有 UI 手边那个 `store.refresh()` 能调它。定义提到这个文件前面,好让下面这个订阅
  //  effect 能直接引用,不用另开一个 effect。
  const refresh = useCallback(() => setTick((t) => t + 1), [])

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
    // ★工作区**列表本身**变了(改名/编辑/导入/归档/恢复/删除/移除 —— 见 `src/main/ipc/handlers.ts`
    //  逐个 `broadcast(CH.workspacesChanged, {})` 的调用点),不是某个工作区里的会话变了,
    //  所以走 `refresh()` 重拉一份全量快照,不是像上面 `sessionsChanged` 那样就地 patch。
    //  这七个调用点全是「人手动做了一件结构性的事」,不是随消息高频触发的事件,重拉的代价可以接受。
    //  ★不订阅这条的后果:归档/恢复/改名如果发生在**另一台设备**(电脑端窗口、另一部手机)上,
    //  这台手机的列表永远不会跟上,直到 `tick`/`epoch` 被别的事顺带碰一下才纠正过来。
    //  老主机没有这条广播 —— 收不到就什么也不做,退化成「等下一次别的原因触发的 refresh」,不会报错。
    const offWorkspaces = on(CH.workspacesChanged, () => refresh())
    return () => {
      offChat()
      offSessions()
      offWorkspaces()
    }
  }, [on, addGate, dropGate, refresh])

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

  // ★喂给未读的是 `viewing` 不是 `selected` —— 见 Store 类型上这两个字段的注释。
  const unread = useUnreadSet(viewing)
  const wsPaths = useMemo(() => groups.map((g) => g.ws.path), [groups])
  const running = useRunningSet(wsPaths)

  const setPinned = useCallback<Store['setPinned']>(
    async (wsPath, pinned) => {
      // ★这里不 try/catch —— 抛出去让调用方(index.tsx)接住,那句「最多只能置顶 N 个」
      //  要原样显示给人看,吞在这一层等于永远没人看得见。
      await invoke(CH.workspacesSetPinned, [{ path: wsPath, pinned }])
      refresh()
    },
    [invoke, refresh],
  )

  const archive = useCallback<Store['archive']>(
    async (wsPath) => {
      await invoke(CH.workspaceArchive, [wsPath])
      refresh()
    },
    [invoke, refresh],
  )

  const value = useMemo<Store>(() => {
    const nameOf = new Map(groups.map((g) => [g.ws.path, g.ws.name]))
    return {
      groups,
      gates,
      loading,
      error,
      refresh,
      gatesFor: (wsPath, sessionId) =>
        gates.filter((g) => g.wsPath === wsPath && (sessionId === undefined || g.sessionId === sessionId)),
      answerGate,
      wsName: (p) => nameOf.get(p) ?? p.split('/').pop() ?? p,
      sessionTitle: (wsPath, sessionId) =>
        groups.find((g) => g.ws.path === wsPath)?.sessions.find((s) => s.id === sessionId)?.title ?? '会话',
      selected,
      select: setSelected,
      viewing,
      setViewing,
      unread,
      running,
      expanded,
      toggleWs,
      ensureWs,
      setPinned,
      archive,
    }
    // ★新加字段必须同时加进这个依赖数组 —— 漏了的话 value 不会重建,
    //  界面拿着上一份 `expanded` 静默不更新(点了分组头什么都不动)。
  }, [
    groups, gates, loading, error, refresh, answerGate, selected, viewing, unread, running, expanded, toggleWs,
    ensureWs, setPinned, archive,
  ])

  return <StoreCtx.Provider value={value}>{children}</StoreCtx.Provider>
}

export function useStore(): Store {
  const s = useContext(StoreCtx)
  if (!s) throw new Error('useStore 必须在 StoreProvider 里用')
  return s
}

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Platform } from 'react-native'
import { connectHost, type HostClient, type HostState } from './hostClient'
import {
  loadActiveHostId,
  loadHosts,
  newHostId,
  saveActiveHostId,
  saveHosts,
  type MobileHost,
} from './hosts'
import appJson from '../../app.json'

/** 跟 daemon 比主版本号用的就是这个。app.json 是单一来源,别再抄一份常量出来。 */
export const CLIENT_VERSION: string = appJson.expo.version

const CLIENT_LABEL = Platform.select({ ios: 'iPhone', android: 'Android 手机', default: '手机(浏览器)' }) as string

type EventCb = (payload: unknown) => void

export type Conn = {
  hosts: MobileHost[]
  activeHost: MobileHost | null
  /** 还没读完本地存的主机列表 —— 这段时间不该闪一下「还没有主机」的空态 */
  loading: boolean
  state: HostState | null
  /** 对面 ready 时报上来的方法表。对不上的功能置灰(决策 B-2) */
  methods: ReadonlySet<string>
  /** 只有 ready 才算在线。retrying / connecting 一律**显式**不在线,绝不拿缓存假装。 */
  online: boolean
  invoke: (ch: string, args?: unknown[]) => Promise<unknown>
  on: (channel: string, cb: EventCb) => () => void
  addHost: (h: Omit<MobileHost, 'id' | 'lastConnectedAt'>) => Promise<MobileHost>
  removeHost: (id: string) => Promise<void>
  selectHost: (id: string | null) => Promise<void>
  /** 手动重连(failed 之后不会自动重试) */
  reconnect: () => void
  /**
   * 把内存里记着的主机**全部**忘掉。「清除本地数据」专用。
   *
   * ★为什么不是 `selectHost(null)` 就够:那个只把 `activeId` 置空,`hosts`(**连令牌一起**)
   *  还原封不动躺在 state 里。于是清完之后设置屏的「其他主机」照样列着每一台,点一下就用
   *  内存里的令牌连上去了;更糟的是接下来任何一次 `addHost` 会走
   *  `saveHosts([...hosts, 新的])` —— 把那份「已经清掉」的清单连令牌一起**写回磁盘**。
   */
  forgetAll: () => void
  /** 切主机时递增。视图拿它当 key,强制把上一台机器的工作区/会话全部丢掉。 */
  epoch: number
}

const ConnCtx = createContext<Conn | null>(null)

export function ConnProvider({ children }: { children: React.ReactNode }) {
  const [hosts, setHosts] = useState<MobileHost[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [state, setState] = useState<HostState | null>(null)
  const [epoch, setEpoch] = useState(0)

  const clientRef = useRef<HostClient | null>(null)
  const listeners = useRef(new Map<string, Set<EventCb>>()).current
  // 手动重连靠改这个数触发 effect 重跑;直接调 open() 会绕过 state 的清理。
  const [attemptKey, setAttemptKey] = useState(0)

  useEffect(() => {
    let alive = true
    void (async () => {
      const [hs, aid] = await Promise.all([loadHosts(), loadActiveHostId()])
      if (!alive) return
      setHosts(hs)
      // 存的 activeId 指向一台已经删掉的主机时,退回「没选」而不是让整个界面对着 null 主机转圈。
      setActiveId(hs.some((h) => h.id === aid) ? aid : null)
      setLoading(false)
    })()
    return () => {
      alive = false
    }
  }, [])

  const activeHost = useMemo(() => hosts.find((h) => h.id === activeId) ?? null, [hosts, activeId])

  useEffect(() => {
    if (!activeHost) {
      setState(null)
      return
    }
    const c = connectHost({
      url: activeHost.url,
      token: activeHost.token || undefined,
      // 有公钥就加密,再有中转地址就走中转。三档的判据全在 `hostClient.ts` 里,这儿只是传下去。
      pubKey: activeHost.pubKey || undefined,
      relayUrl: activeHost.relay || undefined,
      clientVersion: CLIENT_VERSION,
      clientLabel: CLIENT_LABEL,
      onState: (s) => setState(s),
      onEvent: (ch, payload) => {
        const set = listeners.get(ch)
        if (!set) return
        // 回调里删自己(比如答完门就退订)会在遍历中改集合,先拷一份。
        for (const cb of [...set]) cb(payload)
      },
    })
    clientRef.current = c
    setState(c.state())
    return () => {
      clientRef.current = null
      c.close()
    }
    // ★依赖里必须带上 pubKey / relay:它们变了就是**换了一条链路**(明文↔加密、直连↔中转),
    //  不重连的话新配置要等到下一次手动重连才生效 —— 而用户刚重扫过码,会以为没保存上。
  }, [activeHost?.id, activeHost?.url, activeHost?.token, activeHost?.pubKey, activeHost?.relay, attemptKey, listeners])

  const invoke = useCallback(async (ch: string, args: unknown[] = []) => {
    const c = clientRef.current
    if (!c) throw new Error('未连接任何主机')
    return c.invoke(ch, args)
  }, [])

  const on = useCallback(
    (channel: string, cb: EventCb) => {
      let set = listeners.get(channel)
      if (!set) {
        set = new Set()
        listeners.set(channel, set)
      }
      set.add(cb)
      return () => {
        set!.delete(cb)
        if (set!.size === 0) listeners.delete(channel)
      }
    },
    [listeners],
  )

  const addHost = useCallback(
    async (h: Omit<MobileHost, 'id' | 'lastConnectedAt'>) => {
      const host: MobileHost = { ...h, id: newHostId(), lastConnectedAt: 0 }
      const next = [...hosts, host]
      setHosts(next)
      await saveHosts(next)
      return host
    },
    [hosts],
  )

  const removeHost = useCallback(
    async (id: string) => {
      const next = hosts.filter((h) => h.id !== id)
      setHosts(next)
      await saveHosts(next)
      if (activeId === id) {
        setActiveId(null)
        setEpoch((e) => e + 1)
        await saveActiveHostId(null)
      }
    },
    [hosts, activeId],
  )

  const selectHost = useCallback(
    async (id: string | null) => {
      if (id === activeId) return
      setActiveId(id)
      // ★切主机必须把视图重置掉。上一台机器的工作区路径在新主机上通常根本不存在,
      //  留在原地会让人问出「我怎么确认这个对话是连的哪台」—— 桌面端就是栽在这。
      setEpoch((e) => e + 1)
      await saveActiveHostId(id)
    },
    [activeId],
  )

  const reconnect = useCallback(() => setAttemptKey((k) => k + 1), [])

  const forgetAll = useCallback(() => {
    // ★**只动内存,一个字节都不写盘。** 磁盘那份由 `clearLocalData()` 负责清;
    //  这里再调一次 saveHosts/saveActiveHostId 是危险的 —— 中间只要有一次是拿旧 state
    //  拼出来的,写回去的就是那份本该消失的清单(带令牌)。少写一次永远比写错一次安全。
    setHosts([])
    setActiveId(null)
    // 连接的 effect 会因为 activeHost 变 null 自己把状态收干净;这里先置空是为了这一帧就别再
    // 显示「已连接」——「清除」之后界面上还挂着一枚绿点,那是最难解释的一种残留。
    setState(null)
    // ★epoch 必须跟着跳:所有拿它当 key 的视图(会话、变更、终端)得整个丢掉重来,
    //  否则上一台机器的内容会留在屏幕上,看着像是没清干净。
    setEpoch((e) => e + 1)
  }, [])

  const value = useMemo<Conn>(
    () => ({
      hosts,
      activeHost,
      loading,
      state,
      methods: state?.status === 'ready' ? state.methods : new Set<string>(),
      online: state?.status === 'ready',
      invoke,
      on,
      addHost,
      removeHost,
      selectHost,
      reconnect,
      forgetAll,
      epoch,
    }),
    [hosts, activeHost, loading, state, invoke, on, addHost, removeHost, selectHost, reconnect, forgetAll, epoch],
  )

  return <ConnCtx.Provider value={value}>{children}</ConnCtx.Provider>
}

export function useConn(): Conn {
  const c = useContext(ConnCtx)
  if (!c) throw new Error('useConn 必须在 ConnProvider 里用')
  return c
}

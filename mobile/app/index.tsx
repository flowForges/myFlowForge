import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Platform, Pressable, ScrollView, View } from 'react-native'
import { router } from 'expo-router'
import { CH } from '../../src/main/ipc/channels'
import type { SessionsFile, WorkspaceMeta } from '../../src/shared/types'
import { fmtRelTime } from '../../src/shared/relTime'
import { useC } from '../src/theme/theme'
import { RADIUS } from '../src/theme/tokens'
import { Btn, Empty, IconBtn, List, LiveDot, T, TopBar } from '../src/ui/kit'
import { Sheet } from '../src/ui/Sheet'
import { JumpBubble } from '../src/ui/JumpBubble'
import { useConn } from '../src/net/conn'
import { hostPickRows } from '../src/net/hostPicker'
import { hostSubtitle } from '../src/net/hostStatusText'
import { HostSwitchSheet } from '../src/ui/HostSwitchSheet'
import { useStore, type WsGroup } from '../src/data/store'
import { useBranches } from '../src/data/useBranches'
import { isSessionUnread } from '@shared/chat/unread'
import { tierOf, countTiers, topTier, type SessionTier, type TierCounts } from '../src/data/sessionStatus'
import { runningKey } from '../src/data/runningMerge'
import { StatusBadge } from '../src/ui/StatusBadge'
import { WsRow } from '../src/ui/WsRow'
import { SessionRow, ActionRow } from '../src/ui/SessionRow'
import { Icon } from '../src/ui/Icon'
import { NeedsYou, type NeedItem } from '../src/ui/NeedsYou'
import { indentFor } from '../src/ui/tree'

/**
 * 根屏 · 全部会话,按工作区分组。
 *
 * ★这一屏最重要的一件事不是「列出会话」,是**一眼看出哪条挂着门**。
 *   每条会话和每个工作区分组头都挂着四档阶梯的徽章(见 `ordered` 上的注释:
 *   排序不再按门/运行/未读把东西顶到最上面 —— 那是气泡的活,不是排序的活)。
 *   挂着门的那一条本身仍然染成琥珀底 + 琥珀边,方便扫视时一眼定位。
 *
 * 因为是根屏,零主机的首跑引导也落在这里:一个刚装上的新用户没有会话可点,
 * 只会落在这儿,所以「先连一台电脑」必须是这一屏自己的分支,不能指望对话屏兜底。
 */

/**
 * 抽屉里**不上树**的那几样(空态那句话、「＋ 新建会话」、建失败那句红字)要缩进多少 ——
 * 正好是连接列的宽度,这样它们和会话卡的左沿对齐。见 `tree.ts` 的 `indentFor`。
 */
const ASIDE = indentFor('aside')

/** 门等了多久,`mm:ss`。和 `GateCard` 的 `useWaited` 同一个口径。 */
function waited(since: number, now: number): string {
  const sec = Math.max(0, Math.floor((now - since) / 1000))
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`
}

export default function Home() {
  const c = useC()
  const { activeHost, hosts, loading: hostsLoading, online, state, invoke, selectHost } = useConn()
  const {
    groups, gates, gatesFor, loading, select, wsName, refresh, unread, running, expanded, toggleWs, ensureWs,
    setPinned, archive,
  } = useStore()
  const now = Date.now()
  const [creating, setCreating] = useState(false)
  // 建会话失败时那句话,**连同它属于哪个工作区**一起记 —— 那颗按钮现在每个展开的工作区里各有一颗,
  // 只记一句 string 的话,在 A 区失败会让 B 区底下也挂着同一句红字。
  const [newErr, setNewErr] = useState<{ wsPath: string; msg: string } | null>(null)
  // 顶部主机条点开的那张换主机单子。
  const [hostSheet, setHostSheet] = useState(false)

  // 分组头长按呼出的操作单(置顶 / 归档)。放的是那一个工作区的 meta,不是路径 ——
  // sheet 里要读 `pinned` 决定按钮显示「置顶」还是「取消置顶」。
  const [wsSheet, setWsSheet] = useState<WorkspaceMeta | null>(null)
  const [wsBusy, setWsBusy] = useState(false)
  const [wsErr, setWsErr] = useState<string | null>(null)

  const togglePinned = async () => {
    if (!wsSheet) return
    setWsBusy(true)
    setWsErr(null)
    try {
      await setPinned(wsSheet.path, !wsSheet.pinned)
      setWsSheet(null)
    } catch (e) {
      // ★`workspaces:set-pinned` 到了上限会 throw(`最多只能置顶 N 个工作区`),
      //  这句话必须原样落在这个红框里 —— 吞掉的话人只会觉得点了没反应。
      setWsErr(e instanceof Error ? e.message : String(e))
    } finally {
      setWsBusy(false)
    }
  }

  const archiveWs = () => {
    if (!wsSheet) return
    const ws = wsSheet
    const go = async () => {
      setWsBusy(true)
      setWsErr(null)
      try {
        await archive(ws.path)
        setWsSheet(null)
      } catch (e) {
        setWsErr(e instanceof Error ? e.message : String(e))
      } finally {
        setWsBusy(false)
      }
    }
    const msg = `归档「${ws.name}」?归档后从会话列表消失,在 设置 → 已归档的工作区 里恢复。`
    if (Platform.OS === 'web') {
      // RN-web 的 Alert 只有一个按钮,确认框走 window.confirm 才是真能选的(见 hosts.tsx 的 remove())。
      // eslint-disable-next-line no-alert
      if (typeof window !== 'undefined' && window.confirm(msg)) void go()
      return
    }
    Alert.alert('归档工作区', msg, [
      { text: '取消', style: 'cancel' },
      { text: '归档', style: 'destructive', onPress: () => void go() },
    ])
  }

  const tierFor = (wsPath: string, sessionId: string): SessionTier =>
    tierOf({
      hasGate: gatesFor(wsPath, sessionId).length > 0,
      // 带工作区的 key —— 裸 sessionId 会串台(见 runningMerge.ts 的 runningKey)。
      running: running.has(runningKey(wsPath, sessionId)),
      unread: isSessionUnread(unread, wsPath, sessionId),
    })

  /**
   * 新建会话。★入口现在是**每个展开的工作区底下那一行**,不再是顶栏那颗 ＋ ——
   * 你点开抽屉的时候人已经在这个工作区里了,再弹一张单子问「哪个工作区」是多此一问。
   * (新建**工作区**是另一条路:列表最底下那颗按钮 → `/new-workspace`。)
   */
  const newSession = async (wsPath: string) => {
    setCreating(true)
    setNewErr(null)
    try {
      const file = (await invoke(CH.sessionNew, [wsPath])) as SessionsFile
      const created = file.sessions.find((s) => s.id === file.activeSessionId) ?? file.sessions[0]
      if (!created) throw new Error('对面建好了会话,但没告诉我是哪一个')
      select({ wsPath, sessionId: created.id })
      // 建完直接进对话,回来时那个区该是开着的 —— 不然新建的那条会话藏在一个收起的分组里,
      // 看起来像「建了但没建上」。
      ensureWs(wsPath)
      refresh()
      // 建好就直接进去 —— 建会话的意图就是「我要在这儿说点什么」。
      router.push('/chat')
    } catch (e) {
      // ★原来这里只有 try/finally,没有 catch:建失败就是**彻底无声**。
      //  真机上报的「无法新增会话」如果是服务端拒绝(比如工作区已归档),你一个字都看不到。
      //  ★这条错误路径连同它那句原话一起留着 —— 装它的地方从那张单子换成了工作区抽屉,
      //   但「必须看得见」这一条没变。
      setNewErr({ wsPath, msg: e instanceof Error ? e.message : String(e) })
    } finally {
      setCreating(false)
    }
  }

  /**
   * ★**排序与运行/门/未读状态无关。**
   *
   * 上一版把「有门的工作区」顶到最前。那样有事的永远在顶上,于是「指向下方的定位气泡」
   * 就没有东西可指 —— 而气泡正是用来解决「工作区多 + 会话多、一屏放不下」的。
   * 取舍是:**位置稳定**(不会因为状态变化就重排,老是跳位比找不到更烦)
   * 换取「有事的可能在下面」,后者交给气泡。
   *
   * 唯一凌驾于时间之上的是 `pinned` —— 那是你手动钉的,不是状态。
   * (钉的入口就在这个文件上方几十行:长按分组头 → `wsSheet` 那张操作单。)
   */
  const ordered = useMemo(() => {
    const recency = (g: WsGroup) =>
      Math.max(0, ...g.sessions.map((s) => s.lastMessageAt ?? s.createdAt))
    return [...groups].sort((a, b) => {
      const p = Number(!!b.ws.pinned) - Number(!!a.ws.pinned)
      if (p) return p
      return recency(b) - recency(a)
    })
  }, [groups])

  // 分组头上的分支名。`ordered` 每次渲染都是新数组,所以路径串单独 memo 一层。
  const branches = useBranches(useMemo(() => ordered.map((g) => g.ws.path), [ordered]))

  /**
   * ★**列表主体这一刻画的是不是真会话行。**主体的三个空态分支(未连接 / 正在读取 / 没有工作区)
   *  和定位气泡必须共用这**同一个**判断,不能各写一遍。
   *
   *  各写一遍的后果实测过一次:掉个 WiFi 并不会推进 `epoch`,`groups`/门都还在内存里,
   *  于是主体已经换成「未连接 —— 第一版不缓存,所以这里不会拿旧内容假装在线」,
   *  屏幕底下却还浮着一颗「❓ 2 条等你答话 ↓」的琥珀气泡 —— 数据来源正是那份缓存,
   *  点下去还只会滚一个空的 ScrollView。设计文档 §3 第三条原则(断线态显式,
   *  绝不拿缓存假装在线)不允许这样,所以这个值同时是气泡的开关。
   */
  const showsRows = online && !loading && ordered.length > 0

  const scrollRef = useRef<ScrollView>(null)
  // 三段 y,拼起来才是一行会话在滚动内容里的**绝对**位置 —— 见下面 `absY()` 的注释
  // 和 JSX 里三处 onLayout(工作区分组 View / 包 List 的裸 View / 每行 wrapper)。
  const groupY = useRef<Record<string, number>>({})
  const listY = useRef<Record<string, number>>({})
  const rowY = useRef<Record<string, number>>({})
  const scrollY = useRef(0)
  const viewH = useRef(0)
  // absY 是 useCallback([]) 的(它的消费者靠它 identity 稳定),所以展开状态要走 ref 进来。
  const expandedRef = useRef(expanded)
  expandedRef.current = expanded

  /**
   * 一行会话在滚动内容里的**绝对** y。
   *
   * ★`onLayout` 给的 y 只相对**直接父容器**,不是相对整个滚动内容 —— 而这条渲染链条
   *  有三层:工作区分组 View(直接挂在 ScrollView 内容下,`groupY`)
   *  → 包住 `<List>` 的裸 View(相对分组 View,`listY`)
   *  → 每行外面的 wrapper(相对 List,`rowY`)。三段全测到才能拼出真实位置,
   *  少一段这里就返回 undefined —— 调用方按「还没测到」处理,不会拼出一个错的数字。
   *  ★这个方案的脆弱之处:谁把这条渲染链条重新套一层、或者拿掉中间某一层,
   *  三段 y 就会对不上,症状是气泡**悄悄**滚到错的那一行,不会有任何测试报错
   *  (jsdom/node 环境测不了真实布局)。
   *  ★没有用 `measureLayout`/`getInnerViewNode`/`findNodeHandle`:`mobile/app.json`
   *  开着 `newArchEnabled`(Fabric),这几个 API 在 Fabric 下的行为这个环境没法验证 ——
   *  选错了是运行时才炸;`onLayout` 在新旧架构下都确定支持,代价换成了「重新嵌套要
   *  记得改三处」这种可见、可写注释提醒的脆弱,不是那种运行时才炸的脆弱。
   */
  const absY = useCallback((wsPath: string, key: string): number | undefined => {
    const gy = groupY.current[wsPath]
    if (gy === undefined) return undefined
    // ★这个工作区**收起着**:它的会话行根本没渲染,`rowY` 里剩的是上一次展开时的旧值。
    //  拿那个旧值拼出来的位置是错的,而且错得**一声不响**(布局这类东西 node/jsdom 测不了)。
    //  收起时目标就是**分组头自己** —— 气泡指过去、点一下滚到它并把它展开(见 jump()),
    //  正好是人想要的:要找的那条就在刚展开的这一组里。
    if (!expandedRef.current.has(wsPath)) return gy
    const ly = listY.current[wsPath]
    const ry = rowY.current[key]
    if (ly === undefined || ry === undefined) return undefined
    return gy + ly + ry
  }, [])

  // 所有非 idle 的会话,按它们在列表里的先后排好 —— 气泡要跳的就是这一串。
  // key 用 NUL(`\0`)分隔而不是空格/逗号:两者都是 POSIX 路径的合法字符,
  // 用它们做分隔符会让两个不同的 (workspacePath, sessionId) 撞成同一个 key,
  // 症状是气泡滚到错的那一行。@shared/chat/unread 的 key() 用的是同一个理由。
  const pending = ordered.flatMap((g) =>
    g.sessions
      .map((s) => ({
        key: `${g.ws.path}\0${s.id}`, wsPath: g.ws.path, sessionId: s.id,
        wsName: g.ws.name, title: s.title, agentId: s.agentId, mode: s.mode,
        at: s.lastMessageAt ?? s.createdAt,
        tier: tierFor(g.ws.path, s.id),
      }))
      .filter((x) => x.tier !== 'idle'),
  )
  /**
   * 顶部「需要你」那一块的条目。**直接复用 `pending`** —— 它已经是「所有非 idle 的会话,
   * 按列表顺序排好」,定位气泡吃的也是同一份。两处各推一遍的话,迟早出现
   * 「气泡说有 2 条、上面那块列了 3 条」这种自己打自己脸的画面。
   *
   * 排序:门 > 执行中 > 未读,同档按最近活动倒序 —— 等你答话的永远在最上面。
   */
  const needItems: NeedItem[] = useMemo(() => {
    const rank = { gate: 0, running: 1, unread: 2 } as const
    return [...pending]
      .sort((a, b) => (rank[a.tier as keyof typeof rank] - rank[b.tier as keyof typeof rank]) || (b.at - a.at))
      .map((p) => {
        const g = gatesFor(p.wsPath, p.sessionId)[0]
        const agent = (p.agentId ?? '').trim() || (p.mode === 'workflow' ? '工作流' : '对话')
        return {
          key: p.key, wsPath: p.wsPath, sessionId: p.sessionId,
          title: p.title || '新会话',
          // 门那一档报「等了多久」——门等得越久越该显眼;其余报最近活动时间。
          sub: [p.wsName, agent, g ? `等了 ${waited(g.since, now)}` : fmtRelTime(p.at, now) || '—']
            .filter(Boolean).join(' · '),
          tier: p.tier as NeedItem['tier'],
        }
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending.map((p) => p.key + p.tier).join(','), now])

  const counts = countTiers(pending.map((p) => p.tier))
  const top = topTier(counts)
  // 只在最高那一档里挑目标 —— 气泡说「1 条等你答话」就该跳到门那条,不是跳到别的。
  const targets = top
    ? pending.filter((p) => p.tier === top).map((p) => ({ key: p.key, wsPath: p.wsPath }))
    : []

  /**
   * ★气泡该显示什么,是**状态**不是「渲染时顺手算出来的值」。
   *
   * `scrollY`/`viewH`/三段 y 全是 ref —— onScroll/onLayout 只改 ref,不触发重渲染。
   * 如果气泡内容在渲染期间直接从这些 ref 读,画面就会停在「上一次真正重渲染时」的
   * 快照上:手动把门那行滑进视口,组件不会因为滑动本身而重渲染,气泡会继续挂在那,
   * 指着一条你已经看在眼里的行 —— 正是这一屏要禁止的「指着看得见的东西」。
   * 所以改成:算出一个 `bubble` 描述对象放进 state,`syncBubble()` 是唯一入口,
   * 由 onScroll / ScrollView 的 onLayout / 下面这个按 pending 数据触发的 effect 调用,
   * 状态确实变了才 setState(见 `syncBubble` 里的逐字段比较),没变就不触发重渲染。
   */
  const pendingRef = useRef<{
    top: Exclude<SessionTier, 'idle'> | null
    targets: { key: string; wsPath: string }[]
    counts: TierCounts
  }>({ top: null, targets: [], counts: { gate: 0, running: 0, unread: 0 } })
  pendingRef.current = { top, targets, counts }

  type BubbleState = {
    tier: Exclude<SessionTier, 'idle'>
    count: number
    direction: 'up' | 'down'
    targetKey: string
    targetWsPath: string
  } | null

  const [bubble, setBubble] = useState<BubbleState>(null)

  const computeBubble = useCallback((): BubbleState => {
    const { top: t, targets: ts, counts: cs } = pendingRef.current
    if (!t) return null
    // **不在视口内**的目标。全在视口里就不显示气泡:它指的东西你已经看见了。
    // 三段 y 没测全(absY 返回 undefined)也当作「不在视口内」处理 —— 宁可气泡多等一帧
    // 首屏布局跑完,不能拿 undefined 当 0 用,那会把没测到的目标误判成「就在顶上」。
    const off = ts.filter((x) => {
      const y = absY(x.wsPath, x.key)
      return y === undefined || y < scrollY.current || y > scrollY.current + viewH.current
    })
    if (!off.length) return null
    /**
     * ★在这些候选里挑**离当前视口最近**的那一条,不是列表顺序上的第一条。
     *
     * 设计文档 §4.4 定的是「箭头方向 = 最近那条目标相对当前视口的方向」。按顺序取第一条会这样错:
     * 你滑到列表底部,第 1 行挂着一道门、视口下沿刚过去一点也有一道 —— 取第一条就给你一个 ↑,
     * 一点直接甩回列表最顶上,而真正近在咫尺的那道门被跳过了。
     *
     * 距离 = 目标到视口最近那条边的距离(在上面就是到上沿,在下面就是到下沿),并列取靠前的。
     * 还没量到的候选(y === undefined)没有距离可比,所以只在**一个都没量到**时才兜底取
     * 列表顺序第一条 —— 与老行为一致:气泡照样出现,jump() 这一帧不滚,等量到了下一次
     * syncBubble 再纠正。
     */
    let found: { key: string; wsPath: string } | undefined
    let best = Infinity
    for (const x of off) {
      const y = absY(x.wsPath, x.key)
      if (y === undefined) continue
      const d = y < scrollY.current ? scrollY.current - y : y - (scrollY.current + viewH.current)
      if (d < best) {
        best = d
        found = x
      }
    }
    if (!found) found = off[0]
    const y = absY(found.wsPath, found.key)
    // absY() 的三处消费者(这里的方向、上面的候选判定、下面 jump() 的滚动目标)统一口径:
    // y 是 undefined(还没测到)时,候选判定当「还没进视口」处理(仍是候选),方向缺省
    // 猜「在下面」(还没量到的行多半是还没被滑过去看到的),jump() 干脆不滚。
    const direction: 'up' | 'down' = y !== undefined && y < scrollY.current ? 'up' : 'down'
    return { tier: t, count: cs[t], direction, targetKey: found.key, targetWsPath: found.wsPath }
  }, [absY])

  const syncBubble = useCallback(() => {
    const next = computeBubble()
    setBubble((prev) => {
      if (prev === next) return prev // 两边都是 null
      if (prev === null || next === null) return next
      if (
        prev.tier === next.tier &&
        prev.count === next.count &&
        prev.direction === next.direction &&
        prev.targetKey === next.targetKey &&
        prev.targetWsPath === next.targetWsPath
      ) {
        return prev // 内容没变,保持同一个引用,不触发重渲染
      }
      return next
    })
  }, [computeBubble])

  // 会话数据变了(门挂上/被答掉、有新未读……)时补一次 —— 哪怕这一刻用户没在滑动、
  // ScrollView 也没重新布局,气泡该不该出现/该显示哪一档也可能已经变了。
  // 依赖项用原始值而非 `targets` 数组本身(每次渲染都是新引用),这样内容真没变时
  // effect 不会白跑。
  const targetKeysSig = targets.map((t) => t.key).join(',')
  // ★`expanded` 也在依赖里:折叠/展开会改变后面所有内容的高度,目标会因此进出视口
  //  (收起时 absY 返回的还换成了分组头自己的 y),不补这一次 syncBubble,气泡会停在
  //  折叠前的那份答案上。
  useEffect(() => {
    syncBubble()
  }, [top, counts.gate, counts.running, counts.unread, targetKeysSig, expanded, syncBubble])

  const jump = useCallback(() => {
    if (!bubble) return
    // 收起着的话先展开 —— 不然滚过去只看得到一个分组头,那条会话还是没露面。
    // 展开这一下会改变后面所有内容的高度,所以滚动放在下一帧(setTimeout 0),
    // 让 onLayout 先把新的三段 y 量出来。
    const wasCollapsed = !expanded.has(bubble.targetWsPath)
    if (wasCollapsed) ensureWs(bubble.targetWsPath)
    const go = () => {
      // ★三段 y 拼不出来时**退回分组头自己的 y**,不要一走了之。
      //  刚展开的那一组,它的会话行是这一帧才挂上去的,Fabric 下它们的 onLayout 多半还没跑,
      //  `listY`/`rowY` 里一个数都没有 —— 不兜这一下 absY 就是 undefined,go() 直接 return,
      //  屏幕**一动不动**:那一组在屏幕外悄悄展开了,人看到的是「点了没反应」(这套代码
      //  已经在别处栽过同一件事)。退到分组头正是设计承诺的那句「滚到它并把它展开」,
      //  下一次 syncBubble 会拿量到的真实位置再纠正。★别当冗余删掉。
      const y = absY(bubble.targetWsPath, bubble.targetKey) ?? groupY.current[bubble.targetWsPath]
      if (y === undefined) return
      // 往上留 24px,让目标不要正好贴在顶栏下沿。
      scrollRef.current?.scrollTo({ y: Math.max(0, y - 24), animated: true })
    }
    if (wasCollapsed) setTimeout(go, 0)
    else go()
  }, [bubble, absY, expanded, ensureWs])

  // ── 还没配主机:这一屏没有任何东西可画,直接把人送去配 ────────────────────────
  if (!hostsLoading && hosts.length === 0) {
    return (
      <View style={{ flex: 1, backgroundColor: c.bg }}>
        <TopBar>
          <T style={{ fontSize: 15.5, fontWeight: '600', color: c.fg, paddingHorizontal: 2 }}>myFlowForge</T>
        </TopBar>
        <View style={{ flex: 1, justifyContent: 'center' }}>
          <Empty
            title="先连一台电脑"
            desc={'手机端不在本地跑代理 —— 它是你电脑上那台 Forge 的遥控器。\n在电脑上跑起 daemon,把它打印的地址填进来。'}
          />
          <View style={{ paddingHorizontal: 30 }}>
            <Btn kind="pri" block onPress={() => router.push('/add-host')}>
              添加主机
            </Btn>
          </View>
        </View>
      </View>
    )
  }

  const tone = state?.status === 'ready' ? 'ok' : state?.status === 'connecting' ? 'wait' : 'off'

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      {/* ★★顶部一整条是**主机条**,不是 app 的名字(设计文档 §4.4b)。
          原来这里写着「myFlowForge」+ 一行主机名 —— app 的名字每一屏都一样,它不告诉你任何东西,
          却占着全屏最显眼的那一行。这一屏真正需要常驻回答的问题是「我现在遥控的是哪台电脑」,
          因为这上面每一条会话、每一道门都属于某一台电脑。
          ★**整条可点**,点开就换主机:切主机是个真会做的动作,不该埋在「设置 → 主机 → 点一台」底下。 */}
      <TopBar
        right={
          // ★设置是全局的,不属于任何一条会话。
          //  原来它旁边还有一颗 ＋(新建会话,弹单子问「哪个工作区」)—— 已经拆散挪进了
          //  每个工作区展开后的那一行「＋ 新建会话」和列表底部的「＋ 新建工作区」:
          //  在工作区里面点的时候,「哪个工作区」这个问题本身就是多余的。
          <IconBtn label="设置" onPress={() => router.push('/settings')}>⚙</IconBtn>
        }
      >
        <Pressable
          onPress={() => setHostSheet(true)}
          // 整条都是热区(顶栏里 TopTitle 那块本来就横跨到底),而不是只有那几个字可点 ——
          // 这套代码已经在别处栽过「点了没反应,其实点在旁边的空白上」。
          style={({ pressed }) => [{ paddingHorizontal: 2 }, pressed && { opacity: 0.6 }]}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <LiveDot tone={tone} />
            <T numberOfLines={1} style={{ fontSize: 15.5, fontWeight: '600', letterSpacing: -0.3, color: c.fg, flexShrink: 1, minWidth: 0 }}>
              {activeHost?.label ?? '未选主机'}
            </T>
            {/* ▾ 是「这儿能点开」的唯一信号。手机上没有 hover,不画它就没人知道这条是活的。 */}
            <T style={{ fontSize: 10, color: c.faint }}>▾</T>
            {/* 这台机器上挂着的门,常驻在最显眼的一行。★不是装饰:整个 app 存在的理由就是
                「代理停在门上而你不在电脑前」,滚到哪儿都该看得见还有几道。 */}
            {gates.length > 0 ? (
              <View style={{ marginLeft: 'auto' }}>
                <StatusBadge tier="gate" count={gates.length} />
              </View>
            ) : null}
          </View>
          {/* 副行仍然报地址 —— ★连上时报「地址 · 对面版本」,断线时报**为什么**,
              和设置屏 / 主机屏共用同一份 `hostSubtitle`。断线态必须显式,不能只剩一颗红点。 */}
          {activeHost ? (
            <T numberOfLines={1} mono style={{ fontSize: 11.5, color: c.muted, marginTop: 1 }}>
              {hostSubtitle(activeHost.url, state, true)}
            </T>
          ) : null}
        </Pressable>
      </TopBar>

      <ScrollView
        ref={scrollRef}
        scrollEventThrottle={64}
        onScroll={(e) => { scrollY.current = e.nativeEvent.contentOffset.y; syncBubble() }}
        onLayout={(e) => { viewH.current = e.nativeEvent.layout.height; syncBubble() }}
        contentContainerStyle={{ paddingBottom: 96 }}
      >
        {!online ? (
          <Empty title="未连接" desc={'连上才有数据 —— 第一版不缓存,\n所以这里不会拿旧内容假装在线。'} />
        ) : loading ? (
          <Empty title="正在读取…" />
        ) : !showsRows ? (
          // ★这里原来写着「新建工作区留在电脑端」。那句话已经不成立了(设计文档 §7.4 明确纠正过:
          //  `workspace:create` / `fs:browse` 这些手机全拿得到,「留在电脑端」是抄自一句过时的注释),
          //  而且对着一个**空**列表说「你在这儿什么都做不了」是最糟的一种空态。
          <>
            <Empty title="这台机器上还没有工作区" desc="工作区是一堆项目 + 一条工作流。先建一个,才有地方开会话。" />
            <View style={{ paddingHorizontal: 30 }}>
              <Btn kind="pri" block onPress={() => router.push('/new-workspace')}>
                ＋ 新建工作区
              </Btn>
            </View>
          </>
        ) : (
          <>
          {/* ★这一块就是这一屏存在的理由:代理停在门上而你不在电脑前。
              没事的时候整块不渲染 —— 「没有这一块 = 没你的事」。
              ★它现在能折(折的只有列表,头和头上那个数永远在,见 NeedsYou.tsx)。
               折叠会改变它的高度 = **下面每一个工作区分组整体挪位**,而定位气泡吃的第①段 y
               (groupY)正是这些分组的 y —— 靠每个分组 View 自己的 onLayout 补 syncBubble
               把它纠正过来,和折叠工作区那条路是同一个机制(见下面 groupY 的 onLayout)。
               ★折叠状态是 NeedsYou **自己**存的,没有走 store:store 的 value 是带依赖数组的
               useMemo,加字段漏加依赖会静默不更新(见 store.tsx 末尾那条注释),
               而这个状态只有这一个消费者,没有理由去趟那道坎。 */}
          <NeedsYou
            items={needItems}
            gateCount={counts.gate}
            onPick={(it) => {
              select({ wsPath: it.wsPath, sessionId: it.sessionId })
              ensureWs(it.wsPath)
              router.push('/chat')
            }}
          />
          <T style={{ fontSize: 11, color: c.faint, paddingHorizontal: 16, paddingTop: 20, paddingBottom: 6 }}>
            全部工作区
          </T>
          {ordered.map((g, gi) => {
            const wsGates = gatesFor(g.ws.path)
            const sessions = [...g.sessions].sort(
              (a, b) => (b.lastMessageAt ?? b.createdAt) - (a.lastMessageAt ?? a.createdAt),
            )
            const open = expanded.has(g.ws.path)
            return (
              // 定位气泡 absY() 三段 y 的第①段:这层 View 是 ScrollView 内容的直接子节点,
              // 所以 onLayout 给的 y 就是相对整个滚动内容的绝对值,记进 groupY[wsPath]。
              // 另外两段:下面包住 <List> 的裸 View(第②段,listY)、每行外面的 View(第③段,rowY,
              // 在 sessions.map 里)。三段的 key/wsPath 必须对得上,少一段 absY() 就返回 undefined ——
              // 缺了不会报错,只会让气泡悄悄指错方向或不出现。没用 measureLayout 等原生测量 API:
              // 新架构(Fabric,见 app.json 的 newArchEnabled)下的行为这个环境没法验证。
              <View
                key={g.ws.path}
                onLayout={(e) => {
                  groupY.current[g.ws.path] = e.nativeEvent.layout.y
                  // ★量到之后补一次 syncBubble。收起/展开**上面**某一组会把下面所有组整体挪位,
                  //  而这些 onLayout 只写 ref、本身不触发重渲染 —— 不补这一下,气泡会拿着折叠前
                  //  的那份 y 继续显示旧的方向/目标,直到你随手滑一下才纠正。
                  //  不怕 setState 风暴:syncBubble 逐字段比过,没变就原样返回 prev,React 直接跳过。
                  syncBubble()
                }}
              >
                {/* ★工作区分组头是**一张卡**,不是一个小标题 —— 见 WsRow 的注释。
                    原来这里用的是 `Sec`(原型 d.css 的 `.sec`:10.5px 浅灰等宽小标签),
                    而 `.sec` 在原型里永远只是「一行标签 + 底下一串卡片」里的那行标签。
                    加了折叠之后它成了**可点的主体**、还默认收起,于是整屏只剩十几行浅灰小字。
                    `Sec` 本身没动 —— 另外 6 个屏还在拿它当真正的分节标签用。 */}
                <WsRow
                  name={g.ws.name}
                  note={branches.get(g.ws.path)}
                  meta={`${g.ws.projectCount} 个项目`}
                  expanded={open}
                  gate={wsGates.length > 0}
                  onPress={() => toggleWs(g.ws.path)}
                  onLongPress={() => { setWsErr(null); setWsSheet(g.ws) }}
                  right={(() => {
                    // `wsCounts` 是**这一个工作区**的;组件级还有个全屏范围的 `counts`(气泡用的)。
                    // 名字必须分开 —— 同名遮蔽两个都对的时候没人看得出来,哪天错用了也一样没人看得出来。
                    const wsCounts = countTiers(g.sessions.map((s) => tierFor(g.ws.path, s.id)))
                    // ★展开时会话自己带徽章了,分组头上再来一个是重复(电脑端 Sidebar.tsx:248 同一条规矩)。
                    //  但**门那一档例外**:门是「代理停在那儿等你」,收起展开都该看得见。
                    if (wsCounts.gate) return <StatusBadge tier="gate" count={wsCounts.gate} />
                    if (!open && wsCounts.running) return <StatusBadge tier="running" count={wsCounts.running} />
                    if (!open && wsCounts.unread) return <StatusBadge tier="unread" count={wsCounts.unread} />
                    return null
                  })()}
                />
                {/* ★★展开区**只有一个分支**了。原来这里是「没会话 → 一个不带 onLayout 的空态盒子 /
                    有会话 → 抽屉」两条,于是空工作区那一档根本不写 `listY`,而现在它里面也有了一颗
                    可点的东西(「＋ 新建会话」)。合成一条之后,只要展开,第②段 y 就一定量得到 ——
                    定位气泡那条三段链条少一种缺口。 */}
                {!open ? null : (
                  // 定位气泡 absY() 三段 y 的第②段:这一层测的是 `<List>` 相对上面分组 View
                  // (第①段,groupY)的偏移,记进 listY[wsPath];第③段是每行外面的 View(rowY)。
                  // 三段缺一个,absY() 就返回 undefined —— 不会报错,只会让气泡悄悄滚到错的位置。
                  //
                  // ★★这一层原来有 bg2 底色 + 左右描边 + 12pt 外边距,把抽屉画成「一个盒子」。
                  //  全出血之后**全部去掉**:从属关系原来被表达了四遍(缩进 + 树 + 换底色 + 描边),
                  //  现在只留前两遍。多出来的两遍是噪音,而且那块 bg2 正是用户说的
                  //  「工作区是明显的白色,显得这是一个页面」里那层多余的分层。
                  // ★★这一层**永远不许加 padding**:给它加 padding 会把 List 整体推下去,
                  //  而 rowY 是相对 List 量的、listY 是这一层自己的 y —— 那段 padding 没有任何人
                  //  算回去,症状是气泡稳定地滚偏一截,且测不出来。
                  <View onLayout={(e) => { listY.current[g.ws.path] = e.nativeEvent.layout.y }}>
                    {/* ★`List` 自带 `paddingHorizontal: 12` 和 `gap: 8` —— 全出血要把这两样都盖掉。
                        gap 归零是关键:行与行之间**不留缝**,连接列才首尾相接、主干才连续
                        (原来那道缝靠一个叫 `TreeGap` 的小组件去补,那个补丁已经随 rowGap 一起删了)。
                        ★`paddingTop` 必须是 0:它会把所有行整体推下去,而 rowY 是相对 List 量的 ——
                        推下去的那一段没有任何人算回去。`paddingBottom` 不影响任何一行的 y,可以有。
                        ★这一层仍然**只准动横向的量**加上 paddingBottom,别加 marginTop/marginBottom。 */}
                    <List style={{ paddingHorizontal: 0, paddingTop: 0, paddingBottom: 0, gap: 0 }}>
                      {sessions.map((s, si) => {
                        const sg = wsGates.filter((x) => x.sessionId === s.id)
                        return (
                          // 定位气泡 absY() 三段 y 的第③段:这层 View 相对上面的 List(第②段,
                          // listY)记这一行自己的偏移,记进 rowY[key]。第①段是工作区分组 View
                          // (groupY)。三段缺一个,absY() 就返回 undefined —— 不会报错,只会让
                          // 气泡悄悄滚到错的位置。没用 measureLayout 等原生测量 API:新架构
                          // (Fabric)下的行为这个环境没法验证,onLayout 在新旧架构都确定支持。
                          <View
                            key={s.id}
                            onLayout={(e) => { rowY.current[`${g.ws.path}\0${s.id}`] = e.nativeEvent.layout.y }}
                          >
                            {/* ★★这一层(带 onLayout 的 wrapper)是定位气泡三段 y 的第③段。
                                `SessionRow` 长在它**里面**,不是在它**外面**又套了一层 ——
                                外面套一层的话三段 y 就少算了新那一层的偏移,症状是气泡稳定地
                                滚偏一截,而且一条测试都不会红。Task 8 往里塞左滑时也是同一条规矩。 */}
                            <SessionRow
                              index={si}
                              total={sessions.length}
                              gate={sg.length > 0}
                              onPress={() => {
                                select({ wsPath: g.ws.path, sessionId: s.id })
                                ensureWs(g.ws.path)
                                router.push('/chat')
                              }}
                            >
                              <View style={{ flex: 1, minWidth: 0 }}>
                                <T numberOfLines={1} style={{ fontSize: 15, fontWeight: '600', color: c.fg }}>
                                  {s.title || '新会话'}
                                </T>
                                <T mono style={{ fontSize: 11.5, color: c.muted, marginTop: 3 }}>
                                  {(s.agentId ?? '').trim() || (s.mode === 'workflow' ? '工作流' : '对话')}
                                </T>
                              </View>
                              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, flexShrink: 1, minWidth: 0 }}>
                                <T
                                  mono
                                  numberOfLines={1}
                                  style={{ fontSize: 9.5, color: c.faint, flexShrink: 1, minWidth: 0 }}
                                >
                                  {fmtRelTime(s.lastMessageAt ?? s.createdAt, now) || '—'}
                                </T>
                                <StatusBadge tier={tierFor(g.ws.path, s.id)} />
                                <Icon name="chevron" size={13} color={c.faint} />
                              </View>
                            </SessionRow>
                          </View>
                        )
                      })}
                      {/* 一条会话都没有 = **没有树**(没有东西可连),只剩这句话和底下那颗按钮。
                          左边照样缩到卡片左沿(`indentFor('aside')`),否则它比上面那几张卡凸出去一截。 */}
                      {sessions.length === 0 ? (
                        <T style={{ fontSize: 12.5, lineHeight: 19, color: c.faint, paddingLeft: ASIDE, paddingTop: 10, paddingBottom: 4 }}>
                          还没有人在这个工作区开过会话。
                        </T>
                      ) : null}
                      {/* ★★「新建会话」现在**在工作区里面**,不在顶栏。
                          原来是右上角一颗 ＋ → 弹一张单子问「哪个工作区」。而你点开这个抽屉的时候
                          已经**站在**这个工作区里了 —— 那张单子问的是一个你刚刚已经回答过的问题。
                          ★★全出血之后它是一颗 iOS 蓝字动作行(`ActionRow`),不再是虚线描边的
                          ghost 按钮 —— 那条「造一个还不存在的东西 = 虚线」的规矩已经作废,理由和
                          「它不上树」的完整说法见 `SessionRow.tsx` 里 `ActionRow` 的 JSDoc。 */}
                      <ActionRow
                        icon="add"
                        deep
                        last
                        disabled={creating || !online}
                        onPress={() => void newSession(g.ws.path)}
                      >
                        新建会话
                      </ActionRow>
                      {/* ★建会话失败时那句话就落在**这个工作区**里,紧挨着刚才按的那颗按钮。
                          原来它在那张单子里;单子没了,而错误还是必须看得见 —— 见 `newSession()`
                          里那段注释:这条路径曾经是彻底无声的。
                          错误按工作区分开记(`newErr.wsPath`),否则在 A 区失败一次,B 区展开时
                          底下也挂着一句红字,说的是一件根本没在这儿发生过的事。 */}
                      {newErr?.wsPath === g.ws.path ? (
                        <View style={{ marginLeft: ASIDE, marginTop: 8, padding: 11, borderRadius: RADIUS.ctl, borderWidth: 1, borderColor: c.permFullBorder, backgroundColor: c.bg2 }}>
                          <T style={{ fontSize: 13, lineHeight: 20, color: c.err }}>{newErr.msg}</T>
                        </View>
                      ) : null}
                    </List>
                  </View>
                )}
              </View>
            )
          })}
          {/* ★★列表的**收尾动作**,不是列表的又一行。
              ★注意它落在所有工作区分组 View 的**外面**:定位气泡的第①段 y(groupY)量的是
              每个分组 View 相对滚动内容的偏移,这一颗排在它们后面,不改任何一段 y。
              ★★它会在 Task 5 里被删掉(顶栏右上角那颗 ＋ 取代它)—— 这一版先留着,
              是为了不产生「这一版没法建工作区」的中间状态。 */}
          <ActionRow icon="add" onPress={() => router.push('/new-workspace')}>
            新建工作区
          </ActionRow>
          </>
        )}
        {gates.length > 0 && (
          <View style={{ paddingHorizontal: 15, paddingTop: 18 }}>
            <T style={{ fontSize: 11.5, color: c.faint, lineHeight: 19 }}>
              {gates.length} 道门挂在 {new Set(gates.map((x) => wsName(x.wsPath))).size} 个工作区上,代理在等你回答。
            </T>
          </View>
        )}
      </ScrollView>

      {/* 主体没在画真行的时候,气泡一并不出现 —— 同一个 `showsRows`,见它上面的注释。 */}
      {bubble && showsRows ? (
        <JumpBubble tier={bubble.tier} count={bubble.count} direction={bubble.direction} onPress={jump} />
      ) : null}

      {/* 顶部主机条点开的换主机单子。★门数只报得出当前这台的(`gates.length`)——
          别的主机上有没有门,不连上去是不知道的,所以那几台一个字都不写(见 hostPicker.ts)。 */}
      <HostSwitchSheet
        open={hostSheet}
        rows={hostPickRows(hosts, activeHost?.id ?? null, state, gates.length)}
        onClose={() => setHostSheet(false)}
        onPick={(id) => {
          setHostSheet(false)
          void selectHost(id)
        }}
        onAddHost={() => {
          setHostSheet(false)
          router.push('/add-host')
        }}
      />

      {/* 分组头长按呼出的操作单。★长按是发现不了的手势,副标题把它说出来 —— 否则人答完这道单子
          关掉之后再也想不起来是怎么叫出来的。 */}
      <Sheet
        open={!!wsSheet}
        onClose={() => setWsSheet(null)}
        title={wsSheet?.name ?? ''}
        sub="长按分组头随时叫出这张单子"
      >
        {wsErr ? (
          <View style={{ padding: 11, borderRadius: 12, borderWidth: 1, borderColor: c.permFullBorder, backgroundColor: c.bg2 }}>
            <T style={{ fontSize: 13, lineHeight: 20, color: c.err }}>{wsErr}</T>
          </View>
        ) : null}
        <Btn block disabled={wsBusy} onPress={() => void togglePinned()}>
          {wsSheet?.pinned ? '取消置顶' : '置顶'}
        </Btn>
        {/* ★danger 不与主动作相邻(设计文档 §7.6)——这段空隙就是唯一目的。 */}
        <View style={{ height: 20 }} />
        <View>
          <Btn kind="danger" block disabled={wsBusy} onPress={archiveWs}>
            归档
          </Btn>
          <T style={{ fontSize: 11.5, lineHeight: 17, color: c.muted, marginTop: 6 }}>
            归档后从列表消失,在 设置 → 已归档的工作区 里恢复
          </T>
        </View>
      </Sheet>
    </View>
  )
}

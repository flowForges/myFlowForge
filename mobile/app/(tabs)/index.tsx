import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ScrollView, View } from 'react-native'
import { router } from 'expo-router'
import { CH } from '../../../src/main/ipc/channels'
import type { ChatSession, SessionsFile, WorkspaceMeta } from '../../../src/shared/types'
import { fmtRelTime } from '../../../src/shared/relTime'
import { useC } from '../../src/theme/theme'
import { RADIUS } from '../../src/theme/tokens'
import { Btn, Empty, Field, IconBtn, List, T, TopBar } from '../../src/ui/kit'
import { Sheet } from '../../src/ui/Sheet'
import { SwipeRow, type SwipeAction } from '../../src/ui/SwipeRow'
import { sessionCanDelete, sessionCloseWasRefused, LAST_SESSION_WHY } from '../../src/data/sessionOps'
import { confirmDestructive, notify } from '../../src/ui/confirmDestructive'
import { JumpBubble } from '../../src/ui/JumpBubble'
import { useConn } from '../../src/net/conn'
import { hostPickRows } from '../../src/net/hostPicker'
import { HostSwitchSheet } from '../../src/ui/HostSwitchSheet'
import { HostBanner } from '../../src/ui/HostBanner'
import { ROUTES } from '../../src/nav/routes'
import { useStore, type WsGroup } from '../../src/data/store'
import { useBranches } from '../../src/data/useBranches'
import { isSessionUnread } from '@shared/chat/unread'
import { tierOf, countTiers, topTier, type SessionTier, type TierCounts } from '../../src/data/sessionStatus'
import { runningKey } from '../../src/data/runningMerge'
import { StatusBadge } from '../../src/ui/StatusBadge'
import { WsRow } from '../../src/ui/WsRow'
import { SessionRow, ActionRow } from '../../src/ui/SessionRow'
import { Icon } from '../../src/ui/Icon'
import { NeedsYou, type NeedItem } from '../../src/ui/NeedsYou'
import { indentFor } from '../../src/ui/tree'
import { tap } from '../../src/ui/haptics'

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

  /**
   * 置顶/取消置顶 —— 长按分组头的操作单(wsSheet)和左滑露出的动作格现在共用这**同一份实现**,
   * 只是传入的 ws 来源不同(前者读 wsSheet 那份 state,后者是那一行自己的 g.ws)。
   *
   * ★错误怎么显示按入口分:这个工作区当下正被操作单开着(`wsSheet?.path === ws.path`)就走
   *  单子里原有的红框(`wsErr`);左滑没有单子可摆红框,走 `notify()`。
   *  ★★`workspaces:set-pinned` 到了上限会 throw(`最多只能置顶 N 个工作区`),这句话必须
   *   原样显示出来 —— 两条路都不许吞掉,吞掉的话人只会觉得点了没反应。
   */
  const togglePinnedFor = async (ws: WorkspaceMeta) => {
    setWsBusy(true)
    setWsErr(null)
    try {
      await setPinned(ws.path, !ws.pinned)
      if (wsSheet?.path === ws.path) setWsSheet(null)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (wsSheet?.path === ws.path) setWsErr(msg)
      else notify('没能置顶', msg)
    } finally {
      setWsBusy(false)
    }
  }

  // ★两条确认框(这一颗 + 下面 confirmDeleteSession)都走 confirmDestructive ——
  //  别再各写一遍 web/native 分支,原因见 confirmDestructive.ts 的 JSDoc。
  // ★同上:长按/左滑共用这份实现,错误按入口分显示(红框 vs notify)。
  const archiveWs = (ws: WorkspaceMeta) => {
    const msg = `归档「${ws.name}」?归档后从会话列表消失,在 设置 → 已归档的工作区 里恢复。`
    void confirmDestructive({ title: '归档工作区', message: msg, confirmLabel: '归档' }).then(async (yes) => {
      if (!yes) return
      setWsBusy(true)
      setWsErr(null)
      try {
        await archive(ws.path)
        // ★★震动必须等 `await` 真的成功才打 —— haptics.ts 对 `destructive` 的定义是
        //  「确认之后真的执行了」,不是「确认之后打算执行」。放在 `await` 前面(旧版本的写法)
        //  会让 daemon 断线、归档失败、错误横幅弹出的**同一瞬间**,手上还在震「搞定了」——
        //  这正是 `destructive` 用 warning 不用 success 那条设计想防的误导,只是从
        //  「确认时」搬到了「发请求时」,没有真的解决。
        tap('destructive')
        if (wsSheet?.path === ws.path) setWsSheet(null)
      } catch (e) {
        // ★失败照实说:blocked 这一档就是给「被拦住/没做成」用的,手上的反馈要和屏幕上的
        //  错误横幅说同一句话,不能一边震"完成"一边弹"没能归档"。
        tap('blocked')
        const errMsg = e instanceof Error ? e.message : String(e)
        if (wsSheet?.path === ws.path) setWsErr(errMsg)
        else notify('没能归档', errMsg)
      } finally {
        setWsBusy(false)
      }
    })
  }

  // 工作区左滑「重命名」/长按单子「重命名」共用的那张 Sheet。记的是打开那一刻的
  // { path, name } —— name 就是正在编辑的值(Field 直接绑它),和下面会话重命名
  // (renameSession)同一套写法。
  const [renameWs, setRenameWs] = useState<{ path: string; name: string } | null>(null)
  const [renameWsBusy, setRenameWsBusy] = useState(false)
  const [renameWsErr, setRenameWsErr] = useState<string | null>(null)

  const submitRenameWs = async () => {
    if (!renameWs) return
    const name = renameWs.name.trim()
    // ★空名不提交:`workspaces:rename` 服务端不校验,提交上去会得到一个没名字的工作区。
    if (!name) return
    setRenameWsBusy(true)
    setRenameWsErr(null)
    try {
      await invoke(CH.workspaceRename, [{ path: renameWs.path, name }])
      setRenameWs(null)
      refresh()
    } catch (e) {
      setRenameWsErr(e instanceof Error ? e.message : String(e))
    } finally {
      setRenameWsBusy(false)
    }
  }

  /**
   * 一个工作区分组左滑露出的动作格。
   *
   * ★★数组顺序 = 从左到右,而左滑时最先露出、离手指最近的是**最右边**那一格。
   *  所以破坏性的「归档」放在数组第一个(屏幕上最左、离手指最远),先露出来的是无害的「置顶」。
   *  ★和下面会话左滑(`sessionActions`,那边是 [删除, 重命名])**同一条规矩** ——
   *   同一个手势在两种行上炸不同的雷是最坏的一种设计。
   */
  const wsActions = (ws: WorkspaceMeta): SwipeAction[] => [
    { key: 'archive', label: '归档', tone: 'danger', onPress: () => archiveWs(ws) },
    {
      key: 'rename',
      label: '重命名',
      tone: 'plain',
      onPress: () => { setRenameWsErr(null); setRenameWs({ path: ws.path, name: ws.name }) },
    },
    { key: 'pin', label: ws.pinned ? '取消置顶' : '置顶', tone: 'plain', onPress: () => void togglePinnedFor(ws) },
  ]

  /**
   * 会话左滑「删除」弹出的确认框,然后关会话。
   *
   * ★这里能摆出「删除」这一格,前提是调用方(sessionActions)已经用 sessionCanDelete 判过
   *  ok:true。但那是**渲染那一刻**的判断——真正按下去、`session:close` 打到服务端之间
   *  还有一条更窄的缝:两个客户端连着同一台机器,这行打开着的时候,另一端刚把它的
   *  兄弟会话删掉,这一端的「删除」格还没来得及消失。服务端的 `closeSession` 在
   *  「只剩最后一条可写会话」时**原样返回、不报错**——不管窗口有多窄,不看响应就无从知道
   *  它到底删没删。★★所以 invoke 之后必须看响应里这条 id 还在不在:还在,就是没删掉。
   */
  const confirmDeleteSession = async (wsPath: string, s: ChatSession) => {
    const msg = `删除「${s.title || '新会话'}」?这条会话的记录会被删掉。`
    const yes = await confirmDestructive({ title: '删除会话', message: msg, confirmLabel: '删除' })
    if (!yes) return
    try {
      const file = (await invoke(CH.sessionClose, [{ workspacePath: wsPath, sessionId: s.id }])) as SessionsFile
      refresh()
      if (sessionCloseWasRefused(file.sessions, s.id)) {
        // ★不去猜服务端拒绝的是哪一条(「找不到」还是「只剩最后一条」)——sessionCanDelete
        //  已经在按下之前排除了「找不到」,这里唯一还够得着的就是竞态版的「只剩最后一条」,
        //  所以原样引用同一句话,不新编一句意思相同的话。
        // ★★服务端原样返回、根本没删掉 —— 这不是「确认之后真的执行了」,是被拦住了,
        //  用 blocked 不是 destructive,和下面 archiveWs 同一条道理(见那边的注释)。
        tap('blocked')
        notify('没能删除', LAST_SESSION_WHY)
      } else {
        // ★★震动必须等 invoke 真的回来、而且确认没被拒绝才打。见 archiveWs 那边的注释:
        //  `destructive` 的定义是「确认之后真的执行了」,不是「确认之后打算执行」。
        tap('destructive')
      }
    } catch {
      // ★这条路极少失败(能摆出删除格,前提是服务端不会静默拒绝;剩下的只有网络故障),
      //  和 hosts.tsx 的 remove() 同一套宽松度——本任务要治的是「按下去无声无息」的
      //  那个删除按钮本身,不是这里的网络异常兜底。
      // ★但手上的反馈不能装作什么都没发生:没删成,就是被拦住了。
      tap('blocked')
    }
  }

  // 会话左滑「重命名」弹出的单子。记的是打开那一刻的 { wsPath, id, title } ——
  // title 就是正在编辑的值(Field 直接绑它),不另开一份 renameTitle。
  const [renameSession, setRenameSession] = useState<{ wsPath: string; id: string; title: string } | null>(null)
  const [renameBusy, setRenameBusy] = useState(false)
  const [renameErr, setRenameErr] = useState<string | null>(null)

  const submitRename = async () => {
    if (!renameSession) return
    const title = renameSession.title.trim()
    // ★空标题不提交:服务端不校验,提交上去会得到一条没名字的会话。
    if (!title) return
    setRenameBusy(true)
    setRenameErr(null)
    try {
      await invoke(CH.sessionRename, [{ workspacePath: renameSession.wsPath, sessionId: renameSession.id, title }])
      setRenameSession(null)
      refresh()
    } catch (e) {
      setRenameErr(e instanceof Error ? e.message : String(e))
    } finally {
      setRenameBusy(false)
    }
  }

  /**
   * 一行会话左滑露出的动作格。
   *
   * ★★数组顺序 = 从左到右,而左滑时最先露出、离手指最近的是**最右边**那一格。
   *  所以破坏性的「删除」放在数组第一个(屏幕上最左、离手指最远),先露出来的是无害的
   *  「重命名」。手指停在右边缘那一带最容易误触,最危险的那个必须离它最远。
   *  ★Task 9 的工作区左滑用**同一条规矩**,两处不许不一致 —— 同一个手势在两种行上
   *  炸不同的雷是最坏的一种设计。
   *
   * ★★删不掉的时候**整格不摆**,不是摆一个灰的:摆灰的等于说「这里有个删除,只是现在点不了」,
   *  而真相是「这个工作区只剩这一条了」。★★绝不能摆一颗按下去无声无息的红按钮 ——
   *  服务端在这种情况下会静默原样返回,连个错都不报(见 sessionOps.ts)。
   */
  const sessionActions = (g: WsGroup, s: ChatSession): SwipeAction[] => {
    const del = sessionCanDelete(g.sessions, s.id)
    return [
      ...(del.ok
        ? [{ key: 'del', label: '删除', tone: 'danger' as const, onPress: () => { void confirmDeleteSession(g.ws.path, s) } }]
        : []),
      {
        key: 'rename',
        label: '重命名',
        tone: 'plain' as const,
        onPress: () => { setRenameErr(null); setRenameSession({ wsPath: g.ws.path, id: s.id, title: s.title }) },
      },
    ]
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
   * (新建**工作区**是另一条路:顶栏右上角那颗 ＋(`ROUTES.newWorkspace`,见下面 `TopBar`)。
   *  「列表最底下那颗按钮」已经不是常驻入口了 —— 那颗按钮现在只在**一个工作区都没有**的
   *  空态里出现,是那句「先建一个」的附带动作,不是并列的第二个入口。)
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

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      {/* ★★顶栏一整条是**主机横幅**。原来右边那颗 ⚙ 已经挪到底部第三格 tab 了,
          空出来的位置给「＋ 新建工作区」—— 微信的「发起群聊 / 添加朋友」也在右上角的 ＋ 里,
          从来不在底栏。tab 的每一格必须是能停留的页面,而「新建」是个动作。
          ★真机反馈:caption 写全名「新建工作区」在 40pt 的按钮里换行,两行 caption 把
          顶栏重新撑高——这一整个 task 存在的目的就是把顶栏压成一行,不能在旁边这颗按钮上
          悄悄长回来。缩成「工作区」(三个字,一行装得下):＋ 图标担着动词,caption 担名词,
          和抽屉里「＋ 新建会话」那种写全名的 ActionRow 不会认错——那些本来就在别的层级上。 */}
      <TopBar
        right={
          <IconBtn label="工作区" onPress={() => router.push(ROUTES.newWorkspace)} disabled={!online}>
            <Icon name="add" size={20} color={online ? c.accent : c.faint} />
          </IconBtn>
        }
      >
        <HostBanner
          label={activeHost?.label ?? ''}
          url={activeHost?.url ?? ''}
          state={state}
          // ★★没连上的时候 `gates` 是断线前留在内存里的旧数据(第一版不缓存正文,
          //  但没有专门清这个数组)——不跟着 `online` 收起来的话,断线态的横幅会一边说
          //  「连不上」一边挂着一枚「等你答话」,而列表主体已经换成了诚实的「未连接」空态。
          //  同一条规矩已经在 `showsRows`/定位气泡上用过一次(见下面 `showsRows` 的注释),
          //  这里只是把它补给两枚门徽章(还有 `app/(tabs)/_layout.tsx` 那枚 tab 角标,同源同条件)。
          gateCount={online ? gates.length : 0}
          onPress={() => setHostSheet(true)}
        />
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
              <Btn kind="pri" block onPress={() => router.push(ROUTES.newWorkspace)}>
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
                    `Sec` 本身没动 —— 另外 6 个屏还在拿它当真正的分节标签用。
                    ★★`SwipeRow` 在这层 `onLayout` **里面**,不是外面 —— 套外面就少算一层偏移,
                    定位气泡会滚偏,而且一条测试都不会红(见 SwipeRow.tsx 的 JSDoc,同一条规矩)。 */}
                <SwipeRow actions={wsActions(g.ws)}>
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
                </SwipeRow>
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
                                `SwipeRow` 和 `SessionRow` 都长在它**里面**,不是在它**外面**又套了一层 ——
                                外面套一层的话三段 y 就少算了新那一层的偏移,症状是气泡稳定地
                                滚偏一截,而且一条测试都不会红。见 SwipeRow.tsx 的 JSDoc,同一条规矩。
                                ★这一层自己**绝不许有纵向 margin/padding**。给它加 paddingTop 不会改变
                                rowY.current[key](padding 不移动盒子自身相对父容器的位置),却会把可见内容
                                整体下推 —— 于是气泡的算术仍然「正确」,滚到的却是错的行,而且**一条测试
                                都不会红**。行齐平之后这里没有缝要撑,这一层的高度就是 SessionRow 的高度。 */}
                            <SwipeRow actions={sessionActions(g, s)}>
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
                            </SwipeRow>
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
          </>
        )}
        {/* ★★同一条 online 门:disconnected 时这句「N 道门挂着」和上面的旧 gates 一样是
            断线前留在内存里的旧数据,不判 online 会在「未连接」空态下面又说一遍反话——
            这是同一个缺陷的第三处,和 HostBanner 的 gateCount、_layout.tsx 的 tabBarBadge
            同一条件。 */}
        {online && gates.length > 0 && (
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
          别的主机上有没有门,不连上去是不知道的,所以那几台一个字都不写(见 hostPicker.ts)。
          ★★第四处同一条 online 门:`hostPicker.ts` 的 `active` 只判「是不是当前选中那台」,
          跟「连没连上」是两件事——断线时不判 online,这张单子上「当前这台」还是会顶着一枚
          上一次连上时留下的旧门徽章,和 HostBanner/tab 角标/门汇总句是同一个缺陷。 */}
      <HostSwitchSheet
        open={hostSheet}
        rows={hostPickRows(hosts, activeHost?.id ?? null, state, online ? gates.length : 0)}
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

      {/* 分组头长按呼出的操作单。★左滑是主入口,长按是备份 + 无障碍路径 —— 副标题两样都提,
          否则人答完这道单子关掉之后再也想不起来是怎么叫出来的。 */}
      <Sheet
        open={!!wsSheet}
        onClose={() => setWsSheet(null)}
        title={wsSheet?.name ?? ''}
        sub="左滑工作区行,或长按分组头随时叫出这张单子"
      >
        {wsErr ? (
          <View style={{ padding: 11, borderRadius: 12, borderWidth: 1, borderColor: c.permFullBorder, backgroundColor: c.bg2 }}>
            <T style={{ fontSize: 13, lineHeight: 20, color: c.err }}>{wsErr}</T>
          </View>
        ) : null}
        <Btn block disabled={wsBusy} onPress={() => { if (wsSheet) void togglePinnedFor(wsSheet) }}>
          {wsSheet?.pinned ? '取消置顶' : '置顶'}
        </Btn>
        <View style={{ height: 12 }} />
        <Btn
          block
          disabled={wsBusy}
          onPress={() => {
            const ws = wsSheet
            if (!ws) return
            setWsSheet(null)
            setRenameWsErr(null)
            setRenameWs({ path: ws.path, name: ws.name })
          }}
        >
          重命名
        </Btn>
        {/* ★danger 不与主动作相邻(设计文档 §7.6)——这段空隙就是唯一目的。 */}
        <View style={{ height: 20 }} />
        <View>
          <Btn kind="danger" block disabled={wsBusy} onPress={() => { if (wsSheet) archiveWs(wsSheet) }}>
            归档
          </Btn>
          <T style={{ fontSize: 11.5, lineHeight: 17, color: c.muted, marginTop: 6 }}>
            归档后从列表消失,在 设置 → 已归档的工作区 里恢复
          </T>
        </View>
      </Sheet>

      {/* 工作区左滑「重命名」/长按单子「重命名」共用的那张 Sheet。 */}
      <Sheet
        open={!!renameWs}
        onClose={() => setRenameWs(null)}
        title="重命名工作区"
        sub="改完点保存,列表和分组头都会跟着变"
      >
        {renameWsErr ? (
          <View style={{ padding: 11, borderRadius: 12, borderWidth: 1, borderColor: c.permFullBorder, backgroundColor: c.bg2 }}>
            <T style={{ fontSize: 13, lineHeight: 20, color: c.err }}>{renameWsErr}</T>
          </View>
        ) : null}
        <Field
          value={renameWs?.name ?? ''}
          onChangeText={(t) => setRenameWs((prev) => (prev ? { ...prev, name: t } : prev))}
          placeholder="工作区名称"
          autoFocus
          onSubmitEditing={() => void submitRenameWs()}
        />
        {/* ★空名不提交(submitRenameWs 里 trim 后判空):这颗按钮同时用 disabled 挡一遍,
            两道拦截同一个理由 —— 服务端不校验空名,提交上去会得到一个没名字的工作区。 */}
        <Btn kind="pri" block disabled={renameWsBusy || !renameWs?.name.trim()} onPress={() => void submitRenameWs()}>
          保存
        </Btn>
      </Sheet>

      {/* 会话左滑「重命名」弹出的单子。 */}
      <Sheet
        open={!!renameSession}
        onClose={() => setRenameSession(null)}
        title="重命名会话"
        sub="改完点保存,列表和对话屏顶栏都会跟着变"
      >
        {renameErr ? (
          <View style={{ padding: 11, borderRadius: 12, borderWidth: 1, borderColor: c.permFullBorder, backgroundColor: c.bg2 }}>
            <T style={{ fontSize: 13, lineHeight: 20, color: c.err }}>{renameErr}</T>
          </View>
        ) : null}
        <Field
          value={renameSession?.title ?? ''}
          onChangeText={(t) => setRenameSession((prev) => (prev ? { ...prev, title: t } : prev))}
          placeholder="会话名称"
          autoFocus
          onSubmitEditing={() => void submitRename()}
        />
        {/* ★空标题不提交(submitRename 里 trim 后判空):这颗按钮同时用 disabled 挡一遍,
            两道拦截同一个理由 —— 服务端不校验空标题,提交上去会得到一条没名字的会话。 */}
        <Btn kind="pri" block disabled={renameBusy || !renameSession?.title.trim()} onPress={() => void submitRename()}>
          保存
        </Btn>
      </Sheet>
    </View>
  )
}

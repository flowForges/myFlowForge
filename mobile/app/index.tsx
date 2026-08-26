import { useCallback, useMemo, useRef, useState } from 'react'
import { ScrollView, View } from 'react-native'
import { router } from 'expo-router'
import { CH } from '../../src/main/ipc/channels'
import type { SessionsFile } from '../../src/shared/types'
import { fmtRelTime } from '../../src/shared/relTime'
import { useC } from '../src/theme/theme'
import { Btn, Empty, IconBtn, List, LiveDot, Pill, Row, Sec, T, TopBar, TopTitle } from '../src/ui/kit'
import { Sheet } from '../src/ui/Sheet'
import { JumpBubble } from '../src/ui/JumpBubble'
import { useConn } from '../src/net/conn'
import { useStore, type WsGroup } from '../src/data/store'
import { isSessionUnread } from '@shared/chat/unread'
import { tierOf, countTiers, topTier, type SessionTier } from '../src/data/sessionStatus'
import { StatusBadge } from '../src/ui/StatusBadge'

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
export default function Home() {
  const c = useC()
  const { activeHost, hosts, loading: hostsLoading, online, state, invoke } = useConn()
  const { groups, gates, gatesFor, loading, select, wsName, refresh, unread, running } = useStore()
  const now = Date.now()
  const [newSheet, setNewSheet] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newErr, setNewErr] = useState<string | null>(null)

  const tierFor = (wsPath: string, sessionId: string): SessionTier =>
    tierOf({
      hasGate: gatesFor(wsPath, sessionId).length > 0,
      running: running.has(sessionId),
      unread: isSessionUnread(unread, wsPath, sessionId),
    })

  // 新建会话:手机上能做。新建**工作区**不做 —— 那要选目录、要克隆仓库,留在电脑端。
  const newSession = async (wsPath: string) => {
    setCreating(true)
    setNewErr(null)
    try {
      const file = (await invoke(CH.sessionNew, [wsPath])) as SessionsFile
      const created = file.sessions.find((s) => s.id === file.activeSessionId) ?? file.sessions[0]
      if (!created) throw new Error('对面建好了会话,但没告诉我是哪一个')
      select({ wsPath, sessionId: created.id })
      refresh()
      setNewSheet(false)
      // 建好就直接进去 —— 建会话的意图就是「我要在这儿说点什么」。
      router.push('/chat')
    } catch (e) {
      // ★原来这里只有 try/finally,没有 catch:建失败就是**彻底无声**。
      //  真机上报的「无法新增会话」如果是服务端拒绝(比如工作区已归档),你一个字都看不到。
      setNewErr(e instanceof Error ? e.message : String(e))
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
   * (置顶的操作入口在二期做;这里先把读的那一半接上,已经钉过的立刻生效。)
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

  const scrollRef = useRef<ScrollView>(null)
  // 三段 y,拼起来才是一行会话在滚动内容里的**绝对**位置 —— 见下面 `absY()` 的注释
  // 和 JSX 里三处 onLayout(工作区分组 View / 包 List 的裸 View / 每行 wrapper)。
  const groupY = useRef<Record<string, number>>({})
  const listY = useRef<Record<string, number>>({})
  const rowY = useRef<Record<string, number>>({})
  const scrollY = useRef(0)
  const viewH = useRef(0)

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
  const absY = (wsPath: string, key: string): number | undefined => {
    const gy = groupY.current[wsPath]
    const ly = listY.current[wsPath]
    const ry = rowY.current[key]
    if (gy === undefined || ly === undefined || ry === undefined) return undefined
    return gy + ly + ry
  }

  // 所有非 idle 的会话,按它们在列表里的先后排好 —— 气泡要跳的就是这一串。
  // key 用 NUL(`\0`)分隔而不是空格/逗号:两者都是 POSIX 路径的合法字符,
  // 用它们做分隔符会让两个不同的 (workspacePath, sessionId) 撞成同一个 key,
  // 症状是气泡滚到错的那一行。@shared/chat/unread 的 key() 用的是同一个理由。
  const pending = ordered.flatMap((g) =>
    g.sessions
      .map((s) => ({ key: `${g.ws.path}\0${s.id}`, wsPath: g.ws.path, tier: tierFor(g.ws.path, s.id) }))
      .filter((x) => x.tier !== 'idle'),
  )
  const counts = countTiers(pending.map((p) => p.tier))
  const top = topTier(counts)
  // 只在最高那一档里挑目标 —— 气泡说「1 条等你答话」就该跳到门那条,不是跳到别的。
  const targets = top
    ? pending.filter((p) => p.tier === top).map((p) => ({ key: p.key, wsPath: p.wsPath }))
    : []
  // 第一个**不在视口内**的目标。全在视口里就不显示气泡:它指的东西你已经看见了。
  // 三段 y 没测全(absY 返回 undefined)也当作「不在视口内」处理 —— 宁可气泡多等一帧
  // 首屏布局跑完,不能拿 undefined 当 0 用,那会把没测到的目标误判成「就在顶上」。
  const nextTarget = targets.find((t) => {
    const y = absY(t.wsPath, t.key)
    return y === undefined || y < scrollY.current || y > scrollY.current + viewH.current
  })
  const direction: 'up' | 'down' =
    nextTarget !== undefined && (absY(nextTarget.wsPath, nextTarget.key) ?? 0) < scrollY.current
      ? 'up'
      : 'down'

  const jump = useCallback(() => {
    if (nextTarget === undefined) return
    const y = absY(nextTarget.wsPath, nextTarget.key)
    if (y === undefined) return
    // 往上留 24px,让目标不要正好贴在顶栏下沿。
    scrollRef.current?.scrollTo({ y: Math.max(0, y - 24), animated: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- absY 读 ref,不是响应式依赖
  }, [nextTarget])

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
      <TopBar
        right={
          <View style={{ flexDirection: 'row' }}>
            <IconBtn onPress={() => router.push('/hosts')}>🖥</IconBtn>
            <IconBtn onPress={online ? () => setNewSheet(true) : undefined} disabled={!online}>
              ＋
            </IconBtn>
          </View>
        }
      >
        <TopTitle
          title="myFlowForge"
          sub={
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
              <LiveDot tone={tone} />
              <T numberOfLines={1} style={{ fontSize: 11.5, color: c.muted }}>
                {activeHost?.label ?? '未选主机'}
              </T>
            </View>
          }
        />
      </TopBar>

      <ScrollView
        ref={scrollRef}
        scrollEventThrottle={64}
        onScroll={(e) => { scrollY.current = e.nativeEvent.contentOffset.y }}
        onLayout={(e) => { viewH.current = e.nativeEvent.layout.height }}
        contentContainerStyle={{ paddingBottom: 96 }}
      >
        {!online ? (
          <Empty title="未连接" desc={'连上才有数据 —— 第一版不缓存,\n所以这里不会拿旧内容假装在线。'} />
        ) : loading ? (
          <Empty title="正在读取…" />
        ) : ordered.length === 0 ? (
          <Empty title="这台机器上还没有工作区" desc="新建工作区留在电脑端。" />
        ) : (
          ordered.map((g) => {
            const wsGates = gatesFor(g.ws.path)
            const sessions = [...g.sessions].sort(
              (a, b) => (b.lastMessageAt ?? b.createdAt) - (a.lastMessageAt ?? a.createdAt),
            )
            return (
              // 定位气泡 absY() 三段 y 的第①段:这层 View 是 ScrollView 内容的直接子节点,
              // 所以 onLayout 给的 y 就是相对整个滚动内容的绝对值,记进 groupY[wsPath]。
              // 另外两段:下面包住 <List> 的裸 View(第②段,listY)、每行外面的 View(第③段,rowY,
              // 在 sessions.map 里)。三段的 key/wsPath 必须对得上,少一段 absY() 就返回 undefined ——
              // 缺了不会报错,只会让气泡悄悄指错方向或不出现。没用 measureLayout 等原生测量 API:
              // 新架构(Fabric,见 app.json 的 newArchEnabled)下的行为这个环境没法验证。
              <View
                key={g.ws.path}
                onLayout={(e) => { groupY.current[g.ws.path] = e.nativeEvent.layout.y }}
              >
                <Sec
                  right={(() => {
                    const counts = countTiers(g.sessions.map((s) => tierFor(g.ws.path, s.id)))
                    if (counts.gate) return <StatusBadge tier="gate" count={counts.gate} />
                    if (counts.running) return <StatusBadge tier="running" count={counts.running} />
                    if (counts.unread) return <StatusBadge tier="unread" count={counts.unread} />
                    return (
                      <T mono style={{ fontSize: 10.5, color: c.faint }}>
                        {g.ws.projectCount} 个项目
                      </T>
                    )
                  })()}
                >
                  {g.ws.name}
                </Sec>
                {sessions.length === 0 ? (
                  <Empty title="还没有人在这个工作区开过会话" desc="新建会话这类操作手机上也能做,但新建工作区留在电脑端。" />
                ) : (
                  // 定位气泡 absY() 三段 y 的第②段:这层裸 View(**不能加 style**,否则会在
                  // List 原本的纵向 flex 列里插进一段意外的间距/内边距)只用来测 List 相对上面
                  // 分组 View(第①段,groupY)的偏移,记进 listY[wsPath]。第③段是下面每行外面
                  // 的 View(rowY)。三段缺一个,absY() 就返回 undefined —— 气泡不会报错,
                  // 只会悄悄滚到错的位置。没用 measureLayout 等原生测量 API:新架构(Fabric)
                  // 下的行为这个环境没法验证,onLayout 在新旧架构都确定支持。
                  <View onLayout={(e) => { listY.current[g.ws.path] = e.nativeEvent.layout.y }}>
                    <List>
                      {sessions.map((s) => {
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
                            <Row
                              gate={sg.length > 0}
                              onPress={() => {
                                select({ wsPath: g.ws.path, sessionId: s.id })
                                router.push('/chat')
                              }}
                            >
                              <View style={{ flex: 1, minWidth: 0 }}>
                                <T numberOfLines={1} style={{ fontSize: 15, fontWeight: '600', color: c.fg }}>
                                  {s.title || '新会话'}
                                </T>
                                <View
                                  style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 3, flexWrap: 'wrap' }}
                                >
                                  <T mono style={{ fontSize: 11.5, color: c.muted }}>
                                    {(s.agentId ?? '').trim() || (s.mode === 'workflow' ? '工作流' : '对话')}
                                    {' · '}
                                    {fmtRelTime(s.lastMessageAt ?? s.createdAt, now) || '—'}
                                  </T>
                                  {sg.length > 0 && <Pill tone="gate">待确认 {sg.length}</Pill>}
                                </View>
                              </View>
                              <StatusBadge tier={tierFor(g.ws.path, s.id)} />
                              <T style={{ fontSize: 15, color: c.faint }}>›</T>
                            </Row>
                          </View>
                        )
                      })}
                    </List>
                  </View>
                )}
              </View>
            )
          })
        )}
        {gates.length > 0 && (
          <View style={{ paddingHorizontal: 15, paddingTop: 18 }}>
            <T style={{ fontSize: 11.5, color: c.faint, lineHeight: 19 }}>
              {gates.length} 道门挂在 {new Set(gates.map((x) => wsName(x.wsPath))).size} 个工作区上,代理在等你回答。
            </T>
          </View>
        )}
      </ScrollView>

      {top && nextTarget !== undefined ? (
        <JumpBubble tier={top} count={counts[top]} direction={direction} onPress={jump} />
      ) : null}

      <Sheet open={newSheet} onClose={() => setNewSheet(false)} title="新建会话" sub="选一个工作区。新建工作区留在电脑端。">
        {newErr ? (
          <View style={{ padding: 11, borderRadius: 12, borderWidth: 1, borderColor: c.permFullBorder, backgroundColor: c.bg2 }}>
            <T style={{ fontSize: 13, lineHeight: 20, color: c.err }}>{newErr}</T>
          </View>
        ) : null}
        {groups.length === 0 ? <Empty title="没有可用的工作区" desc="连上主机之后这里才有内容。" /> : null}
        {groups.map((g) => (
          <Row key={g.ws.path} disabled={creating} onPress={() => void newSession(g.ws.path)}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <T style={{ fontSize: 14.5, fontWeight: '600', color: c.fg }}>{g.ws.name}</T>
              <T numberOfLines={1} mono style={{ fontSize: 11.5, color: c.muted, marginTop: 3 }}>
                {g.ws.path}
              </T>
            </View>
          </Row>
        ))}
      </Sheet>
    </View>
  )
}

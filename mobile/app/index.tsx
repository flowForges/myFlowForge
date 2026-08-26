import { useMemo, useState } from 'react'
import { ScrollView, View } from 'react-native'
import { router } from 'expo-router'
import { CH } from '../../src/main/ipc/channels'
import type { SessionsFile } from '../../src/shared/types'
import { fmtRelTime } from '../../src/shared/relTime'
import { useC } from '../src/theme/theme'
import { Btn, Empty, IconBtn, List, LiveDot, Pill, Row, Sec, T, TopBar, TopTitle } from '../src/ui/kit'
import { Sheet } from '../src/ui/Sheet'
import { useConn } from '../src/net/conn'
import { useStore, type WsGroup } from '../src/data/store'
import { isSessionUnread } from '@shared/chat/unread'
import { tierOf, countTiers, type SessionTier } from '../src/data/sessionStatus'
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

      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
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
              <View key={g.ws.path}>
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
                  <List>
                    {sessions.map((s) => {
                      const sg = wsGates.filter((x) => x.sessionId === s.id)
                      return (
                        <Row
                          key={s.id}
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
                      )
                    })}
                  </List>
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

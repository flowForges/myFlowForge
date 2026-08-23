import { useMemo, useState } from 'react'
import { ScrollView, View } from 'react-native'
import { router } from 'expo-router'
import { CH } from '../../src/main/ipc/channels'
import type { SessionsFile } from '../../src/shared/types'
import { fmtRelTime } from '../../src/shared/relTime'
import { useC } from '../src/theme/theme'
import { Empty, IconBtn, List, LiveDot, Pill, Row, Sec, T, TopBar, TopTitle } from '../src/ui/kit'
import { Sheet } from '../src/ui/Sheet'
import { useConn } from '../src/net/conn'
import { useStore, type WsGroup } from '../src/data/store'

/**
 * 全部会话,按工作区分组。
 *
 * ★这一屏最重要的一件事不是「列出会话」,是**一眼看出哪条挂着门**。
 *   挂着门的工作区整组顶到最上面,那条会话本身染成琥珀底 + 琥珀边。
 *   其余一律中性 —— 屏幕上同时出现两种彩色,门就不再是唯一的那个了。
 */
export default function Sessions() {
  const c = useC()
  const { activeHost, online, state, invoke } = useConn()
  const { groups, gates, gatesFor, loading, select, wsName, refresh } = useStore()
  const now = Date.now()
  const [newSheet, setNewSheet] = useState(false)
  const [creating, setCreating] = useState(false)

  // 新建会话:手机上能做。新建**工作区**不做 —— 那要选目录、要克隆仓库,留在电脑端。
  const newSession = async (wsPath: string) => {
    setCreating(true)
    try {
      const file = (await invoke(CH.sessionNew, [wsPath])) as SessionsFile
      const created = file.sessions.find((s) => s.id === file.activeSessionId) ?? file.sessions[0]
      if (created) select({ wsPath, sessionId: created.id })
      refresh()
      setNewSheet(false)
      router.back()
    } finally {
      setCreating(false)
    }
  }

  const ordered = useMemo(() => {
    const gateWs = new Set(gates.map((g) => g.wsPath))
    const score = (g: WsGroup) => (gateWs.has(g.ws.path) ? 0 : 1)
    return [...groups].sort((a, b) => {
      const d = score(a) - score(b)
      if (d) return d
      const at = Math.max(0, ...a.sessions.map((s) => s.lastMessageAt ?? s.createdAt))
      const bt = Math.max(0, ...b.sessions.map((s) => s.lastMessageAt ?? s.createdAt))
      return bt - at
    })
  }, [groups, gates])

  const tone = state?.status === 'ready' ? 'ok' : state?.status === 'connecting' ? 'wait' : 'off'

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <TopBar
        left={<IconBtn onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}>‹</IconBtn>}
        right={
          <IconBtn onPress={online ? () => setNewSheet(true) : undefined} disabled={!online}>
            ＋
          </IconBtn>
        }
      >
        <TopTitle
          title="全部会话"
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
            const sessions = [...g.sessions].sort((a, b) => {
              const ag = wsGates.some((x) => x.sessionId === a.id) ? 0 : 1
              const bg = wsGates.some((x) => x.sessionId === b.id) ? 0 : 1
              if (ag !== bg) return ag - bg
              return (b.lastMessageAt ?? b.createdAt) - (a.lastMessageAt ?? a.createdAt)
            })
            return (
              <View key={g.ws.path}>
                <Sec
                  right={
                    <T mono style={{ fontSize: 10.5, color: c.faint }}>
                      {g.ws.projectCount} 个项目
                    </T>
                  }
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
                            router.back()
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

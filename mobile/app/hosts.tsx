import { Alert, Platform, Pressable, ScrollView, View } from 'react-native'
import { router } from 'expo-router'
import { goBack } from '../src/nav'
import { useC } from '../src/theme/theme'
import { Btn, Empty, IconBtn, List, LiveDot, Note, Pill, Row, Sec, T, TopBar, TopTitle } from '../src/ui/kit'
import { useConn } from '../src/net/conn'
import { DEFAULT_HOST_ICON, type MobileHost } from '../src/net/hosts'
import { useStore } from '../src/data/store'
// 一句人话的连接状态。★这一份和设置屏共用同一个实现,别在任何一边抄第二遍 —— 见该文件注释。
import { describeHostState } from '../src/net/hostStatusText'

export default function Hosts() {
  const c = useC()
  const { hosts, activeHost, state, selectHost, removeHost, reconnect, methods } = useConn()
  const { gates } = useStore()

  const remove = (h: MobileHost) => {
    const go = () => void removeHost(h.id)
    if (Platform.OS === 'web') {
      // RN-web 的 Alert 只有一个按钮,确认框走 window.confirm 才是真能选的。
      // eslint-disable-next-line no-alert
      if (typeof window !== 'undefined' && window.confirm(`删除主机「${h.label}」?`)) go()
      return
    }
    Alert.alert('删除主机', `删除「${h.label}」?手机上不再记住它的地址和令牌。`, [
      { text: '取消', style: 'cancel' },
      { text: '删除', style: 'destructive', onPress: go },
    ])
  }

  const d = describeHostState(state)

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <TopBar left={<IconBtn onPress={() => (goBack())}>‹</IconBtn>}>
        <TopTitle title="主机" sub="同一时间只连一台" />
      </TopBar>

      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        {hosts.length === 0 ? (
          <Empty
            title="还没有配过主机"
            desc={'在电脑上跑起 daemon,把它打印的地址填进来。\n手机和电脑要在同一个 wifi 里。'}
          />
        ) : (
          <>
            <Sec>已配对</Sec>
            <List>
              {hosts.map((h) => {
                const active = h.id === activeHost?.id
                const st = active ? d : { text: '未连接', tone: 'idle' as const }
                const gateN = active ? gates.length : 0
                return (
                  <Row key={h.id} onPress={() => void selectHost(h.id)}>
                    <View
                      style={{
                        width: 34,
                        height: 34,
                        borderRadius: 10,
                        backgroundColor: c.bg2,
                        borderWidth: 1,
                        borderColor: c.border2,
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <T style={{ fontSize: 16 }}>{h.icon || DEFAULT_HOST_ICON}</T>
                    </View>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <T numberOfLines={1} style={{ fontSize: 15, fontWeight: '600', color: c.fg }}>
                        {h.label}
                      </T>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 }}>
                        {active && <LiveDot tone={st.tone === 'idle' ? 'off' : st.tone} />}
                        <T numberOfLines={1} mono style={{ fontSize: 11.5, color: c.muted, flexShrink: 1 }}>
                          {/* 连上了就报地址和对面版本;没连上就报**为什么没连上** ——
                              那时「已连接」右边那枚 pill 已经不在了,这一行才是唯一的信息。 */}
                          {active && st.tone === 'ok'
                            ? `${h.url.replace(/^wss?:\/\//, '')} · ${state?.status === 'ready' ? state.version : ''}`
                            : active
                              ? st.text
                              : h.url.replace(/^wss?:\/\//, '')}
                        </T>
                      </View>
                    </View>
                    {gateN > 0 ? (
                      <Pill tone="gate">{gateN} 个门</Pill>
                    ) : active && st.tone === 'ok' ? (
                      <Pill tone="run">已连接</Pill>
                    ) : null}
                    <Pressable onPress={() => remove(h)} hitSlop={10} style={{ paddingHorizontal: 4 }}>
                      <T style={{ fontSize: 15, color: c.faint }}>✕</T>
                    </Pressable>
                  </Row>
                )
              })}
            </List>
          </>
        )}

        <View style={{ height: 16 }} />
        <List>
          <Btn kind="ghost" block onPress={() => router.push('/add-host')}>
            添加主机
          </Btn>
          {state?.status === 'failed' || state?.status === 'retrying' ? (
            <Btn block onPress={reconnect}>
              重新连接
            </Btn>
          ) : null}
        </List>

        {activeHost && state?.status === 'ready' ? (
          <>
            <Sec>这台机器提供</Sec>
            <Note>
              {methods.size} 个方法。对不上的功能会在界面上置灰,而不是点下去报一句看不懂的错。
            </Note>
          </>
        ) : null}

        <Note>切过去之后,会话、变更、终端全部换成那台机器的。不做同屏对比。</Note>
      </ScrollView>
    </View>
  )
}

import { useState } from 'react'
import { Alert, Platform, ScrollView, View } from 'react-native'
import { router } from 'expo-router'
import { goBack } from '../src/nav'
import { useC, useTheme } from '../src/theme/theme'
import { Btn, IconBtn, List, LiveDot, Note, Row, Sec, T, TopBar, TopTitle } from '../src/ui/kit'
import { Sheet } from '../src/ui/Sheet'
import { CLIENT_VERSION, useConn } from '../src/net/conn'
import { DEFAULT_HOST_ICON } from '../src/net/hosts'
// 一句人话的连接状态。★和 `app/hosts.tsx` 共用同一份 —— 两屏说同一台机器的状态,
// 说法必须一个字都不差,否则人只会觉得其中一屏在骗他。
import { describeHostState } from '../src/net/hostStatusText'
import { clearLocalData } from '../src/data/localData'
import type { TextSize, ThemePref } from '../src/data/prefs'

/**
 * 设置。**故意只有三组**,比电脑端简单一个量级(设计文档 §7.2):
 * 主机 / 外观(跟着这台手机走)/ 这台手机。
 *
 * 没有工作流、阶段、插件、宠物、壁纸 —— 那些留在电脑端。手机是用来盯梢和答门的,
 * 不是用来配置的;把电脑端那一整面墙搬过来只会让「加个主机」这件事变得找不到。
 *
 * ★**这一屏在没连主机时也必须能用**:它是「添加主机」和「清除本地数据」的唯一入口。
 *  顶上绝不能写 `if (!online) return <Empty/>` —— 那会把断线的人锁在外面,
 *  而断线恰恰是最需要进来改主机的时候。
 */

const THEMES: { id: ThemePref; label: string; desc: string }[] = [
  { id: 'system', label: '跟随系统', desc: '手机切了深/浅色,这里跟着切' },
  { id: 'light', label: '浅色', desc: '一直是浅的,不管系统怎么设' },
  { id: 'dark', label: '深色', desc: '一直是深的,不管系统怎么设' },
]

const TEXTS: { id: TextSize; label: string; desc: string }[] = [
  { id: 'sm', label: '小', desc: '一屏装得下更多' },
  { id: 'md', label: '标准', desc: '默认' },
  { id: 'lg', label: '大', desc: '看得清一点' },
]

export default function Settings() {
  const c = useC()
  const { pref, setPref, text, setText } = useTheme()
  const { hosts, activeHost, state, selectHost } = useConn()
  const [themeSheet, setThemeSheet] = useState(false)
  const [textSheet, setTextSheet] = useState(false)

  const d = describeHostState(state)
  const others = hosts.filter((h) => h.id !== activeHost?.id)

  const clear = () => {
    const go = async () => {
      await clearLocalData()
      // 内存里那份也得跟着空掉,不然界面上还挂着一台已经没有令牌的主机。
      await selectHost(null)
      // 回根屏:这一屏说的每一样东西都不存在了,留在原地看着的是一屏幻觉。
      router.replace('/')
    }
    const msg = '主机清单和令牌都存在这台手机上。清掉之后要重新扫码配对。'
    if (Platform.OS === 'web') {
      // RN-web 的 Alert 只有一个按钮,确认框走 window.confirm 才是真能选的。
      // eslint-disable-next-line no-alert
      if (typeof window !== 'undefined' && window.confirm(`清除本地数据?\n${msg}`)) void go()
      return
    }
    Alert.alert('清除本地数据', msg, [
      { text: '取消', style: 'cancel' },
      { text: '清除', style: 'destructive', onPress: () => void go() },
    ])
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <TopBar left={<IconBtn onPress={() => goBack()}>‹</IconBtn>}>
        <TopTitle title="设置" sub="主机跟着那台电脑,外观跟着这台手机" />
      </TopBar>

      <ScrollView contentContainerStyle={{ paddingBottom: 44 }}>
        <Sec>主机</Sec>
        <List>
          {activeHost ? (
            <Row>
              <HostIcon icon={activeHost.icon} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <T numberOfLines={1} style={{ fontSize: 15, fontWeight: '600', color: c.fg }}>
                  {activeHost.label}
                </T>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 }}>
                  <LiveDot tone={d.tone === 'idle' ? 'off' : d.tone} />
                  <T numberOfLines={1} mono style={{ fontSize: 11.5, color: c.muted, flexShrink: 1 }}>
                    {/* 连上了报地址和对面版本;没连上就报**为什么** —— 这一行是断线时
                        屏幕上唯一说明原因的地方,写成一句「未连接」等于什么也没说。 */}
                    {d.tone === 'ok'
                      ? `${activeHost.url.replace(/^wss?:\/\//, '')} · ${state?.status === 'ready' ? state.version : ''}`
                      : d.text}
                  </T>
                </View>
              </View>
              {/* 断开是破坏性的,用 danger;它待在这一行的右边,和下面那两个主动作隔着一整段。 */}
              <Btn kind="danger" size="sm" onPress={() => void selectHost(null)}>
                断开
              </Btn>
            </Row>
          ) : (
            <Row onPress={() => router.push('/add-host')}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <T style={{ fontSize: 15, fontWeight: '600', color: c.fg }}>还没连主机</T>
                <T style={{ fontSize: 12, color: c.muted, marginTop: 3 }}>
                  在电脑上跑起 daemon,把它打印的地址填进来
                </T>
              </View>
              <T style={{ fontSize: 16, color: c.faint }}>›</T>
            </Row>
          )}
        </List>

        {others.length > 0 ? (
          <>
            <Sec>其他主机</Sec>
            <List>
              {others.map((h) => (
                // 点即切。★不弹确认:切主机是可逆的(再点回来就行),而多一步确认会让
                //  「我到底连的哪台」这件事更难当场试出来。
                <Row key={h.id} onPress={() => void selectHost(h.id)}>
                  <HostIcon icon={h.icon} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <T numberOfLines={1} style={{ fontSize: 15, fontWeight: '600', color: c.fg }}>
                      {h.label}
                    </T>
                    <T numberOfLines={1} mono style={{ fontSize: 11.5, color: c.muted, marginTop: 3 }}>
                      {h.url.replace(/^wss?:\/\//, '')}
                    </T>
                  </View>
                  <T style={{ fontSize: 16, color: c.faint }}>›</T>
                </Row>
              ))}
            </List>
          </>
        ) : null}

        <View style={{ height: 12 }} />
        <List>
          <Btn kind="ghost" block onPress={() => router.push('/add-host')}>
            ＋ 添加主机
          </Btn>
          <Btn kind="ghost" block onPress={() => router.push('/hosts')}>
            管理主机
          </Btn>
        </List>
        <Note>删除主机、手动重连都在「管理主机」那一屏里。切过去之后,会话、变更、终端全部换成那台机器的。</Note>

        <Sec>外观 · 跟着这台手机走</Sec>
        <List>
          <Pick label="主题" value={THEMES.find((t) => t.id === pref)?.label ?? ''} onPress={() => setThemeSheet(true)} />
          <Pick label="正文字号" value={TEXTS.find((t) => t.id === text)?.label ?? ''} onPress={() => setTextSheet(true)} />
        </List>
        <Note>切主机不会改这两样 —— 它们属于你手上这台设备,不属于那台电脑。</Note>

        <Sec>这台手机</Sec>
        <List>
          <Row>
            <T style={{ flex: 1, fontSize: 15, color: c.fg }}>版本号</T>
            <T mono style={{ fontSize: 13, color: c.muted }}>
              {CLIENT_VERSION}
            </T>
          </Row>
        </List>
        <Note>主机清单和令牌都存在这台手机上。清掉之后要重新扫码配对。</Note>

        {/* ★设计文档 §7.2:danger 不与主动作相邻。这一段空白就是为了让手指够不着 ——
            上面最近的一个可点的东西是「版本号」那一行(它根本不可点)。 */}
        <View style={{ height: 24 }} />
        <List>
          <Btn kind="danger" block onPress={clear}>
            清除本地数据
          </Btn>
        </List>
      </ScrollView>

      <Sheet
        open={themeSheet}
        onClose={() => setThemeSheet(false)}
        title="主题"
        sub="存在这台手机上。换主机、重装 app 之外都记着。"
      >
        {THEMES.map((t) => (
          <Opt
            key={t.id}
            label={t.label}
            desc={t.desc}
            on={t.id === pref}
            onPress={() => {
              setPref(t.id)
              setThemeSheet(false)
            }}
          />
        ))}
      </Sheet>

      <Sheet
        open={textSheet}
        onClose={() => setTextSheet(false)}
        title="正文字号"
        sub="整个 app 的字一起变,不只是这一屏。"
      >
        {TEXTS.map((t) => (
          <Opt
            key={t.id}
            label={t.label}
            desc={t.desc}
            on={t.id === text}
            onPress={() => {
              setText(t.id)
              setTextSheet(false)
            }}
          />
        ))}
      </Sheet>
    </View>
  )
}

function HostIcon({ icon }: { icon: string }) {
  const c = useC()
  return (
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
      <T style={{ fontSize: 16 }}>{icon || DEFAULT_HOST_ICON}</T>
    </View>
  )
}

/** 一行「名字 —— 当前值 ›」,点开一个 sheet 选。 */
function Pick({ label, value, onPress }: { label: string; value: string; onPress: () => void }) {
  const c = useC()
  return (
    <Row onPress={onPress}>
      <T style={{ flex: 1, fontSize: 15, color: c.fg }}>{label}</T>
      <T style={{ fontSize: 13.5, color: c.muted }}>{value}</T>
      <T style={{ fontSize: 16, color: c.faint }}>›</T>
    </Row>
  )
}

/** sheet 里的一档。选中态和权限档那个 sheet 同一套写法:描边换成强调色 + 一个 ✓。 */
function Opt({
  label,
  desc,
  on,
  onPress,
}: {
  label: string
  desc: string
  on: boolean
  onPress: () => void
}) {
  const c = useC()
  return (
    <Row onPress={onPress} style={on ? { borderColor: c.accent, backgroundColor: c.accentDim } : undefined}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <T style={{ fontSize: 14.5, fontWeight: '600', color: c.fg }}>{label}</T>
        <T numberOfLines={1} style={{ fontSize: 12.5, color: c.muted, marginTop: 3 }}>
          {desc}
        </T>
      </View>
      {on ? <T style={{ color: c.accent }}>✓</T> : null}
    </Row>
  )
}

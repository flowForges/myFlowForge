import { useState } from 'react'
import { Alert, Platform, ScrollView, View } from 'react-native'
import { router } from 'expo-router'
import { goBack } from '../src/nav'
import { useC, useTheme } from '../src/theme/theme'
import { Btn, IconBtn, List, LiveDot, Note, Row, Sec, T, TopBar, TopTitle } from '../src/ui/kit'
import { Sheet } from '../src/ui/Sheet'
import { CLIENT_VERSION, useConn } from '../src/net/conn'
// 状态那句话和主机行下面那行小字都和 `app/hosts.tsx` 共用同一份 —— 两屏说同一台机器,
// 说法必须一个字都不差,否则人只会觉得其中一屏在骗他。
import { describeHostState, hostSubtitle } from '../src/net/hostStatusText'
import { HostIcon } from '../src/ui/HostIcon'
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
  const { hosts, activeHost, state, selectHost, forgetAll } = useConn()
  const [themeSheet, setThemeSheet] = useState(false)
  const [textSheet, setTextSheet] = useState(false)
  const [wipeErr, setWipeErr] = useState<string | null>(null)

  const d = describeHostState(state)
  const others = hosts.filter((h) => h.id !== activeHost?.id)

  const clear = () => {
    const go = async () => {
      setWipeErr(null)
      try {
        await clearLocalData()
        // ★内存里那份也必须一起忘掉,**不能**只 `selectHost(null)`:那个只置空 activeId,
        //  `hosts`(连令牌)还在 state 里 —— 「其他主机」照样列着每一台、点一下就连上去了,
        //  而下一次 addHost 会把这份「已经清掉」的清单原样写回磁盘。
        forgetAll()
        // 回根屏:这一屏说的每一样东西都不存在了,留在原地看着的是一屏幻觉。
        router.replace('/')
      } catch (e) {
        // ★这是整屏最有后果的一个动作,失败必须说出来。原来是个光秃秃的 `void go()`:
        //  存储抛了就什么都不发生 —— 对话框关掉、界面不动、令牌还在,而人以为清干净了,
        //  然后把手机借出去。宁可留一句刺眼的红字,也不能让它无声失败。
        setWipeErr(`没能清干净:${e instanceof Error ? e.message : String(e)}。令牌可能还留在这台手机上,再试一次。`)
      }
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
                    {/* 连上了报地址和对面版本;没连上就报**为什么**。★和主机屏同一份实现。 */}
                    {hostSubtitle(activeHost.url, state, true)}
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

        {/* ★其他主机**不另起一个 `<Sec>`**:设计文档 §7.2 只有三组,而分组头是这一屏唯一的
            结构信号 —— 多一个头就是屏幕上有四组,人会去数「哪三组才是那三组」。
            这些行接着上面那张卡往下排,靠 LiveDot / 断开 / `›` 自己区分当前和其他。 */}
        {others.length > 0 ? (
          <>
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
                      {hostSubtitle(h.url, null, false)}
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
          {/* 归档的入口。★不放进「管理主机」——归档的是工作区,不是主机,搁一块儿会让人
              以为归档跟主机绑定。放这儿是设计文档 §7.2/§7.6 定的位置:主机组下面。 */}
          <Btn kind="ghost" block onPress={() => router.push('/archived')}>
            已归档的工作区
          </Btn>
        </List>
        <Note>删除主机、手动重连都在「管理主机」那一屏里。切过去之后,会话、变更、终端全部换成那台机器的。</Note>
        <Note>归档是在会话列表长按分组头做的;归档的工作区在「已归档的工作区」里恢复。</Note>

        <Sec>外观 · 跟着这台手机走</Sec>
        <List>
          <Pick label="主题" value={THEMES.find((t) => t.id === pref)?.label ?? ''} onPress={() => setThemeSheet(true)} />
          <Pick label="正文字号" value={TEXTS.find((t) => t.id === text)?.label ?? ''} onPress={() => setTextSheet(true)} />
        </List>
        <Note>切主机不会改这两样 —— 它们属于你手上这台设备,不属于那台电脑。</Note>
        {/* ★设计文档 §5.5.4:语音**不写代码**,系统键盘自带的听写现在就能用。
            但「能用」和「知道能用」是两回事 —— app 里没有麦克风按钮,人只会以为手机端不能说话,
            然后在通勤路上一个字一个字地戳。这一句话就是这条功能的**全部实现**,
            所以它必须真的出现在界面上,不能只留在文档里。
            放在「外观」下面而不是另起一组:设计文档 §7.2 钉死只有三组。 */}
        <Note>
          想说话代替打字?直接用系统键盘上那颗麦克风键听写 —— app 不另做录音,系统自带的更准、也不用多给一个权限。
        </Note>

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
          {/* ★提示就在按钮上面一行(和 add-host 同一个位置)。挪到页顶去的话,
              点完按钮什么都没变、而唯一的说明在视野外 —— 那就是「点了没反应」。 */}
          {wipeErr ? (
            <View
              style={{
                padding: 11,
                borderRadius: 12,
                borderWidth: 1,
                borderColor: c.permFullBorder,
                backgroundColor: c.bg2,
              }}
            >
              <T style={{ fontSize: 13, lineHeight: 20, color: c.err }}>{wipeErr}</T>
            </View>
          ) : null}
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
      {/* ★把字号写出来:裸 `<T>` 会落到 RN 的默认 14,于是「小」和「大」两档下
          全屏只有这个勾一动不动 —— 缩放要么整屏一起,要么就是坏的。 */}
      {on ? <T style={{ fontSize: 15, color: c.accent }}>✓</T> : null}
    </Row>
  )
}

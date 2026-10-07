import { useState } from 'react'
import { Platform, ScrollView, Switch, View } from 'react-native'
import { goBack } from '../src/nav'
import { useC } from '../src/theme/theme'
import { IconBtn, List, Note, Row, Sec, T, TopBar, TopTitle } from '../src/ui/kit'
import { usePush } from '../src/push/PushProvider'

/**
 * 通知。
 *
 * ★★为什么自己一屏,而不是像原来那样平铺在设置里:这一组是**四个开关 + 一颗测试键 +
 *  三段解释**,而它旁边的邻居是「主题」「字号」这种一行一句的东西。摊在同一列里,
 *  它一个人占掉半屏,把设置屏变成了「通知设置屏,附带几个别的」。
 *  ★而且这几段解释是**必须留着**的(远程推送通没通有三种状态,各有各的下一步动作),
 *   删掉等于把「为什么收不到」这个问题变成无解。搬进自己一屏,两边同时成立:
 *   设置屏回到一行一件事,该说的话在它真正属于的地方一句不少。
 *
 * ★手机端存在的意义有一半在这儿:**你不在电脑前,一道门升起来卡在那儿**。
 *  「能答门」早就做完了,「你怎么知道有门」一直是空的。
 *
 * **两条腿,界面上必须分得开** ——
 *  ① app 开着但你在看别的会话 → 手机自己弹一条。零配置,现在就能用。
 *  ② app 被切走 / 被系统挂起 → 由那台电脑直接推过来。它要 Expo 的推送凭据,
 *     而那要你自己的 Expo 账号 —— 拿不到时下面那行小字会**说清楚差哪一步**,
 *     绝不做成一个点了没反应的开关。
 */
export default function Notifications() {
  const c = useC()
  const push = usePush()
  const [permErr, setPermErr] = useState<string | null>(null)

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <TopBar left={<IconBtn onPress={() => goBack()}>‹</IconBtn>}>
        <TopTitle title="通知" />
      </TopBar>

      <ScrollView contentContainerStyle={{ paddingBottom: 44 }}>
        <Sec>提醒我</Sec>
        <List>
          <Toggle
            label="有事就提醒我"
            on={push.prefs.enabled}
            onChange={async (v) => {
              if (v && push.permission !== 'granted') {
                const st = await push.askPermission()
                // ★系统里拒过一次就再也弹不出来了。这时候开关**不能**自己亮起来 ——
                //  那等于向用户保证一件做不到的事。
                if (st !== 'granted') {
                  setPermErr(st === 'denied'
                    ? '系统里关掉了 myFlowForge 的通知。去「设置 → 通知 → myFlowForge」打开,再回来。'
                    : '没拿到通知权限,提醒发不出来。')
                  return
                }
              }
              setPermErr(null)
              push.setPrefs({ ...push.prefs, enabled: v })
            }}
          />
          <Toggle
            label="需要我答的门"
            on={push.prefs.gate}
            disabled={!push.prefs.enabled}
            onChange={(v) => push.setPrefs({ ...push.prefs, gate: v })}
          />
          <Toggle
            label="跑完了"
            on={push.prefs.done}
            disabled={!push.prefs.enabled}
            onChange={(v) => push.setPrefs({ ...push.prefs, done: v })}
          />
          {/* ★没权限时 `presentLocal` 是静默失败的,所以这颗按钮必须把原因接回来显示 ——
              否则它就是一颗「点了没反应」的按钮,而它正是用来判断提醒通没通的那颗。 */}
          <Row onPress={() => void push.testLocal().then(setPermErr)}>
            <T style={{ flex: 1, fontSize: 15, color: c.fg }}>弹一条试试</T>
          </Row>
        </List>
        {permErr ? <Note>{permErr}</Note> : null}

        {/* ★★2026-10-07 这里原来是「手机不在跟前时」一整组说明 + 每个开关底下一行小字,整个去掉了 ——
            用户原话:「我非常讨厌在 app 里加一些小字说明」。权限被拒那一句留着:那是**出错**,不是说明。 */}
      </ScrollView>
    </View>
  )
}

/**
 * 一行开关。
 *
 * ★用系统自带的 `Switch` 而不是自画一个:布尔开关是这块屏幕上人**最熟**的一个控件,
 *  自造的版本在两个平台上都会显得差一点,而且拿不到系统的无障碍支持。
 * ★整行可点(不只是那颗开关)—— 开关本体大约 51×31pt,一屏设置里全是它的话,
 *  手指落点会很挑。行本身是 54pt 高的一整条,点哪儿都行。
 */
function Toggle({
  label, on, onChange, disabled,
}: {
  label: string
  on: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}) {
  const c = useC()
  return (
    <Row onPress={disabled ? undefined : () => onChange(!on)} disabled={disabled}>
      <T style={{ flex: 1, minWidth: 0, paddingRight: 10, fontSize: 15, color: c.fg }}>{label}</T>
      <Switch
        value={on}
        onValueChange={onChange}
        disabled={disabled}
        trackColor={{ true: c.accent, false: c.border2 }}
        // 安卓上不给 thumbColor 的话开着的时候是一颗系统紫色的圆点,跟皮肤完全不搭。
        thumbColor={Platform.OS === 'android' ? (on ? c.bg : c.faint) : undefined}
      />
    </Row>
  )
}

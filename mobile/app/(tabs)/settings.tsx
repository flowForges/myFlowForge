import { useState } from 'react'
import { Alert, Platform, ScrollView, View } from 'react-native'
import { router } from 'expo-router'
import { useC, useTheme } from '../../src/theme/theme'
import { Btn, List, Note, Row, Sec, T, TopBar, TopTitle } from '../../src/ui/kit'
import { Sheet } from '../../src/ui/Sheet'
import { useConn } from '../../src/net/conn'
import { clearLocalData } from '../../src/data/localData'
import { ROUTES } from '../../src/nav/routes'
import type { TextSize, ThemePref } from '../../src/data/prefs'

/**
 * 设置。比电脑端简单一个量级 —— 没有工作流、阶段、插件、宠物、壁纸,那些留在电脑端。
 * 手机是用来盯梢和答门的,不是用来配置的;把电脑端那一整面墙搬过来只会让
 * 「加个主机」这件事变得找不到。
 *
 * **分组按「这条设置属于谁」切**:连接 / 外观 / 提醒 / 关于 / 这台手机。
 *
 * ★这里原来写着「**故意只有三组**(设计文档 §7.2)」,并且据此把「已归档的工作区」
 *  硬塞进了主机那一组。真机上用户当场指出来了:归档的是**工作区**,不是主机 ——
 *  而这一屏的分组头是全屏唯一的结构信号,把一件东西塞进语义不对的组里,
 *  等于用那个唯一的信号说了一句假话。「三组」是个数量约束,而它约束的对象
 *  (别把电脑端那面墙搬过来)靠的是**内容**少,不是靠把不同类的东西挤在一起。
 *  所以约束保留、数字作废:宁可多两个头,也不要一个头底下挂着不属于它的东西。
 *
 * ★★2026-08-28:主机那一整组**搬走了**,成了底部第二格 tab(`app/(tabs)/hosts.tsx`)。
 *  这一屏不许再留任何通往主机的入口 —— 两个入口通向同一屏,迟早只改其中一个。
 *  ★但「这一屏在没连主机时也必须能用」这条**仍然成立**:它还是「清除本地数据」的唯一入口。
 *
 * ★★2026-08-31 用户原话:「设置里文字太多了」。做了两件事 ——
 *  ① **通知那一整组搬进 `app/notifications.tsx`**:它是四个开关 + 三段解释,和邻居
 *     (「主题」「字号」这种一行一句的东西)完全不是一个体量,摊在同一列里它一个人占掉半屏。
 *  ② 剩下的每一行只留**一句**副标题,长解释搬去它真正属于的那一屏。
 *  ★被删掉的必须是**重复**的话,不是唯一的那句:「归档后在这里恢复」留着(它回答「怎么回来」),
 *   「清掉要重新配对」留着(它是那颗红按钮的后果)。删到只剩行名的话,这一屏会变成
 *   一列谁也不知道点下去会发生什么的词。
 */

const THEMES: { id: ThemePref; label: string; desc: string }[] = [
  { id: 'system', label: '跟随系统', desc: '跟着系统的深浅色切' },
  { id: 'light', label: '浅色', desc: '一直浅色' },
  { id: 'dark', label: '深色', desc: '一直深色' },
]

const TEXTS: { id: TextSize; label: string; desc: string }[] = [
  { id: 'sm', label: '小', desc: '一屏装得下更多' },
  { id: 'md', label: '标准', desc: '默认' },
  { id: 'lg', label: '大', desc: '看得清一点' },
]

export default function Settings() {
  const c = useC()
  const { pref, setPref, text, setText } = useTheme()
  const { forgetAll } = useConn()
  const [themeSheet, setThemeSheet] = useState(false)
  const [textSheet, setTextSheet] = useState(false)
  const [wipeErr, setWipeErr] = useState<string | null>(null)

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
        router.replace(ROUTES.home)
      } catch (e) {
        // ★这是整屏最有后果的一个动作,失败必须说出来。原来是个光秃秃的 `void go()`:
        //  存储抛了就什么都不发生 —— 对话框关掉、界面不动、令牌还在,而人以为清干净了,
        //  然后把手机借出去。宁可留一句刺眼的红字,也不能让它无声失败。
        setWipeErr(`没能清干净:${e instanceof Error ? e.message : String(e)}。令牌可能还留在这台手机上,再试一次。`)
      }
    }
    const msg = '主机清单和令牌都存在这台手机上。清掉之后要重新扫码配对。'
    if (Platform.OS === 'web') {
      // RN-web 的 Alert 什么都不画(0/1/2 个按钮一律不渲染),确认框走 window.confirm 才是真能选的。
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
      {/* ★2026-08-29:没有 `‹` 了 —— 这一屏现在是底部 tab 的一格,不是被推进来的次级屏。
          tab 没有「上一层」,留着箭头会变成一颗「点了会跳到别的 tab」的假返回键。 */}
      <TopBar>
        <TopTitle title="设置" sub="跟着这台手机走" />
      </TopBar>

      <ScrollView contentContainerStyle={{ paddingBottom: 44 }}>
        {/* ★★归档的入口**自己一组**。它原来贴在「添加主机 / 管理主机」下面,和它们排成一列 ——
            读起来就是「主机的第三件事」,而归档的是**工作区**。这一屏的分组头是全屏唯一的
            结构信号,拿它把一件东西归到不对的类里,比不分组更糟:人会照着那个头去推断,
            于是「归档跟主机绑定吗?换台主机归档的还在吗?」这种问题凭空冒出来。
            答案是不:归档是工作区自己的属性,存在那台电脑上、跟着工作区走。 */}
        {/* ★★2026-09-02:「已归档的工作区」**搬走了** —— 它属于「工作区」那一格(底部第二格),
            归档的是工作区,不是设置。而这里换成了「主机」:它原来是底部第二格,但那一屏全是
            配对时用一次的事,占一格太浪费(用户原话)。
            ★这推翻了 2026-08-28「设置里不许再有通往主机的入口」那条 —— 当时搬出去是因为
             设置屏很长、埋太深;现在这一屏只剩四行,埋不住。★而且它仍然是**唯一**的入口
             (「工作区」那一格里没有主机,首页顶栏那条横幅是快切不是管理)。 */}
        <Sec>连接</Sec>
        <List>
          <Nav label="主机" sub="配对、切换、删除" onPress={() => router.push(ROUTES.hosts)} />
        </List>

        <Sec>外观</Sec>
        <List>
          <Pick label="主题" value={THEMES.find((t) => t.id === pref)?.label ?? ''} onPress={() => setThemeSheet(true)} />
          <Pick label="正文字号" value={TEXTS.find((t) => t.id === text)?.label ?? ''} onPress={() => setTextSheet(true)} />
        </List>
        {/* ★★设计文档 §5.5.4:语音**不写代码**,系统键盘自带的听写现在就能用。
            但「能用」和「知道能用」是两回事 —— app 里没有麦克风按钮,人只会以为手机端不能说话,
            然后在通勤路上一个字一个字地戳。**这一句话就是这条功能的全部实现**,所以它减不掉,
            只能减短。 */}
        <Note>想说话就说 —— 系统键盘上那颗 🎤 在任何输入框里都能用。</Note>

        {/* ★★2026-08-31:这里原来是**四个开关 + 一颗测试键 + 两段说明**,整组已经搬进
            `app/notifications.tsx`。留在这儿的是一行入口。
            ★副标题说的是「进去能开什么」,不是「通知是什么」—— 一行入口要回答的是
             「我要找的东西在不在里面」。 */}
        {/* ★分组头用「提醒」而不是「通知」:头和行名一模一样的话,那个头什么也没说 ——
            而分组头是这一屏唯一的结构信号。行名保持「通知」,因为它要和目的地那一屏的标题对得上。 */}
        <Sec>提醒</Sec>
        <List>
          <Nav label="通知" sub="门升起来、跑完了" onPress={() => router.push(ROUTES.notifications)} />
        </List>

        {/* ★★「关于」是**一行,点进去是一屏**(`app/about.tsx`)。它原来是这儿的一组内联行:
            手机端版本 / 主机版本 / 方法数,三行死数据夹在「外观」和「这台手机」这两组
            **能改的东西**中间。分组头是这一屏唯一的结构信号,这么摆等于说「这三样也是设置」,
            可它们一个都点不动。
            ★这一行**不在这儿顺手报版本号**:报了就等于那一屏白开(人看一眼就走),
            而真正要一起看的是三个数 —— 两端版本对不上 → 连都连不上;版本对得上但方法少 →
            某个功能整个置灰。这条因果只有三个数摆在一起才串得起来。 */}
        <Sec>关于</Sec>
        <List>
          <Nav label="关于" sub="版本和方法数,连不上时先看这里" onPress={() => router.push(ROUTES.about)} />
        </List>

        <Sec>这台手机</Sec>
        {/* ★这句留着:它是那颗红按钮的**后果**,不是背景介绍。 */}
        <Note>主机清单和令牌都存在这台手机上,清掉要重新扫码配对。</Note>

        {/* ★设计文档 §7.2:danger 不与主动作相邻。这一段空白就是为了让手指够不着 ——
            上面最近的一个可点的东西是「关于」那一行,中间还隔着一个分组头和一句说明。 */}
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
        sub="存在这台手机上"
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
        sub="整个 app 一起变"
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

/**
 * 一行「名字 / 一句副标题 ›」,点进去是另一屏。
 *
 * ★这一屏现在有三行长这样(已归档 / 通知 / 关于),原来是各写一遍 12 行 JSX —— 抄第三遍的时候
 *  就该收起来了。收一处还有个附带好处:三行的字号、间距、那颗 › 的颜色永远一致。
 */
function Nav({ label, sub, onPress }: { label: string; sub: string; onPress: () => void }) {
  const c = useC()
  return (
    <Row onPress={onPress}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <T style={{ fontSize: 15, color: c.fg }}>{label}</T>
        <T style={{ fontSize: 12, color: c.muted, marginTop: 3 }}>{sub}</T>
      </View>
      <T style={{ fontSize: 16, color: c.faint }}>›</T>
    </Row>
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

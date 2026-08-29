import { useState } from 'react'
import { Alert, Platform, ScrollView, Switch, View } from 'react-native'
import { router } from 'expo-router'
import { useC, useTheme } from '../../src/theme/theme'
import { Btn, List, Note, Row, Sec, T, TopBar, TopTitle } from '../../src/ui/kit'
import { Sheet } from '../../src/ui/Sheet'
import { useConn } from '../../src/net/conn'
import { clearLocalData } from '../../src/data/localData'
import { usePush } from '../../src/push/PushProvider'
import type { TextSize, ThemePref } from '../../src/data/prefs'

/**
 * 设置。比电脑端简单一个量级 —— 没有工作流、阶段、插件、宠物、壁纸,那些留在电脑端。
 * 手机是用来盯梢和答门的,不是用来配置的;把电脑端那一整面墙搬过来只会让
 * 「加个主机」这件事变得找不到。
 *
 * **分组按「这条设置属于谁」切**:工作区 / 外观(跟着这台手机走)/ 关于 / 这台手机。
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
  const { forgetAll } = useConn()
  const push = usePush()
  const [themeSheet, setThemeSheet] = useState(false)
  const [textSheet, setTextSheet] = useState(false)
  const [wipeErr, setWipeErr] = useState<string | null>(null)
  const [permErr, setPermErr] = useState<string | null>(null)

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
        <TopTitle title="设置" sub="外观和通知跟着这台手机" />
      </TopBar>

      <ScrollView contentContainerStyle={{ paddingBottom: 44 }}>
        {/* ★★归档的入口**自己一组**。它原来贴在「添加主机 / 管理主机」下面,和它们排成一列 ——
            读起来就是「主机的第三件事」,而归档的是**工作区**。这一屏的分组头是全屏唯一的
            结构信号,拿它把一件东西归到不对的类里,比不分组更糟:人会照着那个头去推断,
            于是「归档跟主机绑定吗?换台主机归档的还在吗?」这种问题凭空冒出来。
            答案是不:归档是工作区自己的属性,存在那台电脑上、跟着工作区走。 */}
        <Sec>工作区</Sec>
        <List>
          <Row onPress={() => router.push('/archived')}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <T style={{ fontSize: 15, color: c.fg }}>已归档的工作区</T>
              {/* 归档后从会话列表消失,所以这条路必须**看得见** —— 否则归档等于弄丢
                  (设计文档 §7.6)。这行小字就是「怎么回来」那句话。 */}
              <T style={{ fontSize: 12, color: c.muted, marginTop: 3 }}>
                归档后从会话列表消失,在这里恢复
              </T>
            </View>
            <T style={{ fontSize: 16, color: c.faint }}>›</T>
          </Row>
        </List>

        <Sec>外观 · 跟着这台手机走</Sec>
        <List>
          <Pick label="主题" value={THEMES.find((t) => t.id === pref)?.label ?? ''} onPress={() => setThemeSheet(true)} />
          <Pick label="正文字号" value={TEXTS.find((t) => t.id === text)?.label ?? ''} onPress={() => setTextSheet(true)} />
        </List>
        {/* ★★设计文档 §5.5.4:语音**不写代码**,系统键盘自带的听写现在就能用。
            但「能用」和「知道能用」是两回事 —— app 里没有麦克风按钮,人只会以为手机端不能说话,
            然后在通勤路上一个字一个字地戳。**这一句话就是这条功能的全部实现。**
            ★这条注释原来就在这里,后面却什么也没有渲染 —— 它写着「必须真的出现在界面上,
             不能只留在文档里」,而那句话恰恰就只留在了这条注释里。现在补上了。
            ★为什么归在「外观 · 跟着这台手机走」下面:听写是**你手上这台设备**自带的本事,
             和主题、字号一样不跟着主机走。(原来的理由写的是「§7.2 钉死只有三组」,
             那条数量约束已经作废,见文件顶上的注释。) */}
        <Note>想说话就说 —— 系统键盘上那颗 🎤 在任何输入框里都能用,不用切到别的 app。</Note>

        {/* ★★手机端存在的意义有一半在这一组:你不在电脑前,一道门升起来卡在那儿。
            **两条腿,界面上必须分得开** ——
            ① app 开着但你在看别的会话 → 手机自己弹一条。零配置,现在就能用。
            ② app 被切走 / 被系统挂起 → 由那台电脑直接推过来。它要 Expo 的推送凭据,
               而那要你自己的 Expo 账号 —— 拿不到时下面那行小字会**说清楚差哪一步**,
               绝不做成一个点了没反应的开关。 */}
        <Sec>提醒</Sec>
        <List>
          <Toggle
            label="有事就提醒我"
            desc="门升起来、或者一轮跑完时"
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
            desc="权限门、代理提问、工作流卡住"
            on={push.prefs.gate}
            disabled={!push.prefs.enabled}
            onChange={(v) => push.setPrefs({ ...push.prefs, gate: v })}
          />
          <Toggle
            label="跑完了"
            desc="默认关 —— 半夜被一条「跑完了」吵醒一次,这个功能就会被整个关掉"
            on={push.prefs.done}
            disabled={!push.prefs.enabled}
            onChange={(v) => push.setPrefs({ ...push.prefs, done: v })}
          />
          <Row onPress={() => void push.testLocal()}>
            <T style={{ flex: 1, fontSize: 15, color: c.fg }}>弹一条试试</T>
            <T style={{ fontSize: 13.5, color: c.muted }}>本地通知</T>
          </Row>
        </List>
        {permErr ? <Note>{permErr}</Note> : null}
        {/* ★这一句是「远程推送到底通没通」的唯一诚实出口。三种状态各有各的下一步动作,
            合并成一句「未开启」等于什么都没说。 */}
        <Note>
          {!push.prefs.enabled
            ? '关着的时候,手机上什么都不会弹。'
            : !push.hostSupports
              ? '这台主机的版本还没有推送功能 —— 把电脑上的 myFlowForge 更新一下。app 开着的时候仍然会弹。'
              : push.token
                ? '手机放下、app 切走之后,那台电脑会把门推过来。'
                : `app 开着时会弹;切走之后收不到 —— ${push.tokenReason || '还没拿到推送令牌'}`}
        </Note>

        {/* ★★「关于」是**一行,点进去是一屏**(`app/about.tsx`)—— 和「主机」tab 里每一行末尾
            那颗 › 详情键推 `/host` 是同一个目的地,但不是同一条路数:那边整行点下去是「切到这台」,
            推 `/host` 的是行尾**单独**那一颗附件键(见 I1 的修复),不是行本身。这一行没有那个冲突
            (没有「切到 About」这种别的动作要让位),所以整行照旧可点。
            它原来是这儿的一组内联行:手机端版本 / 主机版本 / 方法数,三行死数据
            夹在「外观」和「这台手机」这两组**能改的东西**中间。分组头是这一屏唯一的结构信号,
            这么摆等于说「这三样也是设置」,可它们一个都点不动。
            ★这一行**不在这儿顺手报版本号**:报了就等于那一屏白开(人看一眼就走),
            而真正要一起看的是三个数 —— 两端版本对不上 → 连都连不上;版本对得上但方法少 →
            某个功能整个置灰。这条因果只有三个数摆在一起才串得起来,所以副行说的是「进去看什么」。 */}
        <Sec>关于</Sec>
        <List>
          <Row onPress={() => router.push('/about')}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <T style={{ fontSize: 15, color: c.fg }}>关于</T>
              <T style={{ fontSize: 12, color: c.muted, marginTop: 3 }}>
                两端版本和方法数 —— 连不上的时候先看这三个数
              </T>
            </View>
            <T style={{ fontSize: 16, color: c.faint }}>›</T>
          </Row>
        </List>

        {/* 「版本号」那一行已经挪进上面的「关于」了 —— 这一组现在只剩一件事:
            **这台手机上存着什么、怎么擦掉**。 */}
        <Sec>这台手机</Sec>
        <Note>主机清单和令牌都存在这台手机上。清掉之后要重新扫码配对。</Note>

        {/* ★设计文档 §7.2:danger 不与主动作相邻。这一段空白就是为了让手指够不着 ——
            上面最近的一个可点的东西是「关于」那一行,中间还隔着一个分组头和一整段说明。 */}
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
/**
 * 一行开关。
 *
 * ★用系统自带的 `Switch` 而不是自画一个:布尔开关是这块屏幕上人**最熟**的一个控件,
 *  自造的版本在两个平台上都会显得差一点,而且拿不到系统的无障碍支持。
 * ★整行可点(不只是那颗开关)—— 开关本体大约 51×31pt,一屏设置里全是它的话,
 *  手指落点会很挑。行本身是 54pt 高的一整条,点哪儿都行。
 */
function Toggle({
  label, desc, on, onChange, disabled,
}: {
  label: string
  desc?: string
  on: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}) {
  const c = useC()
  return (
    <Row onPress={disabled ? undefined : () => onChange(!on)} disabled={disabled}>
      <View style={{ flex: 1, minWidth: 0, paddingRight: 10 }}>
        <T style={{ fontSize: 15, color: c.fg }}>{label}</T>
        {desc ? <T style={{ fontSize: 12, color: c.muted, marginTop: 3 }}>{desc}</T> : null}
      </View>
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

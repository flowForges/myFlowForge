import React from 'react'
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { MONO, useC, useTheme } from '../theme/theme'
import { RADIUS } from '../theme/tokens'
import type { Palette } from '../theme/tokens'

/**
 * 通用件。每一个都对着原型设计层 `screens/d.css` 里的同名 class 抄:
 * `.top` / `.ico` / `.sec` / `.row` / `.pill` / `.btn` / `.chip` / `.field` / `.note` / `.banner` / `.empty`。
 *
 * ★不要在这一层之外自己拼颜色和圆角。上一轮桌面端的教训就是「自己发明样式」——
 * 用 color-mix 造了个看起来合理的色,结果每套主题下都比邻居深一截,改三轮没对。
 */

export function T({
  style,
  mono,
  ...rest
}: React.ComponentProps<typeof Text> & { mono?: boolean }) {
  const { scale } = useTheme()
  // ★字号是**每一处都写死数字**的(照原型 d.css 抄的),没有一个统一的 base 可以调。
  //  所以「正文字号」那三档的倍率在这里落地:把已经算好的 style 拍平,乘 fontSize 和 lineHeight。
  //  lineHeight 必须一起乘 —— 只放大字号不放大行距,大号那一档会挤成一坨。
  //  scale === 1(标准档,默认)时**原样返回**,不做任何 flatten:这是绝大多数人的路径,
  //  而 `T` 是每一段文字都要过的地方,不该为了一个没人开的功能给每一段都加一次 flatten。
  const flat = scale === 1 ? null : StyleSheet.flatten(style)
  const scaled = flat
    ? {
        ...flat,
        ...(typeof flat.fontSize === 'number' ? { fontSize: flat.fontSize * scale } : null),
        ...(typeof flat.lineHeight === 'number' ? { lineHeight: flat.lineHeight * scale } : null),
      }
    : style
  return <Text {...rest} style={[mono && { fontFamily: MONO }, scaled]} />
}

export function Sec({
  children, note, right, onPress, onLongPress, expanded,
}: {
  children: React.ReactNode
  /**
   * 跟在标题后面的一小段**辨认用补充**(会话列表分组头上的当前分支名就是走这里)。
   *
   * ★为什么单开一个 prop 而不是拼进 `children`:标题那个 `<T>` 带 `textTransform: 'uppercase'`,
   *  拼进去的分支名会被大写成 `FEAT/RMH-DAEMON` —— git 的 ref **区分大小写**,那是个根本不存在的
   *  分支名,分组头等于在报一个假的。区名被大写没问题(它只是个显示名),分支名不行。
   *  所以这一段单独一个不大写的 `<T>`,并且刻意比标题轻:它是补充,不是第二个标题。
   */
  note?: string
  right?: React.ReactNode
  onPress?: () => void
  /** 长按呼出操作单(置顶 / 归档)。手机上没有右键。 */
  onLongPress?: () => void
  /** 给了就画一个展开箭头(▾ 展开 / ▸ 收起)。不给就是老样子,一个纯标题。 */
  expanded?: boolean
}) {
  const c = useC()
  const body = (
    <View style={s.sec}>
      {expanded !== undefined ? (
        <T style={{ fontSize: 10, color: c.faint, marginRight: 1 }}>{expanded ? '▾' : '▸'}</T>
      ) : null}
      {/* ★★`flexShrink: 1` + `minWidth: 0` + `numberOfLines` 不是排版洁癖:RN 的 flexShrink
          默认是 **0**,而这一行现在挤着三样东西(标题 + 分支名 `note` + 右边的 `right`)。
          右边那个 slot 在会话列表上就是**门徽章** —— 全屏最重要的那一个。
          标题不肯让的话,一个长工作区名(再叠上「大」字号那一档)会把徽章整个顶出屏幕边缘,
          现象是「有门却看不见」。让标题先扁,徽章绝不让。

          实测(无头 Chrome、390 宽、区名 `myFlowForgeRemoteMultihostMobileWorkspaceAlpha`):
            改之前 —— 徽章右沿 **437.5**,视口只有 390:那颗「❓ 等你答话」整个在屏幕外。
            改之后 —— 标题省略号截断,徽章 304.3–**376**,完整可见。
          ★`minWidth: 0` 是**必需**的、不是陪衬:flex 子项的 `min-width` 默认 `auto`,
           光有 `flexShrink: 1` 也缩不到内容宽度以下(上面那次「改之前」量到的 flex-shrink
           其实就已经是 1 了,拦住它的正是 `min-width: auto`)。
          ★带连字符的名字在 web 上会**换行**而不是溢出,量不出这个 bug —— 复现要用一个
           没有断词机会的长名字。 */}
      <T
        mono
        numberOfLines={1}
        style={{
          fontSize: 10.5, letterSpacing: 0.85, color: c.faint, textTransform: 'uppercase',
          flexShrink: 1, minWidth: 0,
        }}
      >
        {children}
      </T>
      {note ? (
        // 原样显示(不大写),并且可以被挤扁 —— 分支名再长也不许把右边的徽章顶出屏幕。
        <T mono numberOfLines={1} style={{ fontSize: 10.5, color: c.faint, flexShrink: 1, minWidth: 0 }}>
          {note}
        </T>
      ) : null}
      {right != null && <View style={{ marginLeft: 'auto' }}>{right}</View>}
    </View>
  )
  if (!onPress && !onLongPress) return body
  // ★整条都是热区。分组头本来就是一行字,只让那几个字可点的话,手指多半点在旁边的空白上,
  //  现象是「点了没反应」—— 本轮已经在别处栽过一次同样的事。
  return (
    <Pressable onPress={onPress} onLongPress={onLongPress} delayLongPress={400}>
      {({ pressed }) => <View style={pressed ? { opacity: 0.6 } : undefined}>{body}</View>}
    </Pressable>
  )
}

/**
 * 轮次时间分隔线 —— 原型 `d.css` 的 `.tsep`:两条 1px 细线中间一个时刻。
 *
 * ★**只在轮次之间**来一根(哪一条该有,由 `timeSep.ts` 的 `sepsFor` 决定)。方向 C 曾经给每条消息
 *  配一条时间轴,390px 上每条多吃 46px,一屏只剩两条消息 —— 定 D 版时就是因为这个把它退成了分隔线。
 */
export function TimeSep({ children }: { children: React.ReactNode }) {
  const c = useC()
  return (
    <View style={s.tsep}>
      <View style={[s.tsepLine, { backgroundColor: c.border }]} />
      <T mono style={{ fontSize: 10.5, letterSpacing: 0.63, color: c.faint }}>
        {children}
      </T>
      <View style={[s.tsepLine, { backgroundColor: c.border }]} />
    </View>
  )
}

/**
 * 执行面板顶部那排 tab —— 原型 `d.css` 的 `.tabs`(等分、9px 圆角、选中态是 `--surface-2` 的底)。
 * 桌面端那一排是 阶段 / 变更 / 文件 / 终端;手机端只做得起其中两个,所以这个件按传进来的项数等分。
 */
export function Tabs<K extends string>({
  items,
  value,
  onChange,
}: {
  items: { key: K; label: string }[]
  value: K
  onChange: (k: K) => void
}) {
  const c = useC()
  return (
    <View style={[s.tabs, { borderBottomColor: c.border }]}>
      {items.map((it) => {
        const on = it.key === value
        return (
          <Pressable
            key={it.key}
            onPress={() => onChange(it.key)}
            style={({ pressed }) => [
              s.tab,
              on && { backgroundColor: c.surface2 },
              pressed && !on && { backgroundColor: c.surface },
            ]}
          >
            <T style={{ fontSize: 13, fontWeight: '600', color: on ? c.fg : c.muted }}>{it.label}</T>
          </Pressable>
        )
      })}
    </View>
  )
}

export function Note({ children }: { children: React.ReactNode }) {
  const c = useC()
  return <T style={{ fontSize: 11.5, lineHeight: 19, color: c.faint, paddingHorizontal: 15, paddingTop: 10 }}>{children}</T>
}

/**
 * 一列卡片。只有左右内边距和行间距。
 *
 * ★★**改这一层的盒模型之前,先去读 `mobile/app/index.tsx` 里 `absY()` 的注释。**
 *  根屏的定位气泡靠三段 onLayout 相加(工作区分组 View + 包住这个 List 的裸 View + 每一行的
 *  wrapper)拼出「某一行在滚动内容里的绝对 y」。中间那一段量的是**包着 List 的裸 View**,
 *  第三段量的是**行相对本 View 的偏移** —— 也就是说这个加法默认「本 View 的上沿 = 那层裸 View
 *  的上沿」。所以:
 *  - **纵向 margin / transform 一加就错位**:它把本 View 整体挪开,而挪开的这一段谁都没量。
 *  - 纵向 padding、border 目前是安全的(RN 给子节点的 y 相对父节点的 **border box**,这两样
 *    会被每一行自己的 y 一并算进去),但它们把「这一层到底怎么摆」变得更绕,而这条链条错了
 *    **不会有任何测试报错** —— node/jsdom 环境测不了真实布局,症状只是气泡悄悄滚到错的一行。
 *  一句话:这个共享件的纵向几何是有远程消费者的,别当它只是个列表容器。
 */
export function List({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[s.list, style]}>{children}</View>
}

/** 一行可点的条目。`gate` = 这条挂着门:同色低饱和底 + 中饱和边框,不用实心色块喊话。 */
export function Row({
  children,
  onPress,
  gate,
  tree,
  disabled,
  style,
}: {
  children: React.ReactNode
  onPress?: () => void
  gate?: boolean
  /**
   * 文件树那一种行 —— 原型 `d.css` 的 `.tree .frow`:**更矮、没有边框、底是透明的**。
   * 普通 `.frow` 是一张卡(54px 高 + 边框),一屏放不下几个文件;树是要一眼扫一列名字的。
   */
  tree?: boolean
  disabled?: boolean
  style?: StyleProp<ViewStyle>
}) {
  const c = useC()
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || !onPress}
      style={({ pressed }) => [
        s.row,
        tree
          ? s.rowTree
          : { borderColor: gate ? c.gateBorder : c.border, backgroundColor: gate ? c.gateRowBg : c.surface },
        pressed && (tree ? { backgroundColor: c.surface } : { backgroundColor: c.surface2, borderColor: c.border2 }),
        disabled && { opacity: 0.42 },
        style,
      ]}
    >
      {children}
    </Pressable>
  )
}

export type PillTone = 'gate' | 'run' | 'err' | 'idle' | 'acc'

export function Pill({ tone, children }: { tone: PillTone; children: React.ReactNode }) {
  const c = useC()
  const map: Record<PillTone, { fg: string; border: string }> = {
    gate: { fg: c.gate, border: c.pillGateBorder },
    run: { fg: c.ok, border: c.pillRunBorder },
    err: { fg: c.err, border: c.pillErrBorder },
    idle: { fg: c.muted, border: c.border2 },
    acc: { fg: c.accent, border: c.pillAccBorder },
  }
  const t = map[tone]
  return (
    <View style={[s.pill, { borderColor: t.border }]}>
      <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: t.fg }} />
      <T style={{ fontSize: 11, fontWeight: '600', color: t.fg }}>{children}</T>
    </View>
  )
}

export function Btn({
  children,
  onPress,
  kind = 'default',
  size = 'md',
  block,
  disabled,
  style,
}: {
  children: React.ReactNode
  onPress?: () => void
  kind?: 'default' | 'pri' | 'ghost' | 'danger'
  size?: 'md' | 'sm'
  block?: boolean
  disabled?: boolean
  style?: StyleProp<ViewStyle>
}) {
  const c = useC()
  const base: ViewStyle =
    kind === 'pri'
      ? { backgroundColor: c.accent, borderColor: c.accent }
      : kind === 'ghost'
        ? { backgroundColor: 'transparent', borderColor: c.border2 }
        : kind === 'danger'
          ? { backgroundColor: 'transparent', borderColor: c.permFullBorder }
          : { backgroundColor: c.surface2, borderColor: c.border2 }
  const fg = kind === 'pri' ? c.onAccent : kind === 'danger' ? c.err : c.fg
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || !onPress}
      style={({ pressed }) => [
        s.btn,
        size === 'sm' && s.btnSm,
        base,
        block && { width: '100%' },
        pressed && { opacity: 0.82 },
        disabled && { opacity: 0.42 },
        style,
      ]}
    >
      <T style={{ fontSize: size === 'sm' ? 13.5 : 15, fontWeight: '600', color: fg }}>{children}</T>
    </Pressable>
  )
}

export function Chip({
  children,
  onPress,
  tone = 'plain',
  disabled,
}: {
  children: React.ReactNode
  onPress?: () => void
  tone?: 'plain' | 'on' | 'auto' | 'readonly' | 'full'
  disabled?: boolean
}) {
  const c = useC()
  const map = {
    plain: { fg: c.muted, border: c.border2 },
    on: { fg: c.fg, border: c.fg2 },
    auto: { fg: c.accent, border: c.permAutoBorder },
    readonly: { fg: c.ok, border: c.permReadonlyBorder },
    full: { fg: c.err, border: c.permFullBorder },
  } as const
  const t = map[tone]
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || !onPress}
      style={({ pressed }) => [
        s.chip,
        { borderColor: t.border, backgroundColor: c.bg2 },
        pressed && { backgroundColor: c.surface2 },
        disabled && { opacity: 0.42 },
      ]}
    >
      <T numberOfLines={1} style={{ fontSize: 12.5, fontWeight: '500', color: t.fg }}>
        {children}
      </T>
    </Pressable>
  )
}

export function Field(props: React.ComponentProps<typeof TextInput> & { invalid?: boolean }) {
  const c = useC()
  const { scale } = useTheme()
  const { style, invalid, ...rest } = props
  // ★`TextInput` 不是 `Text`,走不到 `T` 那一层,而它的字号写死在 `s.field` 里(15)。
  //  不在这儿补一刀的话,「大」档下**你正在打的那行字**是全 app 唯一没变大的文字 ——
  //  一个只放大别人不放大你自己输入的字号设置,看着就像是坏的。
  //
  //  ★算的是**最终生效的那个** fontSize:先把 `s.field` 和调用方传进来的 style 一起拍平
  //  (`exec.tsx` 的文件过滤框自己写了 `fontSize: 14`,`chat.tsx` 的输入框写了
  //  `minHeight: 44 / maxHeight: 108`),再把拍平后的值乘上去,并且**放在数组最后**覆盖回去。
  //  这样调用方的 14 仍然赢过默认的 15,只是跟着一起缩放;高度那些约束一个字没动。
  // 显式标成 TextStyle:不标的话 flatten 推成「s.field 的字面量类型 | TextStyle」的联合,
  // 而字面量那一半没有 lineHeight 字段,读它 TS 直接报错。
  const flat: TextStyle | null = scale === 1 ? null : StyleSheet.flatten([s.field, style])
  const scaled = flat
    ? {
        ...(typeof flat.fontSize === 'number' ? { fontSize: flat.fontSize * scale } : null),
        ...(typeof flat.lineHeight === 'number' ? { lineHeight: flat.lineHeight * scale } : null),
      }
    : null
  return (
    <TextInput
      placeholderTextColor={c.faint}
      {...rest}
      style={[
        s.field,
        { backgroundColor: c.bg2, borderColor: invalid ? c.err : c.border2, color: c.fg },
        style,
        scaled,
      ]}
    />
  )
}

/** 连接状态小圆点。`wait` 会呼吸,`off` 是红的 —— 断线必须是**显式**的。 */
export function LiveDot({ tone }: { tone: 'ok' | 'wait' | 'off' }) {
  const c = useC()
  const bg = tone === 'ok' ? c.ok : tone === 'wait' ? c.warn : c.err
  return <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: bg }} />
}

export function Banner({
  tone,
  children,
  action,
}: {
  tone: 'off' | 'wait'
  children: React.ReactNode
  action?: React.ReactNode
}) {
  const c = useC()
  return (
    <View
      style={[
        s.banner,
        { borderBottomColor: c.border, backgroundColor: tone === 'off' ? c.bannerOffBg : c.bg2 },
      ]}
    >
      <T style={{ flex: 1, fontSize: 12.5, color: tone === 'off' ? c.err : c.muted }}>{children}</T>
      {tone === 'wait' && <ActivityIndicator size="small" color={c.accent} />}
      {action}
    </View>
  )
}

export function Empty({ title, desc }: { title: string; desc?: string }) {
  const c = useC()
  return (
    <View style={{ paddingVertical: 46, paddingHorizontal: 30 }}>
      <T style={{ fontSize: 15.5, fontWeight: '600', color: c.fg2, textAlign: 'center', marginBottom: 7 }}>{title}</T>
      {desc ? (
        <T style={{ fontSize: 13, lineHeight: 21, color: c.muted, textAlign: 'center' }}>{desc}</T>
      ) : null}
    </View>
  )
}

/** 顶栏。安全区在这里吃掉,别让每个屏各自算一遍。 */
export function TopBar({
  left,
  right,
  children,
  tint,
}: {
  left?: React.ReactNode
  right?: React.ReactNode
  children: React.ReactNode
  tint?: string
}) {
  const c = useC()
  const insets = useSafeAreaInsets()
  return (
    <View
      style={[
        s.top,
        { borderBottomColor: c.border, backgroundColor: tint ?? c.bg, paddingTop: Math.max(9, insets.top) },
      ]}
    >
      {left}
      <View style={{ flex: 1, minWidth: 0 }}>{children}</View>
      {right}
    </View>
  )
}

export function TopTitle({ title, sub, tint }: { title: string; sub?: React.ReactNode; tint?: string }) {
  const c = useC()
  return (
    <View style={{ paddingHorizontal: 2 }}>
      <T numberOfLines={1} style={{ fontSize: 15.5, fontWeight: '600', letterSpacing: -0.3, color: tint ?? c.fg }}>
        {title}
      </T>
      {sub != null && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 1 }}>
          {typeof sub === 'string' ? (
            <T numberOfLines={1} style={{ fontSize: 11.5, color: c.muted }}>
              {sub}
            </T>
          ) : (
            sub
          )}
        </View>
      )}
    </View>
  )
}

/** 顶栏里的方形图标按钮(40×40,圆角 11)。RN 里没有 SVG 依赖,图形一律用字形/几何拼。 */
export function IconBtn({
  onPress,
  children,
  tone,
  disabled,
  badge,
  badgeGate,
  label,
  hitSlop,
}: {
  onPress?: () => void
  children: React.ReactNode
  tone?: string
  disabled?: boolean
  badge?: string
  badgeGate?: boolean
  label?: string
  /**
   * 往四周多撑出去这么多点的可点区域(不影响布局占位)。
   *
   * ★为什么值得有这个 prop:按钮本体是 40×40,离 44 的最小触达还差一点,而在挤得下不下
   *  两颗键的地方(`app/chat.tsx` 输入行里那颗 ⤢)又没有多余的宽度可给。
   *  没有这个 prop 的时候调用方只能在外面**再套一个** `<Pressable hitSlop>`,
   *  于是同一颗按钮有两个 onPress、两份 disabled —— 漏改一处就是「灰着却点得动」。
   */
  hitSlop?: number
}) {
  const c = useC()
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || !onPress}
      hitSlop={hitSlop}
      style={({ pressed }) => [s.ico, pressed && { backgroundColor: c.surface }, disabled && { opacity: 0.35 }]}
    >
      {label ? (
        <View style={{ alignItems: 'center', gap: 1 }}>
          <T style={{ fontSize: 15, lineHeight: 17, color: tone ?? c.fg2 }}>{children}</T>
          {/* ★图标一律配文字。原来顶栏是 🖥 ≣ ■ 三个裸字符,谁也猜不出来是什么。 */}
          <T style={{ fontSize: 8.5, color: c.muted }}>{label}</T>
        </View>
      ) : (
        <T style={{ fontSize: 17, color: tone ?? c.fg2, lineHeight: 22 }}>{children}</T>
      )}
      {badge ? (
        <View
          style={[
            s.bdg,
            { backgroundColor: badgeGate ? c.gate : c.accent, borderColor: c.bg },
          ]}
        >
          <T mono style={{ fontSize: 9.5, fontWeight: '700', color: badgeGate ? c.onGate : c.onAccent }}>
            {badge}
          </T>
        </View>
      ) : null}
    </Pressable>
  )
}

export function makeStyles(c: Palette) {
  return c
}

const s = StyleSheet.create({
  // .tabs { display:flex; gap:4px; padding:7px 12px 8px; border-bottom:1px }
  tabs: { flexDirection: 'row', gap: 4, paddingHorizontal: 12, paddingTop: 7, paddingBottom: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  // .tabs button { flex:1; min-height:34px; border-radius:9px }
  tab: { flex: 1, minHeight: 34, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  // .tsep { display:flex; gap:10px; margin:6px 0 14px }  ·  ::before/::after 是两条 1px 的线
  tsep: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 6, marginBottom: 14 },
  tsepLine: { flex: 1, height: 1 },
  top: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    paddingBottom: 9,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  ico: {
    width: 40,
    height: 40,
    flexShrink: 0,
    borderRadius: RADIUS.ctl,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bdg: {
    position: 'absolute',
    top: 3,
    right: 2,
    minWidth: 16,
    height: 16,
    paddingHorizontal: 4,
    borderRadius: 999,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sec: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingTop: 16,
    paddingBottom: 8,
  },
  // ★纵向几何被 `app/index.tsx` 的 absY() 消费,见 List 组件上的注释:别加纵向 margin。
  list: { paddingHorizontal: 12, gap: 8 },
  // .tree .frow { min-height: 40px; padding: 8px 10px; border: 0; background: transparent; border-radius: 8px }
  rowTree: { minHeight: 40, paddingVertical: 8, paddingHorizontal: 10, borderRadius: 8, borderWidth: 0, backgroundColor: 'transparent' },
  row: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    minHeight: 54,
    paddingVertical: 11,
    paddingHorizontal: 13,
    borderRadius: RADIUS.card,
    borderWidth: StyleSheet.hairlineWidth,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    alignSelf: 'flex-start',
  },
  btn: {
    minHeight: 46,
    paddingHorizontal: 16,
    borderRadius: RADIUS.btn,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  btnSm: { minHeight: 36, borderRadius: 10, paddingHorizontal: 12 },
  chip: {
    minHeight: 32,
    paddingHorizontal: 11,
    borderRadius: RADIUS.chip,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 6,
    flexShrink: 1,
  },
  field: {
    width: '100%',
    paddingHorizontal: 13,
    paddingVertical: 11,
    borderRadius: RADIUS.field,
    borderWidth: StyleSheet.hairlineWidth,
    fontSize: 15,
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 13,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
})

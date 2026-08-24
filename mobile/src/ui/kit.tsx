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
import { MONO, useC } from '../theme/theme'
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
  return <Text {...rest} style={[mono && { fontFamily: MONO }, style]} />
}

export function Sec({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  const c = useC()
  return (
    <View style={s.sec}>
      <T mono style={{ fontSize: 10.5, letterSpacing: 0.85, color: c.faint, textTransform: 'uppercase' }}>
        {children}
      </T>
      {right != null && <View style={{ marginLeft: 'auto' }}>{right}</View>}
    </View>
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

export function Note({ children }: { children: React.ReactNode }) {
  const c = useC()
  return <T style={{ fontSize: 11.5, lineHeight: 19, color: c.faint, paddingHorizontal: 15, paddingTop: 10 }}>{children}</T>
}

export function List({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[s.list, style]}>{children}</View>
}

/** 一行可点的条目。`gate` = 这条挂着门:同色低饱和底 + 中饱和边框,不用实心色块喊话。 */
export function Row({
  children,
  onPress,
  gate,
  disabled,
  style,
}: {
  children: React.ReactNode
  onPress?: () => void
  gate?: boolean
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
        { borderColor: gate ? c.gateBorder : c.border, backgroundColor: gate ? c.gateRowBg : c.surface },
        pressed && { backgroundColor: c.surface2, borderColor: c.border2 },
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
  const { style, invalid, ...rest } = props
  return (
    <TextInput
      placeholderTextColor={c.faint}
      {...rest}
      style={[
        s.field,
        { backgroundColor: c.bg2, borderColor: invalid ? c.err : c.border2, color: c.fg },
        style,
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
}: {
  onPress?: () => void
  children: React.ReactNode
  tone?: string
  disabled?: boolean
  badge?: string
  badgeGate?: boolean
}) {
  const c = useC()
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || !onPress}
      style={({ pressed }) => [s.ico, pressed && { backgroundColor: c.surface }, disabled && { opacity: 0.35 }]}
    >
      <T style={{ fontSize: 17, color: tone ?? c.fg2, lineHeight: 22 }}>{children}</T>
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
  list: { paddingHorizontal: 12, gap: 8 },
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

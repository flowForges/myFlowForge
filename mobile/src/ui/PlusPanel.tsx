import { Pressable, StyleSheet, View } from 'react-native'
import { useC } from '../theme/theme'
import { T } from './kit'
import { Icon } from './Icon'
import type { IconName } from './icons'
import { PANEL_H } from './inputPanel'

export type PlusItem = {
  key: string
  icon: IconName
  label: string
  onPress: () => void
  disabled?: boolean
}

/**
 * ＋ 面板。微信那块格子面板:**顶掉键盘、占它的位置**,所以不吃正文高度。
 *
 * ★★高度写死成 `PANEL_H` 而不是「上一次键盘多高」—— 理由在 inputPanel.ts。
 * ★★这里**只负责画**。开/关的时机是个三态机,在 `inputPanel.ts` 里(有单测),
 *  因为「点 ＋ 时先收键盘,而收键盘的事件会把面板自己关掉」这个坑盯着代码是看不出来的。
 *
 * ★探测不到的格子(比如旧包里没有文件选择器)由调用方**整个不传进来**,
 *  不要传一个 disabled 的进来 —— 摆一个灰的等于说「这里有东西,只是现在不能点」,
 *  而真相是要装新包才有。`disabled` 只用于「暂时不能点」(没连上、没选会话)。
 */
export function PlusPanel({ open, items }: { open: boolean; items: PlusItem[] }) {
  const c = useC()
  if (!open) return null
  return (
    <View style={[st.panel, { height: PANEL_H, backgroundColor: c.bg2, borderTopColor: c.border }]}>
      {items.map((it) => (
        <Pressable
          key={it.key}
          onPress={it.disabled ? undefined : it.onPress}
          disabled={it.disabled}
          style={({ pressed }) => [st.cell, it.disabled && { opacity: 0.4 }, pressed && { opacity: 0.6 }]}
        >
          <View style={[st.tile, { backgroundColor: c.surface, borderColor: c.border }]}>
            <Icon name={it.icon} size={26} color={c.fg2} />
          </View>
          <T style={{ fontSize: 11.5, color: c.muted }}>{it.label}</T>
        </Pressable>
      ))}
    </View>
  )
}

const st = StyleSheet.create({
  panel: { flexDirection: 'row', flexWrap: 'wrap', alignContent: 'flex-start', paddingTop: 18, borderTopWidth: StyleSheet.hairlineWidth },
  // 一行 4 个。★`width: '25%'` 而不是 flex:1 —— 只有 3 个格子时也要靠左排,不能摊开占满一行
  // (摊开的话第二排加进来时全部会跳位)。
  cell: { width: '25%', alignItems: 'center', gap: 7, marginBottom: 20 },
  tile: { width: 58, height: 58, borderRadius: 15, alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth },
})

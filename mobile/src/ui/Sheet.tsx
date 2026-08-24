import React from 'react'
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useC } from '../theme/theme'
import { RADIUS } from '../theme/tokens'
import { T } from './kit'

/** 底部抽屉。`.sheet` + `.scrim`,原型里选代理 / 选权限档都用它。 */
export function Sheet({
  open,
  onClose,
  title,
  sub,
  children,
}: {
  open: boolean
  onClose: () => void
  title: string
  sub?: string
  children: React.ReactNode
}) {
  const c = useC()
  const insets = useSafeAreaInsets()
  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
      {/* 遮罩本身就是「点外面关掉」的热区 —— 手机上没有 Esc。 */}
      <Pressable style={[st.scrim, { backgroundColor: c.scrim }]} onPress={onClose} />
      <View
        style={[
          st.sheet,
          { backgroundColor: c.surface, borderTopColor: c.border2, paddingBottom: Math.max(14, insets.bottom) },
        ]}
      >
        <View style={[st.grab, { backgroundColor: c.border2 }]} />
        <T style={{ marginHorizontal: 16, marginTop: 6, fontSize: 16.5, fontWeight: '600', color: c.fg }}>{title}</T>
        {sub ? (
          <T style={{ marginHorizontal: 16, marginTop: 2, fontSize: 12.5, lineHeight: 19, color: c.muted }}>{sub}</T>
        ) : null}
        <ScrollView contentContainerStyle={{ padding: 14, gap: 8 }}>{children}</ScrollView>
      </View>
    </Modal>
  )
}

const st = StyleSheet.create({
  scrim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: '86%',
    borderTopLeftRadius: RADIUS.sheet,
    borderTopRightRadius: RADIUS.sheet,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  grab: { width: 38, height: 4, borderRadius: 999, alignSelf: 'center', marginTop: 9, marginBottom: 3 },
})

import React, { useEffect, useRef, useState } from 'react'
import { KeyboardAvoidingView, Modal, Platform, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useC } from '../theme/theme'
import { Btn, Field, IconBtn, T, TopBar, TopTitle } from './kit'

/**
 * composer 展开成的全屏编辑层(设计文档 §5.5.4)。chat.tsx 的输入框写死
 * `minHeight 44 / maxHeight 108`,粘一段长 prompt 就只剩一条缝可写 —— 这里给一整屏。
 *
 * ★这是一份**独立草稿**,不是外面 `value` 的镜子:`open` 从 false→true 那一次跳变才拿
 *  `value` 起草,之后完全自己管;`onDone` 才把草稿带回去,`onCancel` 直接丢弃。
 *  要是真双向绑外面那个 state,「取消」就什么都拦不住 —— 外面的 state 早就被每一次
 *  按键同步过去了,取消等于假的。
 */
export function BigEditor({
  open,
  value,
  onCancel,
  onDone,
}: {
  open: boolean
  value: string
  onCancel: () => void
  onDone: (text: string) => void
}) {
  const c = useC()
  const insets = useSafeAreaInsets()
  const [draft, setDraft] = useState(value)
  const prevOpen = useRef(open)

  useEffect(() => {
    // 只认 false→true 这一次跳变去重新取值。`open` 保持 true 期间外面的组件因为别的
    // state 重渲染,`value` 引用可能跟着变,但那不该盖掉正在编辑的草稿。
    if (open && !prevOpen.current) setDraft(value)
    prevOpen.current = open
  }, [open, value])

  return (
    <Modal visible={open} animationType="slide" onRequestClose={onCancel}>
      {/* Android 物理返回键默认关不掉 Modal —— onRequestClose 显式接到「取消」,
          不然这就是一个进得去出不来的全屏层。 */}
      <KeyboardAvoidingView
        style={{ flex: 1, backgroundColor: c.bg }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <TopBar
          left={
            <IconBtn label="取消" onPress={onCancel}>
              ‹
            </IconBtn>
          }
          right={
            <Btn size="sm" kind="pri" onPress={() => onDone(draft)}>
              完成
            </Btn>
          }
        >
          <TopTitle title="写点什么" />
        </TopBar>
        <Field
          value={draft}
          onChangeText={setDraft}
          multiline
          autoFocus
          textAlignVertical="top"
          style={{ flex: 1, borderWidth: 0, borderRadius: 0, backgroundColor: c.bg, fontSize: 15.5 }}
        />
        <View style={{ paddingHorizontal: 14, paddingTop: 4, paddingBottom: Math.max(10, insets.bottom) }}>
          <T style={{ fontSize: 11.5, color: c.faint }}>{draft.length} 字</T>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  )
}

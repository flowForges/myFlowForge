import { Pressable, StyleSheet, View } from 'react-native'
import { MONO, useC } from '../theme/theme'
import { T } from './kit'

/**
 * 工作流状态条。常驻在对话区顶部,不参与滚动。
 *
 * 版式对着桌面端 `WorkflowRibbon.tsx`:左边「流名 · 2/4 技术方案设计 · claude」,右边推进按钮 + 退出。
 * ★用中性色 + 强调色描边,**不用第二种实底彩色** —— 屏幕上唯一的实底彩色块永远是门。
 */
export function WorkflowRibbon({
  flowName,
  stageIndex,
  stageCount,
  stageName,
  provider,
  phase,
  advanceLabel,
  advanceDisabled,
  onAdvance,
  onExit,
  onSupplement,
}: {
  flowName: string
  stageIndex: number
  stageCount: number
  stageName: string
  provider: string
  phase: 'chatting' | 'executing' | 'done'
  advanceLabel: string
  advanceDisabled?: boolean
  onAdvance: () => void
  onExit: () => void
  /** 只在执行尾段给 —— 那是手机上唯一能影响正在跑的工作流的通道。 */
  onSupplement?: () => void
}) {
  const c = useC()
  const done = phase === 'done'
  const executing = phase === 'executing'
  const tint = done ? c.ok : executing ? c.accent : c.fg2

  return (
    <View style={[st.bar, { borderBottomColor: c.border, backgroundColor: c.bg2 }]}>
      <View style={[st.dot, { backgroundColor: tint }]} />
      <T numberOfLines={1} style={{ fontSize: 12.5, fontWeight: '600', color: c.fg, flexShrink: 1 }}>
        {flowName}
      </T>
      <T mono style={{ fontSize: 11.5, color: tint }}>
        {done ? '已完成' : `${stageIndex + 1}/${stageCount}`}
      </T>
      {!done ? (
        <T numberOfLines={1} style={{ fontSize: 11.5, color: c.muted, flexShrink: 1 }}>
          {stageName}
          {provider ? ` · ${provider}` : ''}
        </T>
      ) : null}

      <View style={{ flex: 1, minWidth: 4 }} />

      {executing ? (
        <>
          <T style={{ fontSize: 11.5, color: c.accent }}>执行中…</T>
          {onSupplement ? (
            <Pressable onPress={onSupplement} hitSlop={6} style={({ pressed }) => [st.act, { borderColor: c.border2 }, pressed && { opacity: 0.7 }]}>
              <T style={{ fontSize: 11.5, color: c.fg2 }}>补充说明</T>
            </Pressable>
          ) : null}
        </>
      ) : !done ? (
        <Pressable
          onPress={onAdvance}
          disabled={advanceDisabled}
          hitSlop={6}
          style={({ pressed }) => [
            st.act,
            { borderColor: c.pillAccBorder },
            pressed && { opacity: 0.7 },
            advanceDisabled && { opacity: 0.4 },
          ]}
        >
          <T numberOfLines={1} style={{ fontSize: 11.5, fontWeight: '600', color: c.accent }}>
            {advanceLabel}
          </T>
        </Pressable>
      ) : null}

      <Pressable onPress={onExit} hitSlop={8} style={{ paddingHorizontal: 4 }}>
        <T style={{ fontSize: 13, color: c.faint }}>✕</T>
      </Pressable>
    </View>
  )
}

const st = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  dot: { width: 6, height: 6, borderRadius: 3 },
  act: {
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 9,
    borderWidth: StyleSheet.hairlineWidth,
    maxWidth: 190,
  },
})

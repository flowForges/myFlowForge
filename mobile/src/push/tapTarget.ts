/**
 * 「点了这条通知,该跳哪儿」。**零 import** —— 这样它能被 `mobile` 那套 vitest 收进去
 * (`environment: 'node'`,一沾 react-native / expo-notifications 就跑不了)。
 *
 * ★为什么值得单拎出来:这份 data 是**从系统那儿回来的**,不是我们刚写下去那份。
 *  它在 iOS 和安卓的通知中心里躺过、被序列化过,冷启动那条还是从磁盘捞回来的。
 *  认错的后果不是报错,是「点了通知没反应」——手机端最难查的一类问题。
 */
export type TapTarget = { wsPath: string; sessionId: string | null }

export function tapTargetOf(data: unknown): TapTarget | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  const wsPath = typeof d.wsPath === 'string' ? d.wsPath : ''
  if (!wsPath) return null
  const sessionId = typeof d.sessionId === 'string' && d.sessionId ? d.sessionId : null
  return { wsPath, sessionId }
}

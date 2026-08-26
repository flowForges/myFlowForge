import AsyncStorage from '@react-native-async-storage/async-storage'

/**
 * 哪些工作区是展开的。**纯 Set 运算在 `@shared/ui/expanded`,两端同一份**;
 * 这里只有存取 —— 手机上是 AsyncStorage(异步),电脑端是 localStorage(同步),搬不到一起。
 *
 * ★存的是工作区**路径**,和电脑端一样。切主机之后路径多半对不上,于是那台机器上的工作区
 *  一律是收起的 —— 这正好是对的:换了台机器,谁展开着不该跟过来。
 */
const KEY = 'mff.expandedWs.v1'

export async function loadExpanded(): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY)
    const v: unknown = raw ? JSON.parse(raw) : []
    // ★存进去的东西可能被改坏(降级、手改)。只收字符串数组,收不住就当空的 ——
    //  这是「展开了哪些区」,坏了顶多多点一下,绝不该让整个列表屏炸掉。
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export async function saveExpanded(ids: string[]): Promise<void> {
  try { await AsyncStorage.setItem(KEY, JSON.stringify(ids)) } catch { /* 存不上就算了 */ }
}

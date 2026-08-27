import AsyncStorage from '@react-native-async-storage/async-storage'

/**
 * 顶部「需要你」那一块是不是被折起来了。存法和「哪些工作区展开着」(`expanded.ts`)完全一样:
 * AsyncStorage、`mff.` 前缀(「清除本地数据」按前缀扫,不带前缀的 key 会**活过**一次「已清除」,
 * 见 `storageKeys.test.ts`)、带 `.v1` 好将来换形状。
 *
 * ★为什么要存:折叠是**姿态**不是一次性操作。每次冷启动都替人重新展开一遍,
 *  等于第二天早上他又得再折一次 —— 那这个开关根本不算做完。
 *
 * ★★默认是**展开**,而且读不出来/读坏了一律当展开:
 *  这一块是手机端存在的理由(代理停在门上而你不在电脑前)。折起来是**人自己按的**;
 *  存储坏了就替他把门藏起来,那是这套代码最不能犯的一种错。
 */
const KEY = 'mff.needsYouFolded.v1'

export async function loadNeedsYouFolded(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(KEY)
    // ★只有**明明白白存着 true** 才算折起来。别写成 `v !== false`:
    //  那样存进去一个坏值(降级、手改、别的版本写的形状)就变成「折起来」,
    //  于是有门也看不见 —— 见上面那条。
    return (raw ? (JSON.parse(raw) as unknown) : false) === true
  } catch {
    return false
  }
}

export async function saveNeedsYouFolded(folded: boolean): Promise<void> {
  try { await AsyncStorage.setItem(KEY, JSON.stringify(folded)) } catch { /* 存不上就算了,本次仍然生效 */ }
}

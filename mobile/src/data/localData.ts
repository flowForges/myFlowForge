import AsyncStorage from '@react-native-async-storage/async-storage'

/**
 * 手机上存的所有东西都用这个前缀。见 `hosts.ts` / `expanded.ts` / `prefs.ts`。
 *
 * ★★「所有」这两个字**有东西在兑现**:`storageKeys.test.ts` 会把手机端源码里
 *  真正交给 AsyncStorage 的 key 全捞出来逐个验前缀(不读名单,读源码)。
 *  没有那条守卫的话,哪天谁写下 `const KEY = 'forge.foo'`,那份数据就会
 *  **安安静静地活过**下面这次声称「已清除」的清除 —— 而不会有任何测试变红。
 */
export const LOCAL_PREFIX = 'mff.'

/**
 * 清掉这台手机上记着的一切:主机清单、令牌、当前主机、展开状态、外观偏好。
 *
 * ★**按前缀扫,不按名单删。** 手写一份 key 名单看起来更「明确」,但下次谁加了第五个 key
 *  就会被这份名单静默漏掉 —— 而这里漏一个的后果是:界面说「已清除」,令牌却还躺在手机上。
 *  一个只清了一半的「清除」比不清更糟,因为人会据此把手机借出去 / 卖掉。
 *  所以宁可多清(前缀是我们自己的命名空间,底下没有别人的东西),也不能少清。
 *
 * @returns 实际删掉的 key,方便调用方在日志里核对。
 */
export async function clearLocalData(): Promise<string[]> {
  const keys = await AsyncStorage.getAllKeys()
  const mine = keys.filter((k) => k.startsWith(LOCAL_PREFIX))
  if (mine.length) await AsyncStorage.multiRemove(mine)
  return mine
}

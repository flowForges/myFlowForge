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

/**
 * UTF-8 字节数。★不用 `new Blob([s]).size`:RN 上 Blob 是 polyfill,而这里只是量个大小,
 *  为一个数字引入一个平台差异不值当。这个实现在 node 下也能直接测。
 */
export function byteLength(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.codePointAt(i)!
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c < 0x10000) n += 3
    else { n += 4; i++ }   // 代理对占两个 UTF-16 码元
  }
  return n
}

/** 这几个 key 各占多少字节。没存过的记 0 —— 「没占空间」和「这一项不存在」是两回事。 */
export async function sizesOf(keys: readonly string[]): Promise<Record<string, number>> {
  const pairs = await AsyncStorage.multiGet([...keys])
  const out: Record<string, number> = {}
  for (const k of keys) out[k] = 0
  for (const [k, v] of pairs) if (v) out[k] = byteLength(v)
  return out
}

/**
 * 删掉**一项**本地数据(「缓存管理」里逐项删用的)。
 *
 * ★★为什么它必须住在这个文件里,而不是让那一屏自己调 AsyncStorage:
 *  `storageKeys.test.ts` 那条守卫**只认字面量**,传变量一律判红 —— 而它判得对:
 *  它没法静态证明一个变量以 `mff.` 开头。把调用收进来之后,那一屏不再 import AsyncStorage,
 *  守卫没有东西要证明;而前缀这条不变式改由**运行时**在这里兑现。
 * ★越界直接抛,不是静默忽略:传进来一个别的前缀,意味着调用方在删**不属于这个 app 的数据**。
 */
export async function removeLocalKey(key: string): Promise<void> {
  if (!key.startsWith(LOCAL_PREFIX)) {
    throw new Error(`拒绝删除 ${key} —— 不以 ${LOCAL_PREFIX} 开头,不属于这个 app 的命名空间`)
  }
  await AsyncStorage.removeItem(key)
}

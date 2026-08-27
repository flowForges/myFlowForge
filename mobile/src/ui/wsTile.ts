/**
 * 工作区色块上写什么、什么颜色。
 *
 * ★★为什么不是「取首字母」:这是拿真数据渲染出来才发现的。用户那台机器上 10 个工作区里
 *  **6 个是 `for-` 开头**(for-test-0823 / for-new-0809 / for-new-0731 / for-new-0730 /
 *  for-new-flow / for-new-0731v2),取首字母就是一排颜色不同的「F」—— 等于没写。
 *  这类名字的**区分度在末尾**,不在开头。
 *
 * 所以规则是:取最后一段(按 `-` / `_` 切),
 *   - 段里有数字 → 取**后** 4 位。`0731` 和 `0731v2` 因此分别显示 `0731` 和 `31v2`;
 *     取前 4 位的话两个都是 `0731`,又撞回去了。
 *   - 纯词 → 取前 2 个字母大写(`flow`→FL、`website`→WE、`system`→SY)。
 *     词本身就有区分度,不需要 4 个字符那么挤。
 *
 * ★色块**只是节奏和锚点,不是标识**:真正的标识是紧挨着它的那个全名。
 *  所以两个区的字撞了不算 bug —— 色相不同,而且右边就是全名。
 *
 * ★这个文件刻意**不 import 任何东西**,好在 node 环境下单测
 *  (同 `sessionStatus.ts` / `autoScroll.ts` / `pasteOffload.ts`)。
 */

/** 色块上那几个字。 */
export function tileLabel(name: string): string {
  // ★兜底不能写成 `?? name`:`'---'` 切完一个非空段都不剩,退回原名又把分隔符捡了回来,
  //  显示成 `--`。没有可用的段就直接给占位符。(这条是测试抓出来的,不是想出来的。)
  const seg = name.split(/[-_]/).filter(Boolean).pop()
  if (!seg) return '·'
  return /\d/.test(seg) ? seg.slice(-4) : seg.slice(0, 2).toUpperCase()
}

/**
 * 色块的色相(0-359)。**按全名散列**,不是按上面那几个字 ——
 * 两个区的字撞了(`0731` / `0730` 只差一位)时,颜色是唯一还能把它们分开的东西。
 *
 * ★RN **不支持 `oklch()`**(原型的 d.css 里是 oklch),所以这里用 `hsl()`。
 *  饱和度和亮度写死:色相是身份,明暗不是 —— 让每一块在浅色和深色皮肤下都保持同样的分量。
 */
export function tileHue(name: string): number {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360
  return h
}

/** 直接可用的背景色。 */
export const tileColor = (name: string): string => `hsl(${tileHue(name)}, 42%, 44%)`

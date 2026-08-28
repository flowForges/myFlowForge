/**
 * 图标的**唯一**真相:一个名字,两张表。
 *
 * ★为什么要这一层:emoji 是彩色位图 —— 不跟选中态变色、不跟字重走,摆在 tab bar 里
 *  一眼就是「不是原生」。而「不是原生」正是用户说的那个「总感觉是个网页」的怪异感。
 *  SF Symbols 是 iOS 系统自带的那套,每一个原生 app 用的都是它。
 *
 * ★为什么不装 @expo/vector-icons:`expo-symbols` 已经在包里(`expo-router` 的传递依赖,
 *  见 ios/Podfile.lock 的 ExpoSymbols 57.0.2)—— 零新依赖、零重打包,当前这个包就能验。
 *  而 Ionicons 那套长得不像 iOS 系统图标,在 iPhone 上跟周围的原生 app 对不上号。
 *
 * ★这个文件刻意零 import(同 wsTile.ts / tree.ts):根 vitest.config.ts 里 `mobile`
 *  那个 project 跑在 node 上,带 React Native 的东西在那儿 import 不动。
 *  —— 例外:SFSymbol 是 import type,编译时擦除,无运行时代价。
 *
 * ★调用方**只准认 IconName**。别处出现 SF 符号名或 emoji 字面量,就等于这一层白做了 ——
 *  以后想整体换一套图标,得满仓库去找。
 */

import type { SFSymbol } from 'sf-symbols-typescript'

export const ICON_NAMES = [
  'chat', 'host', 'settings', 'add', 'changes', 'photo', 'camera',
  'workflow', 'file', 'expand', 'chevron', 'chevronDown',
] as const

export type IconName = (typeof ICON_NAMES)[number]

/** iOS。名字必须是真实存在的 SF Symbol —— 不存在的名字在 iOS 上渲染成一个看不见的洞,不报错。 */
export const SF: Record<IconName, SFSymbol> = {
  chat: 'bubble.left.and.bubble.right',
  host: 'desktopcomputer',
  settings: 'gearshape',
  add: 'plus',
  // ★不是 doc:那一屏说的是「这次改了什么」,不是「一份文档」。
  changes: 'arrow.triangle.branch',
  photo: 'photo',
  camera: 'camera',
  workflow: 'arrow.triangle.turn.up.right.diamond',
  file: 'doc',
  expand: 'arrow.up.left.and.arrow.down.right',
  chevron: 'chevron.right',
  chevronDown: 'chevron.down',
}

/**
 * 其余平台的退路。★键集必须和 SF 完全一致,漏一个就是安卓上一个空白格(icons.test.ts 钉住)。
 * ★★这张表**只放真的有人用的**。曾经想顺手把 `shield`(权限)、`back`(返回)、
 *  `plus`(输入行那颗 ＋)也列进来 —— 但权限键最后做成了「两个字 + 颜色」不用图标,
 *  返回键仍是那个 `‹` 字形,而输入行那颗 ＋ 用的就是 `add`。三个都是没人调的死条目。
 */
export const EMOJI: Record<IconName, string> = {
  chat: '💬',
  host: '🖥',
  settings: '⚙',
  add: '＋',
  changes: '🔀',
  photo: '🖼',
  camera: '📷',
  workflow: '⧉',
  file: '📄',
  expand: '⤢',
  chevron: '›',
  chevronDown: '▾',
}

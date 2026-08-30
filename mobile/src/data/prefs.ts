import AsyncStorage from '@react-native-async-storage/async-storage'

/**
 * 「跟着这台手机走」的两样外观偏好:主题和正文字号。
 *
 * ★它们**不跟主机走**。主机上存着工作区、会话、工作流 —— 那些换台电脑就该换;
 *  而「这块屏在我手里看不看得清」是这台设备的属性,切主机不该把它改掉。
 *  所以存在 AsyncStorage,和主机清单同一个存法、同一套 `mff.*` 命名。
 */
export type ThemePref = 'system' | 'light' | 'dark'
export type TextSize = 'sm' | 'md' | 'lg'

export type Prefs = { theme: ThemePref; text: TextSize }

/**
 * 正文字号倍率。`T` 拿它乘每一处 fontSize / lineHeight。
 *
 * ★三档刻意不激进:手机端的字号是**每一处都写死数字**的(照原型 d.css 抄的),
 *  ±8%/±12% 已经能一眼看出差别,再大就会把顶栏、pill、徽章这些定高的盒子撑破。
 */
export const TEXT_SCALE: Record<TextSize, number> = { sm: 0.92, md: 1, lg: 1.12 }

const KEY = 'mff.prefs.v1'

export const DEFAULT_PREFS: Prefs = { theme: 'system', text: 'md' }

/** 认不出来一律 'system'。降级回旧版、或者手改坏了,都不该让人对着一屏白字。 */
export function parseThemePref(v: unknown): ThemePref {
  return v === 'system' || v === 'light' || v === 'dark' ? v : 'system'
}

/** 认不出来一律 'md'。 */
export function parseTextSize(v: unknown): TextSize {
  return v === 'sm' || v === 'md' || v === 'lg' ? v : 'md'
}

export async function loadPrefs(): Promise<Prefs> {
  try {
    const raw = await AsyncStorage.getItem(KEY)
    const v: unknown = raw ? JSON.parse(raw) : null
    // ★逐字段兜底,不整份丢掉:一个字段坏了不该把另一个也一起退回默认。
    //  形状根本不对(数组 / 数字 / 字符串)时不需要额外判断 —— 在这些东西上取 `.theme`
    //  只会拿到 undefined,`parse*` 那两个白名单接着把它变成默认值;
    //  唯一会抛的是 null/undefined,`?? {}` 已经挡住了。多写一个 `Array.isArray` 守卫
    //  改不了任何一种输入的结果(变异验证过:删掉它 7 条测试全绿),所以不写。
    const o = (v ?? {}) as Record<string, unknown>
    return { theme: parseThemePref(o.theme), text: parseTextSize(o.text) }
  } catch {
    // ★catch 一律吞:这两样是外观,读不出来最多是长得跟上次不一样;
    //  而这一屏是「加主机」和「清本地数据」的唯一入口,绝不能因为它抛而进不去。
    return { ...DEFAULT_PREFS }
  }
}

export async function savePrefs(p: Prefs): Promise<void> {
  try { await AsyncStorage.setItem(KEY, JSON.stringify(p)) } catch { /* 存不上就算了,本次会话仍然生效 */ }
}

/**
 * 用户选的档 → 要告诉**原生层**的那个值。
 *
 * ★★2026-08-30 真机:安卓上「设置里选浅色」不生效,一直是深的。
 *  上一轮以为是 `android:forceDarkAllowed`(那条确实也要关,已经在 `plugins/withNoForceDark.js` 里),
 *  但那只挡住了「系统把我们画好的浅色反色回去」。**真正缺的是另一半:我们从来没告诉过安卓
 *  用户选了浅色。** 换调色板只发生在 JS 里 —— 原生 window 仍然停在 night 模式,
 *  `Theme.AppCompat.DayNight` 继续解析成深色那一套,`values-night/colors.xml` 继续生效,
 *  ROM 也就一直把这个 app 当成「深色 app」在处理。
 *
 * `Appearance.setColorScheme()` 就是补这一半的:安卓上它落到
 * `AppCompatDelegate.setDefaultNightMode(MODE_NIGHT_NO / YES / FOLLOW_SYSTEM)`。
 * ★`MainActivity` 的 `configChanges` 里有 `uiMode`,所以这一下**不会重建 activity**(不闪)。
 *
 * ★★「跟随系统」要传**字面量 `'unspecified'`** —— RN 的 `ColorSchemeName` 就是
 *  `'light' | 'dark' | 'unspecified'` 这三个值。**传 `null` / `undefined` 是个静默的坑**:
 *  原生那边是 `when (style) { "dark"->… "light"->… "unspecified"->… }`,**没有 else** ——
 *  给一个对不上的值就是什么都不做,于是「切回跟随系统」会永远卡在上一次那一档,
 *  而且不报任何错。
 * ★也不能给「当前系统是什么」的具体值:那等于把「跟随系统」钉死成那一刻的样子,之后系统再切就不跟了。
 */
export function nativeColorScheme(pref: ThemePref): 'light' | 'dark' | 'unspecified' {
  return pref === 'system' ? 'unspecified' : pref
}

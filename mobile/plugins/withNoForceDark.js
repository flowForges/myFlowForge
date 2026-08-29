const { withAndroidStyles } = require('expo/config-plugins')

/**
 * 关掉安卓的「强制深色」(`android:forceDarkAllowed`)。
 *
 * ## ★★为什么必须关
 *
 * 我们的 app 主题是 `Theme.AppCompat.DayNight.NoActionBar`,而 `android:forceDarkAllowed`
 * 在 API 29+ 上**默认是 true**。它的意思是「系统开了深色模式时,允许安卓自动把这个 app 的
 * 画面反色」—— 那是给没做深色适配的老 app 的兜底。
 *
 * 而我们**自己做了完整的深色**(`src/theme/tokens.ts` 两套色板,用户还能在设置里三选一)。
 * 两者叠在一起的结果是:用户在设置里选「浅色」,JS 确实换成了浅色,然后**系统在原生层
 * 又把它刷回深色** —— 表现就是 2026-08-29 真机反馈的那句「安卓端主题设置不生效」。
 * iOS 上没有这个机制,所以这个 bug **只在安卓上出现**,在 iOS 上怎么试都试不出来。
 *
 * ★国产 ROM(Flyme / MIUI / EMUI)对 force-dark 尤其激进 —— 它们的「深色模式」开关
 *  往往就是全局强制反色,所以这类机器上更容易撞上。
 *
 * ## 为什么是 config plugin 而不是直接改 styles.xml
 *
 * `android/` 是 `expo prebuild` 生成的。直接改那个文件,下一次 prebuild(比如加一个原生依赖
 * 的时候)就会把它覆盖掉 —— 而且**不会有任何报错**,只是这个 bug 悄悄回来了。
 * 写成 plugin,它是 `app.json` 的一部分,每次 prebuild 都会被重新应用。
 *
 * ## ★★为什么是手写而不是用 `AndroidConfig.Styles.assignStylesValue`
 *
 * 那个帮手要传一个 `parent` 分组,而它按 **name + parent** 找分组:传
 * `getAppThemeLightNoActionBarGroup()` 的话,它找不到我们这个 `DayNight` 父类的 `AppTheme`,
 * 于是**又新建一个同名 `AppTheme`**,parent 还是 `Light`。结果是 styles.xml 里两个同名 style,
 * 后一个赢 —— 原来那个的 `colorPrimary`、透明状态栏、`editTextBackground` 全丢了。
 * (第一版就是这么写的,prebuild 出来一眼看见两个 AppTheme。)
 * 所以这里按**名字**找到现有那一个,往里塞,不碰它的 parent。
 */
const STYLE_NAME = 'AppTheme'
const ITEM = 'android:forceDarkAllowed'

module.exports = function withNoForceDark(config) {
  return withAndroidStyles(config, (cfg) => {
    const styles = cfg.modResults?.resources?.style
    if (!Array.isArray(styles)) return cfg
    const app = styles.find((s) => s?.$?.name === STYLE_NAME)
    // ★找不到就**什么都不做**,不要新建一个。Expo 哪天改了主题名字的话,
    //  静默新建会造出上面说的那种同名冲突;什么都不做只是这条设置没生效,
    //  而下面 `native:check` 里那条断言会红。
    if (!app) return cfg
    app.item = app.item ?? []
    const existing = app.item.find((i) => i?.$?.name === ITEM)
    if (existing) existing._ = 'false'
    else app.item.push({ _: 'false', $: { name: ITEM } })
    return cfg
  })
}

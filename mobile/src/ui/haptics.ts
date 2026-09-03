/**
 * 触感反馈。
 *
 * ★为什么加:真机上用户说「总感觉 app 是一个网页的感觉,但又说不出来」。
 *  底部没有常驻栏是他能说出来的那一条;**全 app 零触感**大概率是那个说不出来的 ——
 *  原生 app 里每个有分量的动作都会震一下,而这里所有动作都只发生在视觉里。
 *
 * ★★克制。**普通点击不震** —— 每一下都震就等于没震,而且很快会让人烦。
 *  只有「有分量」的动作才上:手势到位、菜单弹出、切换、完成、被拦住。
 *
 * ★`expo-haptics` 是新原生依赖,所以**运行时 require + 整条静默降级**:
 *  旧包里探测不到就什么都不做。绝不能让一个锦上添花的东西炸掉一条真功能路径
 *  (「左滑到位」「切 tab」都在这条路上)。
 *
 * ★★主闸门是 `pickSupport.ts` 的 `canHaptics()`(和 `canPickImage`/`canPickFile` 同一排):
 *  `requireOptionalNativeModule('ExpoHaptics')` 自己不抛,原生模块没链接时同步返回 `null`。
 *  为假时下面**根本不 require `expo-haptics` 那个 JS 包**,也就根本不会走到
 *  `impactAsync`/`notificationAsync`/`selectionAsync` 那几个调用 —— 下一段说的那个异步坑
 *  在这道闸后面**压根不会发生**,不是靠 `.catch()` 兜住的。
 *
 * ★★但 `.catch()` 留着,不是防御性多写的废话:这道闸挡的是「原生模块没链接」,挡不住
 *  更极端的情况 —— 比如 JS 包本身没打进这个包、或者原生模块链接了但运行时另有原因失败。
 *  `expo-haptics` 的 `impactAsync` / `notificationAsync` / `selectionAsync` 全是
 *  **async function**:包内部 `if (!ExpoHaptics?.xxx) throw new UnavailabilityError(...)`
 *  这行 throw 在 async function 里**不是同步抛出**,它变成一个 **rejected promise**。
 *  套在调用外面的 `try/catch` 只抓同步抛出,抓不住这个 —— 那正是 Task 12 撞过的同一类坑
 *  (类型检查过、运行时炸)的异步版本,只是这道闸让它在正常路径上不可达而已,不是「不存在」。
 *  一个可选的震动不许在这类闸门没料到的角落留一个没接住的 rejection,所以 `.catch()` 不删。
 *
 * ★★为什么这里不能像 `app/chat.tsx` 那样直接 `import { canHaptics } from '../net/pickSupport'`:
 *  `pickSupport.ts` 顶部静态 `import`了 `expo-modules-core`,它又静态 `import` 了 `react-native`。
 *  这个文件会被 `haptics.test.ts` 在 vitest 的 `mobile` node 项目里加载,而 `react-native` 那份包
 *  用的是 Flow 语法 —— vitest 的 rollup 在**静态分析**阶段就直接崩(`Parse failure`),
 *  不是运行时抛错,连 try/catch 都救不了(炸的是「这段代码在被解析」,不是「这段代码在跑」)。
 *  所以下面和 `require('expo-haptics')` 同一个写法:**动态** `require()`,vitest 对动态 require
 *  走的是运行时 Node 解析,失败是一个能 catch 的异常,不是解析期崩溃。实测过:vitest 里这两个
 *  动态 require 都会落进 catch(前者是"Cannot find module",后者是类型剥离报错),`canHaptics`
 *  在测试环境里恒为 false —— 这就是为什么下面的 `H.mod` 在 vitest 里永远是 `null`,
 *  mutation 3 钉的还是 `tap()` 自己那层 `if (!m) return`。
 */

export const HAPTIC_EVENTS = [
  /** 左滑推到「露出动作」那个位置 */
  'swipeOpen',
  /** 长按呼出操作单 */
  'longPress',
  /** 切 tab */
  'switchTab',
  /**
   * 下拉刷新**拉到位、松手触发**的那一下。
   *
   * ★和 `swipeOpen` 是同一类事(手势越过阈值),所以强度也一样,不是又开了一档。
   * ★用户原话:「点击底部菜单有震动反馈,那首页的下拉刷新为啥没有反馈?」——
   *  这条规则本来就是「手势到位要震」,漏的是接线,不是判断。
   */
  'pullRefresh',
  /** 门被答掉 / 一轮跑完 */
  'done',
  /** 破坏性动作确认之后真的执行了 */
  'destructive',
  /** 发送失败,或者一个被拦住的操作 */
  'blocked',
] as const

export type HapticEvent = (typeof HAPTIC_EVENTS)[number]

/** 强度档。名字对齐 expo-haptics 的三类 API(impact / selection / notification)。 */
export type HapticKind = 'light' | 'medium' | 'selection' | 'success' | 'warning' | 'error'

export function hapticKindFor(ev: HapticEvent): HapticKind {
  switch (ev) {
    case 'swipeOpen':
    // 下拉刷新和左滑到位是同一类:手势越过阈值,轻轻一下确认「收到了」。
    case 'pullRefresh':
      return 'light'
    case 'longPress':
      return 'medium'
    case 'switchTab':
      return 'selection'
    case 'done':
      return 'success'
    // ★破坏性动作完成用 warning 不是 success:刚归档掉一个工作区,
    //  手上震出一声「好的」是误导 —— 那不是一件值得庆祝的事。
    case 'destructive':
      return 'warning'
    case 'blocked':
      return 'error'
  }
}

/**
 * 主闸门:原生模块有没有链接。★动态 require——理由见文件头那段「为什么这里不能像
 *  app/chat.tsx 那样直接 import」。vitest 里这一步恒失败(catch 到,返回 false),
 *  和真机上「旧包探测不到」走的是同一条静默降级路径。
 */
const HAS_HAPTICS: boolean = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('../net/pickSupport') as { canHaptics: () => boolean }
    return mod.canHaptics()
  } catch {
    return false
  }
})()

/** 只有主闸门放行了才去 require `expo-haptics` 这个 JS 包本体(拿 API 用)。
 *  ★探测一次就够,后面每次调用直接返回同一个结果。 */
const H: { mod: Record<string, unknown> | null } = HAS_HAPTICS
  ? (() => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return { mod: require('expo-haptics') as Record<string, unknown> }
      } catch {
        return { mod: null }
      }
    })()
  : { mod: null }

/**
 * 震一下。★★**永远不抛。** 模块不在、平台不支持、原生模块没链接(旧包)、调用失败,
 * 一律静默跳过 —— 包括异步链路上的失败(见文件头那段说明)。
 */
export function tap(ev: HapticEvent): void {
  const m = H.mod
  if (!m) return
  try {
    const kind = hapticKindFor(ev)
    let p: unknown
    if (kind === 'selection') {
      p = (m.selectionAsync as (() => unknown) | undefined)?.()
    } else if (kind === 'light' || kind === 'medium') {
      const styleEnum = m.ImpactFeedbackStyle as Record<string, unknown> | undefined
      const style = kind === 'light' ? styleEnum?.Light : styleEnum?.Medium
      p = (m.impactAsync as ((s?: unknown) => unknown) | undefined)?.(style)
    } else {
      const typeEnum = m.NotificationFeedbackType as Record<string, unknown> | undefined
      const type = typeEnum?.[kind === 'success' ? 'Success' : kind === 'warning' ? 'Warning' : 'Error']
      p = (m.notificationAsync as ((t?: unknown) => unknown) | undefined)?.(type)
    }
    // ★★这个 .catch 不是防御性多写的:三个 API 都是 async function,原生模块没链接时
    //  它们内部 throw 的 UnavailabilityError 会变成 rejected promise,不是同步抛出,
    //  外层 try/catch 抓不到。不接住它,旧包上每一次 tap() 都会留一个未处理的 rejection。
    if (p && typeof (p as { catch?: unknown }).catch === 'function') {
      ;(p as Promise<unknown>).catch(() => {})
    }
  } catch {
    // 静默。见上面那段。
  }
}

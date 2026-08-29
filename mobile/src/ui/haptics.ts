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
 * ★★这里和 brief 给的样例代码有一处必须改掉,不是随手抄:`expo-haptics` 的
 *  `impactAsync` / `notificationAsync` / `selectionAsync` 全是 **async function**。
 *  它们的 JS 包装本身在任何情况下都 `require` 得到(纯 JS,不含原生代码),真正会
 *  炸的是**原生模块没链接**那一刻 —— 包内部 `if (!ExpoHaptics?.xxx) throw new
 *  UnavailabilityError(...)`,而这行 throw 在 async function 里**不是同步抛出**,
 *  它变成一个 **rejected promise**。套在调用外面的 `try/catch` 只抓同步抛出,
 *  抓不住这个 —— 那正是 Task 12 撞过的同一类坑(类型检查过、运行时炸)的异步版本。
 *  所以下面必须显式 `.catch()` 掉这个 promise,不能只在外面包 try/catch 就当完事。
 */

export const HAPTIC_EVENTS = [
  /** 左滑推到「露出动作」那个位置 */
  'swipeOpen',
  /** 长按呼出操作单 */
  'longPress',
  /** 切 tab */
  'switchTab',
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

/** 探测一次就够。★require 不到(旧包 / web)就永远是 null,后面每次调用直接返回。 */
const H: { mod: Record<string, unknown> | null } = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return { mod: require('expo-haptics') as Record<string, unknown> }
  } catch {
    return { mod: null }
  }
})()

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

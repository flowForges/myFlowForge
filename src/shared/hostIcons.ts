/**
 * 主机能选的那几枚图标。
 *
 * ★★**全是 emoji，因为 `MobileHost.icon` 本来就是个字符串字段**（默认 `🖥️`，`HostIcon` 直接把它
 *  画出来）。所以这套选择器是**零迁移**的：已经配好的主机一台都不用动，老版本 app 读到新图标
 *  也只是原样显示一个它不认识的 emoji —— 不会崩、不会变空。
 *  换成图片资源或图标字体的话，得同时改存储格式、渲染、以及「老记录怎么办」，为一件纯装饰的事
 *  不值当。
 *
 * ★这里**不做自动识别**：daemon 的 `ready` 帧里只有版本号和方法表，**不上报操作系统**，
 *  要认出「这是台 Mac」得改协议两端。手选一次的事，不值当。
 *
 * ★零 import，能在 node 那套 vitest 里直接测（同 `hosts.ts` 的其余纯函数）。
 */

export type HostIconOption = {
  /** 存进 `MobileHost.icon` 的值。 */
  icon: string
  /** 选择器里那行小字。 */
  label: string
}

/**
 * ★顺序 = 界面上从左到右。最常见的排前面：这个 app 的用户九成在 Mac 上跑 daemon。
 * ★六个是**一行放得下**的上限（390pt 宽下每格 ~44pt + 间距）。再多就要换行或横滚，
 *  而那会让「一眼看完、点一下」变成「先找一找」。
 */
export const HOST_ICONS: readonly HostIconOption[] = [
  { icon: '🖥️', label: 'Mac' },
  { icon: '🪟', label: 'Windows' },
  { icon: '🐧', label: 'Linux' },
  { icon: '💻', label: '笔记本' },
  { icon: '☁️', label: '服务器' },
  { icon: '🍓', label: '树莓派' },
] as const

/** 没选过时用哪个。★和 `hosts.ts` 的 `DEFAULT_HOST_ICON` 必须是同一个值，见下面的测试。 */
export const DEFAULT_HOST_ICON = '🖥️'

/**
 * 一台主机当前该高亮哪一格。
 *
 * ★空串（老记录、扫码进来的那些）算**默认那一枚** —— 不然打开单子会看到「一个都没选中」，
 *  而屏幕上那台主机明明画着 🖥️。
 * ★存着一个不在名单上的图标时**返回它自己**而不是回落成默认：那可能是更新版 app 写的，
 *  硬把它显示成默认等于骗人，而保存时又会把人家的图标改掉。
 */
export function currentHostIcon(icon: string): string {
  return icon || DEFAULT_HOST_ICON
}

/** 这枚图标在不在内置名单里。名单外的照样显示，只是选择器里没有那一格。 */
export function isBuiltinHostIcon(icon: string): boolean {
  return HOST_ICONS.some((o) => o.icon === currentHostIcon(icon))
}

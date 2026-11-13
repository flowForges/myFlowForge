// 电脑操作卡片 / 记录块共用的小格式化。屏幕来源的字符串一律:压空白 → 不可见字符可见 → 太长从左边掐。
import { visibleText, type Mod } from '@shared/computerUse'
import { collapseWhitespace } from '@shared/browserUse'

export const NAME_MAX = 40
export const MOD_SYM: Record<Mod, string> = { cmd: '⌘', ctrl: '⌃', alt: '⌥', shift: '⇧' }
export const BUTTON_LABEL: Record<'left' | 'right' | 'middle', string> = { left: '左键', right: '右键', middle: '中键' }

export function screenName(s: string | undefined): string {
  if (!s) return ''
  const t = Array.from(visibleText(collapseWhitespace(s)))
  return t.length > NAME_MAX ? '…' + t.slice(t.length - (NAME_MAX - 1)).join('') : t.join('')
}
export const fmtPt = (p?: { x: number; y: number }): string => (p ? `(${Math.round(p.x)}, ${Math.round(p.y)})` : '')

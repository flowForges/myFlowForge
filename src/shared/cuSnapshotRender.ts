/**
 * 快照给模型的紧凑文本(spec §8.2)。一行一节点,缩进表层级;给模型的渲染文本硬上限 18 000 字符。
 *
 * 纯函数,不碰 electron / node:主进程(driver.ts 的 snapshot 结果)、forgeMcp、渲染端三处共用。
 */
import type { SnapshotResult, SnapNodeWire } from './computerUse'

const TRUNC_MARK = '已截断 · 用 root 钻取'

/** states 的词汇表(native/mac/forge-cu/AXCore.swift 实际产出 disabled/focused/selected/expanded/collapsed;
 *  checked 留着给其它来源 / 未来角色用);offscreen 多数时候是独立的布尔字段,不在 states 里。 */
const STATE_LABEL: Readonly<Record<string, string>> = {
  disabled: '禁用', focused: '焦点', selected: '已选中', checked: '已勾选',
  expanded: '已展开', collapsed: '已折叠', offscreen: '屏幕外',
}

function squashNewlines(s: string): string {
  return s.replace(/\r\n|\r|\n/g, ' ')
}

/** 截到 max 个字符(按码点数),截了就加 … 。 */
function cut(s: string, max: number): string {
  const chars = Array.from(s)
  return chars.length > max ? chars.slice(0, max).join('') + '…' : s
}

function escapeQuotes(s: string): string {
  return s.replace(/"/g, '\\"')
}

/** 名字截 120 字;值截 80 字;换行先压成空格,再截,再转义引号。 */
const fmtName = (s: string) => escapeQuotes(cut(squashNewlines(s), 120))
const fmtValue = (s: string) => escapeQuotes(cut(squashNewlines(s), 80))

function stateWords(n: SnapNodeWire): string[] {
  const words = n.states.map((s) => STATE_LABEL[s]).filter((w): w is string => !!w)
  if (n.offscreen && !n.states.includes('offscreen')) words.push(STATE_LABEL.offscreen)
  return words
}

function renderNode(n: SnapNodeWire, snapId: string): string {
  const fullRef = n.ref ? `@${snapId}:${n.ref}` : undefined
  let line = `${'  '.repeat(n.depth)}- ${n.role}`
  if (n.name !== undefined) line += ` "${fmtName(n.name)}"`
  if (fullRef) line += ` ${fullRef}`
  if (n.actions.length) line += ` [${n.actions.join(',')}]`
  if (n.value !== undefined) line += ` 值="${fmtValue(n.value)}"`
  const words = stateWords(n)
  if (n.childrenCount !== undefined) {
    const extra = words.length ? `, ${words.join(' ')}` : ''
    const root = fullRef ? ` → root=${fullRef}` : ''
    line += ` (${n.childrenCount} 项${extra}${root})`
  } else if (words.length) {
    line += ` ${words.join(' ')}`
  }
  return line
}

/** `窗口「<标题>」 complete|incomplete` + 一行一节点;超过 max(默认 18 000 字符)就在整行边界截断,末行标 `已截断 · 用 root 钻取`。 */
export function renderSnapshot(r: SnapshotResult, max = 18000): string {
  const title = r.window.title ?? r.app.name ?? ''
  const lines = [`窗口「${title}」 ${r.complete ? 'complete' : 'incomplete'}`, ...r.nodes.map((n) => renderNode(n, r.snapId))]
  const out = lines.join('\n')
  if (out.length <= max) return out
  const budget = Math.max(0, max - (TRUNC_MARK.length + 1))
  let head = out.slice(0, budget)
  const lastNL = head.lastIndexOf('\n')
  if (lastNL >= 0) head = head.slice(0, lastNL)
  return `${head}\n${TRUNC_MARK}`
}

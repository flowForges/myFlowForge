/**
 * 快照给模型的紧凑文本(spec §8.2)。一行一节点,缩进表层级;给模型的渲染文本硬上限 18 000 字符。
 *
 * 纯函数,不碰 electron / node:主进程(driver.ts 的 snapshot 结果)、forgeMcp、渲染端三处共用。
 *
 * 安全:窗口标题、控件 name / value 全部来自屏幕 / 被操作的 app,和截图文字一样不可信 —— 一个标题塞 `」 complete\n- button ...`
 * 就能伪造整行、伪造一个指向真实 ref 的假节点。所以都先过 sanitizeScreenText(和 wrapUntrusted 同一套:压空白、控制字符可见、
 * 掐掉能伪造标签的 `<`),再做我们自己这套格式的转义(先转义反斜杠、再转义引号 —— 反过来会让「以反斜杠结尾的名字」提前把
 * 我们加的收尾引号吃掉,让伪造内容看起来「跑到引号外面」)。
 */
import { sanitizeScreenText } from './computerUse'
import type { SnapshotResult, SnapNodeWire } from './computerUse'

const TRUNC_MARK = '已截断 · 用 root 钻取'

/** states 的词汇表(native/mac/forge-cu/AXCore.swift 实际产出 disabled/focused/selected/expanded/collapsed;
 *  checked 留着给其它来源 / 未来角色用);offscreen 多数时候是独立的布尔字段,不在 states 里。 */
const STATE_LABEL: Readonly<Record<string, string>> = {
  disabled: '禁用', focused: '焦点', selected: '已选中', checked: '已勾选',
  expanded: '已展开', collapsed: '已折叠', offscreen: '屏幕外',
}

/** 先转义反斜杠,再转义引号(顺序反了,以 `\` 结尾的名字会把我们加的收尾引号吃掉)。 */
function escapeForLine(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/** 名字截 120 字;值截 80 字;先经 sanitizeScreenText(压空白、控制字符可见、掐掉伪造标签的 `<`),再转义。 */
const fmtName = (s: string) => escapeForLine(sanitizeScreenText(s, 120))
const fmtValue = (s: string) => escapeForLine(sanitizeScreenText(s, 80))

function stateWords(n: SnapNodeWire): string[] {
  const words = n.states.map((s) => STATE_LABEL[s]).filter((w): w is string => !!w)
  if (n.offscreen && !n.states.includes('offscreen')) words.push(STATE_LABEL.offscreen)
  return words
}

function renderNode(n: SnapNodeWire, snapId: string): string {
  const fullRef = n.ref ? `@${snapId}:${n.ref}` : undefined
  let line = `${'  '.repeat(Math.max(0, n.depth))}- ${n.role}`
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

/** `s.slice(0, maxUnits)`,但不切开代理对:要切的位置正好是一个高位代理 → 往前退一个单元,连它一起去掉。 */
function sliceUnits(s: string, maxUnits: number): string {
  const cut = Math.max(0, Math.min(maxUnits, s.length))
  if (cut === s.length) return s
  if (cut > 0) {
    const code = s.charCodeAt(cut - 1)
    if (code >= 0xd800 && code <= 0xdbff) return s.slice(0, cut - 1)
  }
  return s.slice(0, cut)
}

/**
 * `窗口「<标题>」 complete|incomplete` + 一行一节点;超过 max(默认 18 000 字符,按 UTF-16 code unit 计)就在整行边界截断,
 * 末行标 `已截断 · 用 root 钻取`。保证返回值长度永远 ≤ max,且不会在代理对中间切开。
 */
export function renderSnapshot(r: SnapshotResult, max = 18000): string {
  const title = sanitizeScreenText(r.window.title || r.app.name || '', 120)
  const lines = [`窗口「${title}」 ${r.complete ? 'complete' : 'incomplete'}`, ...r.nodes.map((n) => renderNode(n, r.snapId))]
  const out = lines.join('\n')
  if (out.length <= max) return out

  const marker = `\n${TRUNC_MARK}`
  if (marker.length >= max) return sliceUnits(TRUNC_MARK, max)

  let head = sliceUnits(out, max - marker.length)
  const lastNL = head.lastIndexOf('\n')
  if (lastNL >= 0) head = head.slice(0, lastNL)
  return `${head}${marker}`
}

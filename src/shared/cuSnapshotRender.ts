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

/** 文字里长得像 ref 的串(`@s3:e9`)把 `@` 换成全角:模型只能从我们自己写的 ref 位置拿到 ref。 */
const defangRefs = (s: string) => s.replace(/@(?=s\d+:e\d+)/g, '＠')

/** 名字截 120 字;值截 80 字;先经 sanitizeScreenText(压空白、控制字符可见、掐掉伪造标签的 `<`),再转义。 */
const fmtName = (s: string) => escapeForLine(defangRefs(sanitizeScreenText(s, 120)))
const fmtValue = (s: string) => escapeForLine(defangRefs(sanitizeScreenText(s, 80)))

/** forge-cu 的角色词表(AXCore.swift roleTable / subroleTable 的值 + unknown)。线上数据:表外的一律 `unknown`。 */
const ROLES: ReadonlySet<string> = new Set([
  'alert', 'alertdialog', 'application', 'article', 'banner', 'browser', 'button', 'cell', 'checkbox', 'colorwell',
  'column', 'combobox', 'complementary', 'contentinfo', 'datefield', 'definition', 'dialog', 'disclosure', 'dockitem',
  'document', 'drawer', 'form', 'grid', 'group', 'handle', 'heading', 'helptag', 'image', 'incrementor', 'layoutitem',
  'levelindicator', 'link', 'list', 'listbox', 'log', 'main', 'marquee', 'math', 'matte', 'menu', 'menubutton',
  'menuitem', 'navigation', 'note', 'option', 'outline', 'page', 'paragraph', 'popover', 'progressbar', 'radiobutton',
  'radiogroup', 'region', 'relevanceindicator', 'row', 'ruler', 'rulermarker', 'scrollarea', 'scrollbar', 'search',
  'separator', 'sheet', 'slider', 'splitter', 'statictext', 'status', 'switch', 'tab', 'table', 'tablist', 'tabpanel',
  'term', 'textfield', 'timefield', 'timer', 'toolbar', 'tooltip', 'treeitem', 'unknown', 'webarea', 'window',
])
/** 动作词表 = computer_act 的 action;表外的丢掉。 */
const ACTIONS: ReadonlySet<string> = new Set([
  'click', 'menu', 'set', 'type', 'focus', 'toggle', 'expand', 'collapse', 'select', 'scroll', 'scrollTo', 'submit',
])
const roleOf = (r: unknown) => (typeof r === 'string' && ROLES.has(r) ? r : 'unknown')

/** forge-cu 发的是完整 ref(`@s3:e4`),老测试 / 其它来源可能是本地 id(`e4`);别的快照的 ref、形状不对的一律不出。 */
function refOf(ref: unknown, snapId: string): string | undefined {
  if (typeof ref !== 'string') return undefined
  if (/^e\d+$/.test(ref)) return `@${snapId}:${ref}`
  const m = /^@(s\d+):e\d+$/.exec(ref)
  return m && m[1] === snapId ? ref : undefined
}

function stateWords(n: SnapNodeWire): string[] {
  const states = Array.isArray(n.states) ? n.states : []
  const words = states.map((s) => (Object.prototype.hasOwnProperty.call(STATE_LABEL, s) ? STATE_LABEL[s] : '')).filter((w) => !!w)
  if (n.offscreen === true && !states.includes('offscreen')) words.push(STATE_LABEL.offscreen)
  return words
}

function renderNode(n: SnapNodeWire, snapId: string, indent = true): string {
  const fullRef = refOf(n.ref, snapId)
  const depth = indent && Number.isInteger(n.depth) ? Math.min(Math.max(0, n.depth), 50) : 0
  let line = `${'  '.repeat(depth)}- ${roleOf(n.role)}`
  if (typeof n.name === 'string') line += ` "${fmtName(n.name)}"`
  if (fullRef) line += ` ${fullRef}`
  const actions = (Array.isArray(n.actions) ? n.actions : []).filter((a) => ACTIONS.has(a))
  if (actions.length) line += ` [${actions.join(',')}]`
  if (typeof n.value === 'string') line += ` 值="${fmtValue(n.value)}"`
  const words = stateWords(n)
  if (typeof n.childrenCount === 'number' && Number.isInteger(n.childrenCount) && n.childrenCount >= 0) {
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
/** 一个节点一行(不缩进);wait_for 命中的节点用。 */
export function renderNodeLine(n: SnapNodeWire, snapId: string): string {
  return renderNode(n, snapId, false)
}

/** 标题里的 「」 换成 『』:标题关不掉我们自己的 「…」;长得像 ref 的串同样去牙。 */
const fmtTitle = (s: string) => defangRefs(sanitizeScreenText(s, 120)).replace(/「/g, '『').replace(/」/g, '』')

export function renderSnapshot(r: SnapshotResult, max = 18000): string {
  const raw = typeof r.window.title === 'string' && r.window.title.trim() ? r.window.title : (r.app.name ?? '')
  const title = fmtTitle(raw)
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

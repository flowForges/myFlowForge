// 对话正文里的「文件引用」判定。
//
// 背景:模型产出文档/图片后爱写 `[设计文档](docs/design.md)`,以前点下去什么都不发生 —— MdLink 一律
// preventDefault(相对路径在渲染进程里导航会把 SPA 走白屏,那条约束不能破),而 http(s) 之外没有任何出口。
// 这里给出「这个 href 是不是指向一个本地文件」和「这类文件该怎么打开」两个纯判断,主进程负责真正的存在性
// 与越界校验(见 file:resolveRef)。

export type HrefKind = 'external' | 'anchor' | 'path'

/**
 * href 归类。
 * - external: http/https —— 老行为不变,交给系统浏览器
 * - anchor: 页内锚点,不是文件
 * - path: 其余一切(相对、绝对、./、file:) —— 当作本地文件路径去试
 *
 * 注意 mailto:/javascript: 这类带协议的**不是** path:它们不是文件,放进去只会让点击变成一次注定失败的
 * IPC。只有 file: 例外(它就是文件),会被剥掉协议头还原成绝对路径。
 */
export function classifyHref(href: string): HrefKind {
  const h = href.trim()
  if (!h) return 'anchor'
  if (h.startsWith('#')) return 'anchor'
  if (/^https?:\/\//i.test(h)) return 'external'
  if (/^file:/i.test(h)) return 'path'
  // 其它已知协议(mailto:、tel:、javascript:、data:、forge-*: …)一律不当文件。
  // Windows 盘符 C:\ 会被 /^[a-z][a-z0-9+.-]*:/ 命中,所以单独放行。
  if (/^[a-zA-Z]:[\\/]/.test(h)) return 'path'
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(h)) return 'anchor'
  return 'path'
}

/** file:///a/b → /a/b;其余原样返回。 */
export function stripFileProtocol(href: string): string {
  const h = href.trim()
  if (!/^file:/i.test(h)) return h
  try { return decodeURIComponent(new URL(h).pathname) } catch { return h.replace(/^file:\/*/i, '/') }
}

/** 链接尾巴上的 #锚点 / ?query 不属于路径,解析前先剥掉。 */
export function stripHrefSuffix(href: string): string {
  return href.replace(/[#?].*$/, '')
}

export type PreviewKind = 'image' | 'markdown' | 'text' | 'system'

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif']
const MARKDOWN_EXT = ['md', 'markdown']
// 「系统默认程序打开」的名单是**白名单的反面**:这些后缀在 app 内预览只会是乱码,直接丢给 shell.openPath。
const SYSTEM_EXT = [
  'pdf', 'zip', 'gz', 'tar', 'rar', '7z', 'dmg', 'exe', 'app',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'key', 'pages', 'numbers',
  'mp3', 'mp4', 'mov', 'avi', 'mkv', 'wav', 'flac', 'psd', 'sketch', 'fig',
]

export function extOf(file: string): string {
  const base = file.split(/[\\/]/).pop() ?? ''
  const i = base.lastIndexOf('.')
  return i <= 0 ? '' : base.slice(i + 1).toLowerCase()
}

/**
 * 这个文件该怎么打开。
 * text 里**包含 .html** —— 用户选的是「预览内看源码 + 头部一个『用浏览器打开』」,不是点了就丢给浏览器。
 * 没有后缀的文件(LICENSE、Makefile)当文本预览,别丢给系统。
 */
export function previewKindOf(file: string): PreviewKind {
  const ext = extOf(file)
  if (IMAGE_EXT.includes(ext)) return 'image'
  if (MARKDOWN_EXT.includes(ext)) return 'markdown'
  if (SYSTEM_EXT.includes(ext)) return 'system'
  return 'text'
}

/** 预览头部是否给「用浏览器打开」按钮。 */
export function isHtmlFile(file: string): boolean {
  return ['html', 'htm'].includes(extOf(file))
}

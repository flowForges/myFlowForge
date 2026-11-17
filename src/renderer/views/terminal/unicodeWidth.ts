import type { IUnicodeVersionProvider, Terminal } from '@xterm/xterm'

/**
 * ★★xterm 的字宽表必须和 **shell 那边**的 wcwidth 一致,否则行编辑会画错位。
 *
 * xterm.js 默认只带一张 Unicode 6 的表:它把 🔥 😀 ✨ ✅ 这类「默认就按 emoji 显示」的字符算成
 * **1 格**。zsh 用的是系统 wcwidth(macOS 的 libc),算成 **2 格**。提示符里放一个 🔥,
 * 两边对「光标在第几列」的认知就差了一格 —— 平时逐字回显看不出来(相对移动),一旦 zsh 用
 * 「回行首 + 右移 N 格」来定位(行折了、zsh-autosuggestions 的灰色提示跨了行、退格重画),
 * 光标就落在实际字符右边一格:新字写错格子,灰色提示字母留在原地。
 * 2026-11 用户截图里的 `git padd` / `git coommit` / 中文被拉开 / 退格删不掉,都是这一格。
 *
 * 官方的修法是 `@xterm/addon-unicode11`,但这个仓库没装它(也不想为一张表加依赖),
 * 所以这里自己注册一个 provider。规则和 wcwidth 一样,数据直接用 JS 引擎自带的 Unicode 属性:
 *  · 0 格:C0/C1 控制字符、组合附加符(Mn/Me)、格式字符(Cf,含 ZWJ)、变体选择符、韩文中/尾字母;
 *    软连字符 U+00AD 例外(Cf,但 wcwidth 给 1)。
 *  · 2 格:East Asian Wide/Fullwidth(CJK、假名、韩文音节、全角)+ `Emoji_Presentation`。
 *    ★只认 Emoji_Presentation,不认 Extended_Pictographic:❤ ❯ ★ 这类默认文本样式的符号
 *    macOS wcwidth 给 1,算成 2 就反过来错一格。
 *  · 其余 1 格。
 */
export const FORGE_UNICODE_VERSION = 'forge-wcwidth'

type Width = 0 | 1 | 2

const ZERO = /^[\p{Mn}\p{Me}\p{Cf}]$/u
const EMOJI_WIDE = /^\p{Emoji_Presentation}$/u

/** East Asian Wide / Fullwidth 里**非 emoji** 的那部分(emoji 交给 Emoji_Presentation)。闭区间。 */
const EAST_ASIAN_WIDE: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], [0x2329, 0x232a], [0x2e80, 0x303e], [0x3041, 0x33ff],
  [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f],
  [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f],
  [0xff00, 0xff60], [0xffe0, 0xffe6],
  [0x16fe0, 0x16fe4], [0x16ff0, 0x16ff1], [0x17000, 0x18cff], [0x18d00, 0x18d08],
  [0x1aff0, 0x1b2ff], [0x1f200, 0x1f202], [0x1f210, 0x1f23b], [0x1f240, 0x1f248],
  [0x1f250, 0x1f251], [0x20000, 0x2fffd], [0x30000, 0x3fffd],
]

function compute(cp: number): Width {
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0
  if (cp < 0x7f) return 1
  if (cp === 0xad) return 1
  if (cp >= 0x1160 && cp <= 0x11ff) return 0
  const ch = String.fromCodePoint(cp)
  if (ZERO.test(ch)) return 0
  for (const [lo, hi] of EAST_ASIAN_WIDE) if (cp >= lo && cp <= hi) return 2
  if (EMOJI_WIDE.test(ch)) return 2
  return 1
}

/** BMP 一次性查表(xterm 每个字符都要问一次,不能每次跑正则);BMP 以外的按需算、记下来。 */
let bmp: Uint8Array | null = null
const astral = new Map<number, Width>()

function wcwidth(cp: number): Width {
  if (cp < 0x10000) {
    if (!bmp) { bmp = new Uint8Array(0x10000); for (let i = 0; i < 0x10000; i++) bmp[i] = compute(i) }
    return bmp[cp] as Width
  }
  let w = astral.get(cp)
  if (w === undefined) { w = compute(cp); astral.set(cp, w) }
  return w
}

/** xterm 内部的打包格式:`state << 3 | width << 1 | shouldJoin`(见 xterm 的 UnicodeService)。 */
const pack = (width: number, join: boolean) => ((width & 3) << 1) | (join ? 1 : 0)
const widthOf = (props: number) => (props >> 1) & 3

export const forgeUnicode: IUnicodeVersionProvider = {
  version: FORGE_UNICODE_VERSION,
  wcwidth,
  // 和 xterm 自带的 V6 provider 同一套拼接规则:0 宽的字符并进前一个格子,宽度取两者较大。
  charProperties(codepoint: number, preceding: number): number {
    let width: number = wcwidth(codepoint)
    let join = width === 0 && preceding !== 0
    if (join) {
      const old = widthOf(preceding)
      if (old === 0) join = false
      else if (old > width) width = old
    }
    return pack(width, join)
  },
}

/** 给一个终端装上并启用这张表。★要在第一个字节写进去之前调用(之后写进缓冲的字宽不会回头重算)。 */
export function applyForgeUnicode(term: Terminal): void {
  if (!term.unicode.versions.includes(FORGE_UNICODE_VERSION)) term.unicode.register(forgeUnicode)
  term.unicode.activeVersion = FORGE_UNICODE_VERSION
}

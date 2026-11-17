import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Terminal } from '@xterm/xterm'
import { forgeUnicode, FORGE_UNICODE_VERSION, applyForgeUnicode } from './unicodeWidth'

/**
 * 2026-11 用户报(1.2.10):内置终端里敲 `git add internal conf` 显示成 `git padd internal  conf`、
 * `git commit` 显示成 `git coommit`,多出来的字是灰的(zsh-autosuggestions 的提示色),
 * 中文被拉开,退格看着删不掉 —— 命令本身执行是对的。
 *
 * 根因:xterm.js 默认的字宽表是 Unicode 6,把提示符里的 🔥 算成 **1 格**;
 * zsh 用的是系统 wcwidth,算成 **2 格**。提示符差一格之后,凡是 zsh 用「回到行首再右移 N 格」
 * 来定位(一行折行、自动提示跨行、退格重画)的地方,光标都落在实际字符右边一格:
 * 新敲的字画在错的格子里,旧的灰色提示字母留在原地。
 *
 * fixtures/ 里是**真 zsh**(-f 起的、只加载 zsh-autosuggestions + zsh-syntax-highlighting、
 * 提示符 `~/work/proj 🔥❯❯❯ `、40 列 pty)逐键敲出来的原始输出,一个字节没改。
 */
const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'utf8')
const write = (t: Terminal, s: string) => new Promise<void>(r => t.write(s, r))
const screen = (t: Terminal) => {
  const b = t.buffer.active
  const out: string[] = []
  for (let y = 0; y < t.rows; y++) { const l = b.getLine(y)?.translateToString(true) ?? ''; if (l) out.push(l) }
  return out
}
const replay = async (name: string, withFix: boolean) => {
  const t = new Terminal({ cols: 40, rows: 8, allowProposedApi: true })
  if (withFix) applyForgeUnicode(t)
  await write(t, fixture(name))
  const s = screen(t); t.dispose(); return s
}

describe('forgeUnicode widths (must agree with the shell side, i.e. macOS wcwidth)', () => {
  const w = (s: string) => forgeUnicode.wcwidth(s.codePointAt(0)!)
  it('emoji with default emoji presentation are 2 columns', () => {
    for (const e of ['🔥', '😀', '🚀', '✨', '⚡', '✅', '⌚']) expect(w(e), e).toBe(2)
  })
  it('text-presentation symbols stay 1 column (❯ in the prompt, ❤ without VS16)', () => {
    for (const e of ['❯', '❤', '→', '★', 'é']) expect(w(e), e).toBe(1)
  })
  it('CJK / fullwidth are 2, ASCII is 1, controls / combining / ZWJ / VS16 are 0', () => {
    for (const c of ['流', '量', '兑', '换', '한', 'あ', '，', 'Ａ', '\u{20000}']) expect(w(c), c).toBe(2)
    expect(w('a')).toBe(1); expect(w(' ')).toBe(1)
    for (const c of ['\x1b', '\x7f', '\u0301', '\u200d', '\ufe0f']) expect(w(c), JSON.stringify(c)).toBe(0)
  })
  it('the soft hyphen keeps its one column (it is Cf but wcwidth says 1)', () => {
    expect(w('\u00ad')).toBe(1)
  })
  it('applyForgeUnicode registers and activates the provider on a terminal', () => {
    const t = new Terminal({ allowProposedApi: true })
    applyForgeUnicode(t)
    expect(t.unicode.activeVersion).toBe(FORGE_UNICODE_VERSION)
    t.dispose()
  })
})

describe('real zsh + autosuggestions output behind an emoji prompt', () => {
  it('control: on xterm\'s default Unicode 6 table the fixture reproduces the duplicated letter', async () => {
    // 这条证明 fixture 确实踩中了 bug —— 默认字宽下画出来就是用户截图里那种多一个字母。
    expect((await replay('zsh-autosuggest-emoji-prompt-add.40col.txt', false))[0]).toContain('ggit add')
  })
  it('typing `git add internal conf` renders exactly what was typed', async () => {
    expect(await replay('zsh-autosuggest-emoji-prompt-add.40col.txt', true))
      .toEqual(['~/work/proj 🔥❯❯❯ git add internal conf'])
  })
  it('typing the CJK commit message renders exactly what was typed, wrapped where zsh wrapped it', async () => {
    expect(await replay('zsh-autosuggest-emoji-prompt-commit.40col.txt', true))
      // 第一行末尾两个空格:一个是敲的,一个是 zsh 自己补的 —— 「流」是 2 格,放不进第 40 列,
      // zsh 在那一格写一个空格再折行(真终端上也是这样)。差一格时这个补位会落到别处,中文就被「拉开」。
      .toEqual(['~/work/proj 🔥❯❯❯ git commit -m "feat:  ', '流量兑换 to #89043852"'])
  })
})

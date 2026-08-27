/**
 * 把代理正文按 ``` 围栏切成「普通文字」和「代码块」两种块。
 *
 * ★为什么要切:用户要的是**能单独复制其中一段**(原话:复制输出不方便,有些还复制不了)。
 *  整条消息一个复制按钮,拿回去的是一大坨掺着解说的文字 —— 而人真正要粘出去的,
 *  九成是那一条命令、那一段配置。围栏是代理自己标出来的边界,照着切最省事也最准。
 * ★顺带治了一个老毛病:`htmlChunks.ts` 的折叠是按「行首是不是块级标签」判的,
 *  ```html 围栏里的 `<div>` 会被它整段折起来、扣上「手机端不渲染」—— 那明明是一段
 *  **要人读的代码**。所以现在**先切围栏、再在剩下的文字里找 HTML**(见 `MessageBody.tsx`)。
 *
 * ★这个文件刻意**不 import 任何东西**(同 `htmlChunks.ts`):它决定「哪一段被当成代码单独框起来」,
 *  判错就是把一段正常的回答框进等宽小字里,必须有测试钉着,而 `mobile` 那个 vitest project
 *  是 node 环境、加载不了 react-native。
 */
export type CodeChunk = { kind: 'text'; text: string } | { kind: 'code'; text: string; lang: string }

/**
 * 开围栏:最多 3 个前导空格(4 个就是缩进代码块了,不是围栏),3 个以上的 ` 或 ~,
 * 后面跟一串信息串(语言名 + 可能的附加参数)。
 * ★信息串**只取第一个词**当语言:` ```tsx title=a.ts ` 这种带参数的写法很常见,
 *  以前电脑端就因为「只认光秃秃一个词」把它整段漏判过(见 `fix-inline-html-eats-quoted-code`)。
 */
const OPEN = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*(\S*)/

export function splitCodeChunks(src: string): CodeChunk[] {
  const lines = src.split('\n')
  const out: CodeChunk[] = []
  let buf: string[] = []
  const flushText = () => {
    if (buf.length) out.push({ kind: 'text', text: buf.join('\n') })
    buf = []
  }
  for (let i = 0; i < lines.length; i++) {
    const m = OPEN.exec(lines[i])
    // 信息串里带反引号的不是开围栏(``a`` 这种行内代码),否则一行行内代码能把后面全吃进去。
    if (!m || (m[1][0] === '`' && lines[i].slice(lines[i].indexOf(m[1]) + m[1].length).includes('`'))) {
      buf.push(lines[i])
      continue
    }
    const fence = m[1][0]
    const len = m[1].length
    // 闭围栏:同一种符号、**不短于**开围栏,且这一行除了它没有别的东西(CommonMark 就是这么定的)。
    const close = new RegExp(`^[ \\t]{0,3}\\${fence}{${len},}[ \\t]*$`)
    let j = i + 1
    for (; j < lines.length; j++) if (close.test(lines[j])) break
    // ★没闭合就吃到结尾:代理**正在流式吐字**的时候,围栏本来就还没写完 ——
    //  这时候把它当普通文字打印,人会看到一行光秃秃的 ``` 和一堆没版式的代码,
    //  等最后一个字吐完又忽然变样。当代码块处理,中途和最终看到的是同一个东西。
    const body = lines.slice(i + 1, Math.min(j, lines.length)).join('\n')
    flushText()
    // 空围栏(代理常在结尾多吐一对 ```)不留痕:框一个空盒子出来只是噪音。
    if (body.trim() !== '') out.push({ kind: 'code', text: body, lang: m[2] })
    i = j
  }
  flushText()
  // 切块时前后会剩下一堆空 text 块,清掉。
  return out.filter((c) => c.kind === 'code' || c.text.trim() !== '')
}

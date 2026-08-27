/**
 * 输入框里按回车时的「续列表」—— 打完 `1. 买牛奶` 回车,下一行自动是 `2. `;`- ` 接着 `- `;
 * 在一个**空的**列表项上回车则是**结束列表**(把这一行的标记抹掉),不是再来一个空项目符号。
 *
 * ★规则**照抄电脑端** `src/renderer/views/chat/listContinuation.ts`(有序 / 无序 / 复选框三种标记、
 *  缩进原样带过去、空项退出)。两边漂移的表现是「同一段话在电脑上编号连着、在手机上从 1 重新开始」,
 *  所以规则改动必须两边一起改。手机端**不能**直接 import 那份:那是 renderer 层的东西
 *  (`mobile` 只跨到 `src/shared`),而且入口时机也不一样 —— 见下面这条。
 *
 * ★★**和电脑端最大的不同:这里是在换行**已经插进去之后**才跑的。**
 *  电脑端在 `keydown` 里 `preventDefault()`,自己决定要不要插换行;RN 的 `TextInput` 没有这回事
 *  (`onKeyPress` 拦不住软键盘的默认插入,`onSubmitEditing` 在 multiline 上根本不触发)。
 *  所以手机端唯一可靠的入口是 `onChangeText`:比对「上一份正文」和「这一份」,只有当差异
 *  **恰好是插入了一个换行**时才动手。这条限制不是保守,是必需的 ——
 *  语音听写、粘贴、自动纠错都会整段替换正文,拿它们当回车处理就是往人的话里塞编号。
 *
 * ★这个文件刻意**不 import 任何东西**(同 `autoScroll.ts` / `bigEditorReseed.ts` / `gatePeek.ts`):
 *  `mobile` 那个 vitest project 是 node 环境,加载不了 react-native。判据留在组件里 = 一行覆盖都没有,
 *  而它每一次判错都直接改写用户正在打的字。
 */
export type ListEdit = { text: string; caret: number }

// 有序:`1.` / `2)`;复选框(**必须排在无序前面**,它本身就是以一个项目符号开头的):`- [ ]` / `* [x]`;
// 无序:`-` / `*` / `+`。三条都单独捉住缩进,好让嵌套的层级原样带到下一行。
const ORDERED = /^(\s*)(\d+)([.)])(\s+)(.*)$/
const CHECKBOX = /^(\s*)([-*+])\s+\[[ xX]\](\s+)(.*)$/
const UNORDERED = /^(\s*)([-*+])(\s+)(.*)$/

/** 这一行是列表项的话,返回「下一项该带的标记」和「这一项现在的内容」。 */
function nextMarker(line: string): { marker: string; content: string } | null {
  let m = CHECKBOX.exec(line)
  if (m) return { marker: `${m[1]}${m[2]} [ ]${m[3]}`, content: m[4] }
  m = ORDERED.exec(line)
  // 编号 +1。`- [x]` 那种续下去一律是**未勾选**的空盒子:替人把新任务标成已完成是撒谎。
  if (m) return { marker: `${m[1]}${Number(m[2]) + 1}${m[3]}${m[4]}`, content: m[5] }
  m = UNORDERED.exec(line)
  if (m) return { marker: `${m[1]}${m[2]}${m[3]}`, content: m[4] }
  return null
}

/**
 * `prev` → `next` 这一次改动**是不是「只插入了一个换行」**;是的话返回那个换行的下标,否则 null。
 *
 * ★只认这一种改动,别的一概不管(理由见文件头):这是「这一下是回车」在 RN 上唯一站得住的判据。
 * ★验的是「左边一样 + 右边一样 + 中间那个是换行」,三条缺一不可 ——
 *  少了右边那一验,`abc` → `axbc` 这种普通输入也会被当成插入。
 *
 * ★★**为什么非要 `caretBefore` 这个提示不可(它不是锦上添花)**:光看两份字符串,插在
 *  「一串连续换行」里的**哪一个位置**是**分不出来的** —— `a\n2. ` 和 `a\n2. \nb` 上回车,
 *  得到的 `next` 里都有 `\n\n`,而两者要的结果正好相反(前者续列表 / 后者什么都不做)。
 *  所以拿输入框自己报的光标位置(`onSelectionChange`,它给的是**这次改动之前**那个位置)当准。
 * ★提示对不上时(某些平台上 selection 事件比 text 事件晚一拍,拿到的是上一次的)退回
 *  「从左边数第一个不一样的地方」。这个退路可能**少续一次**列表,但绝不会**乱改**正文 ——
 *  猜错方向的代价必须是「没反应」,不能是「把人写的字抹了」。
 */
export function insertedNewlineAt(prev: string, next: string, caretBefore?: number): number | null {
  if (next.length !== prev.length + 1) return null
  const ok = (j: number): boolean =>
    j >= 0 &&
    j < next.length &&
    next[j] === '\n' &&
    next.slice(0, j) === prev.slice(0, j) &&
    next.slice(j + 1) === prev.slice(j)
  if (caretBefore != null && ok(caretBefore)) return caretBefore
  let i = 0
  while (i < prev.length && prev[i] === next[i]) i++
  return ok(i) ? i : null
}

/**
 * 回车之后该把正文改成什么样。null = 这一下和列表无关(普通换行),调用方照常把 `next` 写回去。
 *
 * 返回的 `caret` 是新光标位置 —— **必须**由调用方设回输入框:不设的话光标会掉到正文末尾,
 * 在一段话中间续列表时,接着打的字会跑到最后一行去。
 */
export function continueList(prev: string, next: string, caretBefore?: number): ListEdit | null {
  const at = insertedNewlineAt(prev, next, caretBefore)
  if (at == null) return null

  const lineStart = next.lastIndexOf('\n', at - 1) + 1
  // ★「这一项的内容」要算上**光标后面那一截**:在 `1. |买牛奶` 中间回车时,换行前只有 `1. `,
  //  光看这一半会误判成空项而把整行抹掉 —— 人的字就这么没了。后半截此刻已经被推到下一行,
  //  所以要跨过刚插进去的那个换行再取一段。
  const tailEnd = next.indexOf('\n', at + 1)
  const line = next.slice(lineStart, at) + next.slice(at + 1, tailEnd === -1 ? next.length : tailEnd)

  const m = nextMarker(line)
  if (!m) return null

  // 空项 = 结束列表:把这一行的标记连同刚插进去的换行一起撤掉,光标停在这一行行首。
  // (再按一次回车就是普通换行了 —— 和所有编辑器一个手感。)
  if (m.content.trim() === '') {
    return { text: next.slice(0, lineStart) + next.slice(at + 1), caret: lineStart }
  }
  // 非空项 = 续下去:在刚插进去的那个换行后面补上新标记。
  return { text: next.slice(0, at + 1) + m.marker + next.slice(at + 1), caret: at + 1 + m.marker.length }
}

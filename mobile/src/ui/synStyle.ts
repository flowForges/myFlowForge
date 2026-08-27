import type { Palette } from '../theme/tokens'
import type { TokenClass } from '@shared/highlight'

/**
 * 语法 token 的**类名 → 样式**,全手机端只有这一处。
 *
 * ★为什么单开一个文件:有两个消费方(文件屏的逐行着色 `app/exec.tsx`、对话里的围栏代码块
 *  `MessageBody.tsx`)。各写一份的话,过几周就会变成「同一个 `const` 在文件里是紫的、在回答里是蓝的」
 *  —— 这类漂移没人会报 bug,只会觉得这 app 做得糙。
 *
 * ★映射照抄电脑端 `src/renderer/views/chat/chat.css` 的 `.code-block .t-*`(836–846 行),不是自己配的:
 *  - `tg`(HTML 标签名)复用**关键字**色,`at`(HTML 属性名)复用**键/属性**色 —— 那边就是这么合并的,
 *    11 个类共用 9 个色位;
 *  - `cm`(注释)额外斜体;
 *  - **字重一律不动**。等宽字体里加粗会破坏列对齐,代码块看起来会「抖」。
 *
 * ★这里刻意不 import react-native:返回的是普通对象(RN 的 `TextStyle` 结构子集),
 *  所以这个文件能被仓库根那个 node 环境的 `mobile` vitest project 直接跑。
 */
export type SynStyle = { color: string; fontStyle?: 'italic' }

/** 一个 token 类该用什么样式。`null`(未分类的普通文本)由调用方自己给正文色,不走这里。 */
export function synStyle(cls: TokenClass, c: Palette): SynStyle {
  switch (cls) {
    case 'kw': return { color: c.synKw }
    case 'st': return { color: c.synSt }
    case 'cm': return { color: c.synCm, fontStyle: 'italic' }
    case 'nu': return { color: c.synNu }
    case 'fn': return { color: c.synFn }
    case 'ty': return { color: c.synTy }
    case 'pr': return { color: c.synPr }
    case 'op': return { color: c.synOp }
    // 标签名跟关键字、属性名跟键 —— 和 chat.css 的 `.t-tg { color: var(--syn-kw) }` /
    // `.t-at { color: var(--syn-pr) }` 一致。
    case 'tg': return { color: c.synKw }
    case 'at': return { color: c.synPr }
    case 'va': return { color: c.synVa }
  }
}

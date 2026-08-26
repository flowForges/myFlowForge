import { insertPastePlaceholder, resolvePasteSelection } from '../../../src/shared/chat/largePaste'

/**
 * 「这一坨存成附件之后,输入框里该剩下什么」—— 手机端转附件这件事的**唯一**判据。
 *
 * ★为什么单独一个文件:这条判据保的是「存盘那几百毫秒里人接着打的字一个都不能丢」,
 *  而它原本内联在 `chat.tsx` 里 —— 那是个 `.tsx`,`mobile` 那个 vitest project
 *  (`environment: 'node'`)根本加载不了,于是这条承诺**一行测试都没有**,只能靠真机上
 *  手速够快才碰得到的一次点击去验。第一版就是这么写错的:两个参数读的是同一个闭包变量,
 *  `intact` 恒真,兜底分支永远进不去 —— 代码看着有,跑起来没有。和 `bigEditorReseed.ts`
 *  同一个道理:把「那一条真正要紧的性质」抠出来单测。
 *  这里只 import 纯逻辑的 `@shared/chat/largePaste`(它自己也零 RN 依赖),所以 node 里跑得动。
 *
 * @param latest    **写回那一刻**输入框里真实的正文。必须来自 `setText(latest => …)` 的
 *                  函数式更新 —— 传一个 await 之前读的快照,等于又把这个判据废掉一次。
 * @param atOffload 点「转成附件」那一刻的全文(手机上没有可靠的选区 API,所以整段当选区)。
 * @param name      附件落盘后的文件名。
 */
export function textAfterOffload(latest: string, atOffload: string, name: string): string {
  // 整段当选区:0 .. atOffload.length。前缀还对得上就原位替换,对不上就退到末尾 ——
  // 两个分支各自为什么,见 `resolvePasteSelection` 的注释,别在这儿重新发明一套。
  const sel = resolvePasteSelection(latest, atOffload, 0, atOffload.length)
  return insertPastePlaceholder(latest, sel.start, sel.end, name).text
}

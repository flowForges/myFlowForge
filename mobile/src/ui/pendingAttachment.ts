import { pastePlaceholder } from '../../../src/shared/chat/largePaste'

/**
 * 「这张图还在传」在输入框里长什么样,以及传完/传砸了之后怎么收场。
 *
 * ★★为什么要有这个东西:选图 / 拍照 / 选文件三条路,在拿到图之后都要 `await saveAttachment(...)`
 *  ——那是**好几秒**(走中转 + 代理时更久)。而 `pickBusy` 只禁用 ＋ 面板上的按钮,
 *  那个面板这时候**已经关了** ⇒ 整段等待**零反馈**:屏幕上什么都没变,人以为刚才那下没点上,
 *  过几秒名字才凭空冒出来。用户 2026-08-31 报的就是这个。
 *
 * 做法(用户在 A/B 里选的 B):**立刻**在正文里插一个「正在保存 …」的占位符,传完了原地换成真名字。
 *  比只弹一句「正在保存…」好在:附件在正文里的**位置**从第一秒就定下来了,人可以接着往下打字,
 *  而不用等它落地才知道该在哪一句后面接着说。
 *
 * ★★换回来的时候**只认自己那一段**,而且找不到就原样返回 —— 这几秒里人完全可能已经把
 *  占位符删了、或者在它前面插了一大段字。拿 await 之前的快照整段写回去,就是把他这几秒打的字
 *  全吃掉(`offload` 那条路踩过一次,教训在 `pasteOffload.ts`)。所以这里只做**定点替换**,
 *  不做整段重写,而且删掉了就当他不想要,不替他加回来。
 *
 * ★零 RN 依赖(只 import 纯逻辑的 `@shared/chat/largePaste`),所以 node 那套 vitest 跑得动 ——
 *  这条判据只有在「手速够快」的真机点击里才碰得到,不单测等于没有。
 */

/** 占位符里显示的那行字。★带上文件名:连拍两张时两个占位符必须能分得开。 */
export function pendingLabel(name: string): string {
  return `正在保存 ${name}…`
}

/**
 * 传完(`final` = 落盘后的真名字)或者传砸了 / 取消了(`final` = null)之后,把占位符收掉。
 *
 * ★服务端可能会改名(撞名去重),所以真名字要用它回给我们的那个,不能拿送上去的那个顶。
 * ★找不到自己那段 = 人已经删了它 ⇒ 原样返回,一个字都不动。
 */
export function settlePending(latest: string, pendingName: string, final: string | null): string {
  const token = pastePlaceholder(pendingLabel(pendingName))
  const at = latest.indexOf(token)
  if (at < 0) return latest
  const before = latest.slice(0, at)
  const after = latest.slice(at + token.length)
  if (final !== null) return before + pastePlaceholder(final) + after
  // 失败:连同占位符**自己带进来的**那个空格一起收干净。不收的话正文里会留下一个双空格
  // 或者一个末尾空格,而那不是人打的 —— 他只会觉得输入框莫名其妙脏了。
  if (before.endsWith(' ') && after.startsWith(' ')) return before + after.slice(1)
  if (after === '' && before.endsWith(' ')) return before.slice(0, -1)
  return before + after
}

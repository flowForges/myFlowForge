import { pastedFileNameForFile } from '../../../src/shared/chat/largePaste'
import { MAX_IMAGE_BASE64 } from './pickedImage'

/**
 * 「从文件选择器挑出来这个文件,到底能不能发、发的话叫什么名字」——**唯一**的判据。
 *
 * ★和 `pickedImage.ts` 是**同一套判据的两个入口**:读不出内容 → 拦;超上限 → 拦;
 *  文件名剥成 basename。每一条都是**静默出错**型的,而且文件比图片更容易撞上:
 *  文件选择器给的名字比相册更可能带路径,而服务端是 `join(dir, name)` ——
 *  带一个 `../` 就写到工作区外面去了。
 *
 * ★★撞名去重这一条**没有**直接复用 `planPickedImage` 的做法 —— 见下面 `dedupeName` 的注释,
 *  文件选择器上「同名」比相册常见得多,`pastedFileNameForFile` 单独那一层不够用。
 *
 * ★★★去重靠的是**调用方传进来的「已经用过的名字」**,这个模块自己**不留任何状态**——
 *  之前这里放过一个模块级 `Set`,审查抓到了它是真 bug,不只是「不够纯」:模块级状态活
 *  一整个 JS 进程的生命周期,没人在切会话、没人在发送之后清它,于是在会话 A 挑过的
 *  `log.txt` 会让会话 B 第一次挑同名文件时就被**平白**加上时间戳 —— 跟 A 毫无关系,
 *  纯粹是「这个进程之前发生过什么」在污染现在这次判断,而 `planPickedFile(picked, now)`
 *  的签名看着像纯函数。调用方(`chat.tsx`)本来就天然持有正确的作用域:`attachments`
 *  这个 state 是随会话/随发送清空的,拿它算出「已经用过的名字」传进来,这个模块就真的
 *  是纯的了 —— 同样的输入(含 `takenNames`)永远同样的输出,可以直接单测。
 *
 * ★★上限直接用 `MAX_IMAGE_BASE64`,**不另立一个常数**。那个名字是历史的(它先给图片用),
 *  但它管的其实是**一条 WebSocket 帧能塞多少**,跟内容是不是图片毫无关系。
 *  另立一个的话,迟早出现「同样大的东西,当图片发得出去、当文件发不出去」。
 *
 * ★用户拍板:**什么文件都放**,只拦大小。代理读不懂 PDF/zip 就让它自己说 ——
 *  按扩展名去猜「代理能不能读」只会拦掉一堆本来能用的东西(`.conf`、无后缀的 `Dockerfile`…)。
 *
 * ★零 RN 依赖,只 import 纯逻辑的 `@shared/chat/largePaste`,所以 node 里跑得动。
 */

/** 文件选择器给的东西里,我们真正用到的那两样(故意不 import 它的类型:那是原生包)。 */
export type PickedFile = { name?: string | null; dataBase64?: string | null }

export type FilePlan =
  | { ok: true; name: string; dataBase64: string }
  /** 不能发。`why` 是**直接给人看的一句话**,必须说清为什么以及接下来能干什么。 */
  | { ok: false; why: string }

/** 只留文件名本身。★服务端是 `join(dir, name)` —— 带一个 `../` 就写到工作区外面去了。 */
const baseName = (name: string): string => name.split(/[/\\]/).pop() ?? ''

const pad = (n: number): string => String(n).padStart(2, '0')

/**
 * 和 `pastedFileNameForFile` 的结果撞了(它只改 `image`/`screenshot`/… 这几个通用兜底名,
 * 真实文件名 `log.txt` 一律原样放行)就加一段时间戳;`taken` 里已经有的名字**不由这个函数
 * 记住** —— 记不记得住是调用方的事,这里只回答「给定这一份已用名单,这个名字该叫什么」。
 */
function dedupeName(name: string, now: Date, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name
  const dot = name.lastIndexOf('.')
  const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
  const stamp = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  let candidate = `${base}-${stamp}${ext}`
  let n = 2
  // 极小概率同一秒内又撞了(比如两次都是 61 秒边界内的批量选取),继续加序号兜底。
  while (taken.has(candidate)) {
    candidate = `${base}-${stamp}-${n}${ext}`
    n += 1
  }
  return candidate
}

/**
 * @param takenNames 这次会话里**已经**发出去的附件名(调用方传 —— 一般是当前 `attachments`
 *  列表的 `.name` 集合)。不传就当作还没发过任何文件,和「刚打开一个新会话」是一回事。
 */
export function planPickedFile(picked: PickedFile, now: Date, takenNames: ReadonlySet<string> = new Set()): FilePlan {
  const dataBase64 = picked.dataBase64 ?? ''
  // 拿不到字节的情况真实存在:iCloud Drive 里没下下来的文件、或者一个读不出来的 provider。
  // 不拦的话就是存进去一个 0 字节的附件,chip 照常显示,代理打开是空的。
  if (!dataBase64) {
    return { ok: false, why: '这个文件没读出内容(iCloud 里还没下载下来?),换一个或者先在「文件」里下载好。' }
  }
  if (dataBase64.length > MAX_IMAGE_BASE64) {
    const mb = (dataBase64.length * 0.75) / 1e6
    return {
      ok: false,
      why: `这个文件约 ${mb.toFixed(1)}MB,一条消息塞不下(上限 ${((MAX_IMAGE_BASE64 * 0.75) / 1e6).toFixed(0)}MB)。挑一个小点的,或者让代理自己去工作区里读。`,
    }
  }
  const raw = baseName(picked.name ?? '') || 'file'
  return { ok: true, name: dedupeName(pastedFileNameForFile(raw, now), now, takenNames), dataBase64 }
}

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
 * ★这一次 app 会话里已经发出去过的文件名。
 *
 * ★★和图片不一样:`pastedFileNameForFile` 只改**通用兜底名**(`image`/`screenshot`/…),
 *  真实文件名(`log.txt`)一律原样放行 —— 这对图片是对的(相册重名极少见,`IMG_0421.HEIC`
 *  这种自带序号),但文件选择器上「连续导出两次同名日志」是家常便饭。不去重的话:
 *  两个附件都叫 `log.txt`,`saveAttachment` 按名字落盘,第二个直接**覆盖**第一个;
 *  就算没覆盖,正文里两个占位符一模一样,代理分不清哪句话说的是哪个文件。
 *  所以在 `pastedFileNameForFile` 之上再加一层会话级去重,不动 `largePaste.ts` 本身
 *  (那样会连带改了图片的行为,而「人自己命名的名字必须原样保留」是图片那边已经钉住的判据)。
 */
const seenNames = new Set<string>()

function dedupeName(name: string, now: Date): string {
  if (!seenNames.has(name)) {
    seenNames.add(name)
    return name
  }
  const dot = name.lastIndexOf('.')
  const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
  const stamp = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  let candidate = `${base}-${stamp}${ext}`
  let n = 2
  // 极小概率同一秒内又撞了(比如两次都是 61 秒边界内的批量选取),继续加序号兜底。
  while (seenNames.has(candidate)) {
    candidate = `${base}-${stamp}-${n}${ext}`
    n += 1
  }
  seenNames.add(candidate)
  return candidate
}

export function planPickedFile(picked: PickedFile, now: Date): FilePlan {
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
  return { ok: true, name: dedupeName(pastedFileNameForFile(raw, now), now), dataBase64 }
}

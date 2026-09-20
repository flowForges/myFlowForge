import { pastedFileNameForFile } from '../../../src/shared/chat/largePaste'

/**
 * 「相册里挑出来这张图,到底能不能发,发的话叫什么名字」—— 发图这件事的**唯一**判据。
 *
 * ★为什么单独一个文件:这几条判据全都长在 `chat.tsx` 里的话,一行测试都写不了
 *  (`mobile` 那个 vitest project 是 `environment: 'node'`,加载不了 `.tsx`,更加载不了
 *  `expo-image-picker` 这个原生模块)。而它们每一条都是**静默出错**型的:
 *  重名不改 → 三个一模一样的 chip;不拦大小 → 一条 WebSocket 帧里塞一张四千万像素的原图;
 *  不取 basename → 文件名里带 `../` 能写到工作区外面去。全是「看代码看不出来、真机上才发作」。
 *  和 `pasteOffload.ts` / `bigEditorReseed.ts` 同一个做法:把要紧的那条性质抠出来单测。
 *
 *  这里零 RN / 零 expo 依赖,只 import 纯逻辑的 `@shared/chat/largePaste`,所以 node 里跑得动。
 */

/**
 * base64 字符数上限。base64 比原字节大 4/3,所以 8,000,000 个字符 ≈ 6MB 原图。
 *
 * ★为什么要有这条线:`quality: 0.8` + **不改尺寸**是有意的(代理要看的是截图上的字,压糊了等于白传),
 *  代价就是原图多大发多大 —— 一张现代手机的照片轻松 10MB 以上,整坨进一条 WebSocket 消息,
 *  链路会卡住好几秒甚至直接断。宁可当场说清楚让人换一张,也不要发到一半没了。
 */
export const MAX_IMAGE_BASE64 = 8_000_000

/** `ImagePicker.ImagePickerAsset` 里我们真正用到的那两个字段(故意不 import 它的类型:那是原生包)。 */
export type PickedAsset = { fileName?: string | null; base64?: string | null }

export type ImagePlan =
  | { ok: true; name: string; dataBase64: string }
  /** 不能发。`why` 是**直接给人看的一句话**,必须说清为什么以及接下来能干什么。 */
  | { ok: false; why: string }

/** 只留文件名本身。相册给的名字理论上不带目录,但服务端是 `join(dir, name)` —— 带一个 `../` 就写到工作区外面去了。 */
const baseName = (name: string): string => name.split(/[/\\]/).pop() ?? ''

export function planPickedImage(asset: PickedAsset, now: Date): ImagePlan {
  const dataBase64 = asset.base64 ?? ''
  // 拿不到字节的情况真实存在:iCloud 里没下下来的原图、或者选到一张读不出来的资源。
  // 不拦的话就是存进去一个 0 字节的附件,chip 照常显示,agent 打开是空的。
  if (!dataBase64) return { ok: false, why: '这张图没读出内容(iCloud 里还没下载下来?),换一张试试。' }
  if (dataBase64.length > MAX_IMAGE_BASE64) {
    const mb = (dataBase64.length * 0.75) / 1e6
    return {
      ok: false,
      why: `这张图约 ${mb.toFixed(1)}MB,一条消息塞不下(上限 ${((MAX_IMAGE_BASE64 * 0.75) / 1e6).toFixed(0)}MB)。截一张图、或者在相册里裁一下再发。`,
    }
  }
  // ★`pastedFileNameForFile` 必须用上:相册里的图**极其**常见地叫 `image.png`,连选三张就是
  //  三个一样的 chip 和三个一样的 `[image.png]` 占位符 —— 等于没占位,agent 分不清哪句话说哪张图。
  //  而人自己命名过的(`IMG_0421.HEIC`、`设计稿.png`)比我们生成的时间戳有信息量,原样留着。
  return { ok: true, name: pastedFileNameForFile(baseName(asset.fileName ?? 'image.png') || 'image.png', now), dataBase64 }
}

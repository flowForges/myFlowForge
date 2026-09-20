import { useMemo } from 'react'
import qrcode from 'qrcode-generator'

/**
 * 一枚二维码,画成 SVG。
 *
 * ★**永远是深底浅底固定的那一套(白底黑块),不跟皮肤走。**
 *  这一屏别的地方都只准输出 `var(--token)`,这里是唯一的例外,而且是故意的:
 *  二维码要被**另一台设备的摄像头**读,不是给人看的。反相码有些扫码器认、有些不认,
 *  深色皮肤下如果跟着 --fg/--bg 走,结果就是「在浅色主题下能扫、换个皮肤就扫不出来」——
 *  那种偶发失败根本不会有人往皮肤上想。
 *
 * ★四格静区(quiet zone)是规范要求的,不是留白好看。贴边的码在很多相机上直接识别不了。
 */
export function QrCode({ text, size = 192, alt }: { text: string; size?: number; alt?: string }) {
  const { d, span } = useMemo(() => {
    // 0 = 自动挑最小的版本;'M' 档纠错(15%),屏幕上看的码不需要更高。
    const qr = qrcode(0, 'M')
    qr.addData(text)
    qr.make()
    const n = qr.getModuleCount()
    const quiet = 4
    // 每个黑块一条 `M x y h1 v1 h-1 z`,全部塞进**一个** path —— 上千个 <rect> 会让
    // 换个字符就重排一次整棵子树。
    let path = ''
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (qr.isDark(r, c)) path += `M${c + quiet} ${r + quiet}h1v1h-1z`
      }
    }
    return { d: path, span: n + quiet * 2 }
  }, [text])

  return (
    <svg
      className="qr"
      width={size}
      height={size}
      viewBox={`0 0 ${span} ${span}`}
      role="img"
      aria-label={alt ?? '二维码'}
      shapeRendering="crispEdges"
    >
      <rect width={span} height={span} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  )
}

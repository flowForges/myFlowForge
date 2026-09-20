import qrcode from 'qrcode-generator'

/**
 * 把一枚二维码画进**终端**。Linux 服务器上唯一的配对入口 ——
 * 那台机器没有屏幕、没有设置界面,只有一条 ssh。
 *
 * ★★**必须显式上色,不能靠终端的默认前景色**。二维码是给另一台设备的摄像头读的:
 *  不上色的 `█` 在深色终端里是浅块、在浅色终端里是深块,等于码的黑白随主题翻转。
 *  反相码有些扫码器认、有些不认,那种偶发失败没人会往「终端配色」上想。
 *  (`QrCode.tsx` 顶上为同一件事写过同一段话 —— 那边是皮肤,这边是终端主题。)
 *
 * ★一行画**两排模块**(上半块 `▀`:前景色=上面那排,背景色=下面那排)。
 *  一个模块占一个字符格的话,码是扁的(字符格高约是宽的两倍),很多相机认不出来;
 *  横向占两格又会让 60 多模块的码宽到 120 列,ssh 窗口里直接折行 —— 折行的码作废。
 *
 * ★四格静区是规范要求的,不是留白好看。贴边的码在很多相机上根本识别不了。
 */

const ESC = '\u001b'
const QUIET = 4
/** 深块 / 浅块的 ANSI 色号(前景 30/37,背景 40/47)—— 只用最基础的 8 色,别指望 256 色。 */
const FG = { dark: `${ESC}[30m`, light: `${ESC}[37m` }
const BG = { dark: `${ESC}[40m`, light: `${ESC}[47m` }
const RESET = `${ESC}[0m`

/**
 * 画出来的每一行(不含换行符)。★纠错档用 'M'(15%):
 * 屏幕上那枚也是 M,而更高的档会让模块数变多、码更宽,ssh 窗口里更容易折行。
 */
export function qrTerminalLines(text: string): string[] {
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()
  const n = qr.getModuleCount()
  const span = n + QUIET * 2
  /** 含静区的坐标系里,这个格子是不是深块。静区一律浅块。 */
  const dark = (r: number, c: number): boolean => {
    const rr = r - QUIET
    const cc = c - QUIET
    if (rr < 0 || cc < 0 || rr >= n || cc >= n) return false
    return qr.isDark(rr, cc)
  }

  const lines: string[] = []
  for (let r = 0; r < span; r += 2) {
    let line = ''
    let cur = ''
    for (let c = 0; c < span; c++) {
      const top = dark(r, c)
      // ★奇数行数时最后一行的"下半"落在码外面 —— 那属于静区,必须是浅块。
      //  当成深块的话码底下会多出一条黑边,静区就废了。
      const bottom = r + 1 < span ? dark(r + 1, c) : false
      const style = (top ? FG.dark : FG.light) + (bottom ? BG.dark : BG.light)
      if (style !== cur) { line += style; cur = style }
      line += '▀'
    }
    lines.push(line + RESET)
  }
  return lines
}

/** 终端画不了码时(输出被重定向、没有 TTY)也要有路可走 —— 那时只印配对码本身。 */
export const canDrawQr = (stream: { isTTY?: boolean } = process.stdout): boolean => !!stream.isTTY

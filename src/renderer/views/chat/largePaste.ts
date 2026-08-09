// Large-paste offloading for the composer. Pasting a very large blob (e.g. a 500KB JSON) into the
// controlled <textarea value={text}> makes every subsequent keystroke re-render + reflow the giant
// value, so typing visibly lags behind the IME. Instead, when a paste is huge we write it to a temp
// file (reusing the existing savePaste attachment pipeline) and show it as an attachment chip — the
// textarea stays tiny, the chip is one-click removable, and the agent reads the file via the 附件 path.

// 阈值。原本是 10k(「reflow 开始卡」的那条线),但真机上一大坨粘进来不转文件、直接堆在输入框里的
// 观感很差 —— 卡不卡只是其中一个理由,「输入框还看得清吗」才是日常真正在意的。2000 字 ≈ 一个中等函数 /
// 一段 stack trace / 半页 markdown:这以下随手粘进来还能看能改,这以上就该收成附件。
export const PASTE_OFFLOAD_THRESHOLD = 2_000

export function shouldOffloadPaste(text: string): boolean {
  return text.length >= PASTE_OFFLOAD_THRESHOLD
}

// 转成附件后,在粘贴处留下的占位引用。
// 为什么必须留:不留的话,连粘三坨就得到三个孤立附件,而正文里没有任何位置标记 —— agent 看到的是
// 「一句话 + 三个文件」,分不清「这个报错」「那份配置」各指哪一个。占位符把位置钉回正文里。
export function pastePlaceholder(name: string): string {
  return `[${name}]`
}

// 把占位符插进选区处(选中再粘 = 替换掉选中的那段,与原生粘贴行为一致)。
// 两侧按需补一个空格:紧贴着前后文字会读成一个词,而已经有空白就别再加。
// 返回新文本与插入后的光标位置(受控 textarea 重渲染会把光标弹到末尾,调用方要自己还原)。
export function insertPastePlaceholder(
  text: string, selStart: number, selEnd: number, name: string,
): { text: string; caret: number } {
  const before = text.slice(0, selStart)
  const after = text.slice(selEnd)
  const lead = before && !/\s$/.test(before) ? ' ' : ''
  const trail = after && !/^\s/.test(after) ? ' ' : ''
  const chunk = lead + pastePlaceholder(name) + trail
  return { text: before + chunk + after, caret: selStart + chunk.length }
}

/**
 * 存盘是异步的:选区(selStart/selEnd)和当时的正文都是在 `await onPaste(...)` 之前读的,而那几百
 * 毫秒里用户还能继续打字。所以插入之前要拿「最新的正文」重新判定一次选区还成不成立。
 *
 * 判据:latest 的前 selEnd 个字符与粘贴那一刻完全一致(前缀 + 被选中的那段都没变)。
 *  - 成立 → 说明用户是在插入点【之后】改的字(最常见:光标本来就在末尾,他接着往下敲),
 *    原位插入依然准确;
 *  - 不成立 → 用户在前面插/删过字,原来的下标已经指向别的位置了。此时插到【末尾】而不是硬按
 *    旧下标插:硬插会把占位符戳进某个词/某行的中间,读起来是错的,而且是静默的错;插到末尾
 *    位置虽然不理想,但语义清楚(「还有这么一个附件」),而且绝不丢用户的字。
 */
export function resolvePasteSelection(
  latest: string, atPaste: string, selStart: number, selEnd: number,
): { start: number; end: number } {
  const intact = selEnd <= latest.length && latest.slice(0, selEnd) === atPaste.slice(0, selEnd)
  return intact ? { start: selStart, end: selEnd } : { start: latest.length, end: latest.length }
}

/**
 * 转文件失败时的兜底:把粘贴的原文按原生粘贴的语义插回选区(替换掉选中的那段)。
 * 不加空格、不加括号 —— 这条路要还原的就是「用户本来会得到什么」。
 */
export function insertPastedText(
  text: string, selStart: number, selEnd: number, raw: string,
): { text: string; caret: number } {
  return { text: text.slice(0, selStart) + raw + text.slice(selEnd), caret: selStart + raw.length }
}

const pad = (n: number) => String(n).padStart(2, '0')

// Name the temp file. Detect JSON (opening/closing bracket) for a .json extension so the agent + the
// chip read naturally; everything else is .txt. Timestamped to avoid collisions within a workspace.
export function pastedFileName(text: string, now: Date): string {
  const t = text.trim()
  const looksJson = /^[[{]/.test(t) && /[}\]]$/.test(t)
  const ext = looksJson ? 'json' : 'txt'
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `pasted-${stamp}.${ext}`
}

// 剪贴板里的截图没有真名字 —— Chrome 一律给 `image.png`,所以连粘三张就是三个一模一样的 chip,正文里
// 的 `[image.png]` 占位符也全一样,等于没占位。这类通用名改成 `img-时分秒.扩展名`,三张图立刻能分辨。
//
// 反过来,从访达复制一个真文件粘进来时 `hook.jpg` 是用户自己起的名字,比我们生成的时间戳有信息量得多,
// 必须原样保留。所以只认这一小撮「浏览器兜底名」,其余一律不动。
const GENERIC_PASTE_NAMES = new Set(['image', 'screenshot', '屏幕截图', 'untitled', 'unnamed', ''])

export function pastedFileNameForFile(name: string, now: Date): string {
  const dot = name.lastIndexOf('.')
  const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
  if (!GENERIC_PASTE_NAMES.has(base.toLowerCase())) return name
  const stamp = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  // 无扩展名的 blob 落成 .png:剪贴板图片实际就是 PNG,给个扩展名后续按图片预览才认得出来。
  return `img-${stamp}${ext || '.png'}`
}

// Base64-encode UTF-8 text for the savePaste IPC (which base64-decodes to bytes). btoa alone breaks on
// non-Latin1 (CJK), so encode to UTF-8 bytes first. Chunked to avoid a huge apply() arg spread.
export function base64OfUtf8(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

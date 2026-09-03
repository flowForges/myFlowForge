import type { ChatMessage, ToolActivity } from '@shared/types'

/**
 * 把历史里 `tools[].output` 截到调用方**画得下**的那么多,并如实带上原始行数。
 *
 * ★★为什么非做不可(2026-09-03 实测):手机走中转打开一个长会话要十秒。剖了六个真会话文件,
 *  结论一致得刺眼 —— **99% 的字节是 `tools[].output`**,也就是 shell 命令的 stdout 和读文件的
 *  回显。最大那个:7 条消息 3.0 MB,其中 tools 3.0 MB、正文 37 KB。而这些字节走的是
 *  「JSON → 端到端加密 → base64(+33%) → 中转 → 手机上再 JSON.parse 三兆」这条路。
 *
 * ★★而**手机压根显示不了那么多**:`toolParse.ts` 的 `BODY_LINE_CAP` 是 200 行,展开一个工具卡
 *  最多画 200 行,后面的本来就写着「还有 N 行没显示」。所以那三兆里绝大部分是**下载下来
 *  只为了立刻丢掉**的。这个函数把「截断」从客户端挪到服务端 —— 屏幕上看到的东西一个字不变。
 *
 * ★实测(200 行 / 16 KB):3.0MB→388KB、2.3MB→169KB、2.2MB→239KB —— **6~14 倍**。
 *  这些会话里工具输出的行数中位数只有 76,九成在 221 行以内,所以绝大多数根本没被碰到。
 *
 * ★★`outputLines` 带的是**原始**行数,不是截断后的。少了它,工具卡会理直气壮地说
 *  「共 200 行」而真相是 5291 行 —— 那是这套渲染里最不能犯的错(静默截断 = 让人以为
 *  自己看到了全部)。`ToolCard` 那句「还有 N 行没显示」照旧,数字仍然是真的。
 *
 * ★两道闸**都要**:按行数截挡的是几千行的日志,按字节截挡的是「一行五万字」那种
 *  (minified JS、base64、单行 JSON)—— 只按行数的话那种一行就能把整份历史撑回去。
 */
export type ToolOutputCap = {
  /** 最多留几行。调用方按自己画得下的行数给(手机端 = BODY_LINE_CAP)。 */
  lines: number
  /** 最多留多少字节。防「一行特别长」。 */
  bytes: number
}

/** 单个工具输出的截断。没超就**原样返回同一个对象**(不复制,让上层的引用相等仍然成立)。 */
export function capToolOutput(t: ToolActivity, cap: ToolOutputCap): ToolActivity {
  const out = t.output
  if (!out) return t
  const all = out.split('\n')
  let kept = all.length > cap.lines ? all.slice(0, cap.lines).join('\n') : out
  if (Buffer.byteLength(kept, 'utf8') > cap.bytes) {
    // ★按字节切会切在 UTF-8 字符中间。`toString('utf8')` 会把那半个字变成 U+FFFD,
    //  所以切完再把末尾那个坏字符去掉 —— 屏幕上多一个「�」比少一行更像 bug。
    kept = Buffer.from(kept, 'utf8').subarray(0, cap.bytes).toString('utf8').replace(/�+$/, '')
  }
  if (kept === out) return t
  return { ...t, output: kept, outputLines: all.length }
}

/**
 * 一整份历史。★**不改原数组也不改原对象** —— `history()` 读的是磁盘上那份的解析结果,
 * 但同一份数据可能被 `mergeLive` 之类的地方共用,就地改会把别人的数据也截了。
 */
export function capToolOutputs(msgs: ChatMessage[], cap: ToolOutputCap): ChatMessage[] {
  return msgs.map((m) => {
    if (!m.tools?.length) return m
    const tools = m.tools.map((t) => capToolOutput(t, cap))
    // 一条都没截就把原消息还回去,省掉一次浅拷贝(长会话里绝大多数消息都走这条)。
    return tools.some((t, i) => t !== m.tools![i]) ? { ...m, tools } : m
  })
}

/** 调用方给的上限:没给、或者给了不合法的数,就当没要求截断。 */
export function readCap(a: { toolOutputLines?: number; toolOutputBytes?: number }): ToolOutputCap | null {
  const lines = a.toolOutputLines
  if (typeof lines !== 'number' || !Number.isFinite(lines) || lines < 1) return null
  const bytes = typeof a.toolOutputBytes === 'number' && Number.isFinite(a.toolOutputBytes) && a.toolOutputBytes >= 1
    ? a.toolOutputBytes
    : 64 * 1024
  return { lines: Math.floor(lines), bytes: Math.floor(bytes) }
}

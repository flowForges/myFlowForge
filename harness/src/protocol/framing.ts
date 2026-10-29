// 一行一条 JSON 消息,只按 \n 分帧(不用 readline,它会把 U+2028/2029 当换行)
export function encodeFrame(msg: object): string {
  const json = JSON.stringify(msg)
  if (json.includes('\n')) throw new Error('frame contains raw newline')
  return json + '\n'
}

export const MAX_FRAME_BYTES = 16 * 1024 * 1024

export class FrameOverflowError extends Error {
  constructor() {
    super(`frame exceeds ${MAX_FRAME_BYTES} bytes`)
    this.name = 'FrameOverflowError'
  }
}

export class FrameDecoder {
  // 未完成的行按块暂存,收到换行才拼接,避免长行反复拼接 O(n^2)
  private parts: string[] = []
  private len = 0

  constructor(private readonly onError?: (line: string, err: unknown) => void) {}

  push(chunk: string): object[] {
    const out: object[] = []
    if (!chunk.includes('\n')) {
      this.parts.push(chunk)
      this.len += chunk.length
      this.checkCap()
      return out
    }
    let buf = this.parts.join('') + chunk
    this.parts = []
    this.len = 0
    let idx: number
    while ((idx = buf.indexOf('\n')) !== -1) {
      let line = buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (line.trim() === '') continue
      try {
        const v = JSON.parse(line)
        if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('frame is not an object')
        out.push(v)
      } catch (err) {
        this.onError?.(line, err)
      }
    }
    if (buf) {
      this.parts.push(buf)
      this.len = buf.length
      this.checkCap()
    }
    return out
  }

  // 缓冲区封顶:一直不出现换行的流不能无限吃内存
  private checkCap(): void {
    if (this.len > MAX_FRAME_BYTES) {
      this.parts = []
      this.len = 0
      this.onError?.('', new FrameOverflowError())
    }
  }
}

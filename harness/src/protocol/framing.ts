// 一行一条 JSON 消息,只按 \n 分帧(不用 readline,它会把 U+2028/2029 当换行)
export function encodeFrame(msg: object): string {
  const json = JSON.stringify(msg)
  if (json.includes('\n')) throw new Error('frame contains raw newline')
  return json + '\n'
}

export class FrameDecoder {
  private buf = ''

  constructor(private readonly onError?: (line: string, err: unknown) => void) {}

  push(chunk: string): object[] {
    this.buf += chunk
    const out: object[] = []
    let idx: number
    while ((idx = this.buf.indexOf('\n')) !== -1) {
      let line = this.buf.slice(0, idx)
      this.buf = this.buf.slice(idx + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (line.trim() === '') continue
      try {
        const v = JSON.parse(line)
        if (v === null || typeof v !== 'object') throw new Error('frame is not an object')
        out.push(v)
      } catch (err) {
        this.onError?.(line, err)
      }
    }
    return out
  }
}

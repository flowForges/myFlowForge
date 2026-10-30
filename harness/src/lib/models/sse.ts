// Server-Sent Events 解析:按 WHATWG 规则分帧;整条流只用一个流式 TextDecoder,
// 跨块的多字节字符只解码一次

export interface SSEEvent {
  event?: string
  data: string
}

export async function* parseSSE(stream: ReadableStream<Uint8Array>): AsyncIterable<SSEEvent> {
  const reader = stream.getReader()
  const decoder = new TextDecoder('utf-8')
  let buf = ''
  let data: string[] = []
  let event: string | undefined
  let finished = false

  // 处理一行;空行 = 帧结束,返回要派发的事件
  const line = (l: string): SSEEvent | undefined => {
    if (l === '') {
      const out = data.length ? { ...(event !== undefined && { event }), data: data.join('\n') } : undefined
      data = []
      event = undefined
      return out
    }
    if (l.startsWith(':')) return undefined // 注释 / 心跳
    const i = l.indexOf(':')
    const field = i === -1 ? l : l.slice(0, i)
    let value = i === -1 ? '' : l.slice(i + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') data.push(value)
    else if (field === 'event') event = value
    // id / retry / 其他字段忽略
    return undefined
  }

  // 取出 buf 里的完整行;末尾单独的 \r 要等下一块才知道是不是 \r\n
  function* drain(eof: boolean): Generator<SSEEvent> {
    let start = 0
    for (let i = 0; i < buf.length; i++) {
      const c = buf.charCodeAt(i)
      if (c !== 10 && c !== 13) continue
      if (c === 13 && i === buf.length - 1 && !eof) break
      const e = line(buf.slice(start, i))
      if (e) yield e
      if (c === 13 && buf.charCodeAt(i + 1) === 10) i++
      start = i + 1
    }
    buf = buf.slice(start)
  }

  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      yield* drain(false)
    }
    finished = true
    buf += decoder.decode()
    yield* drain(true)
    // 流结束:已完整收到的行组成的帧照常派发;没有换行的半截行丢弃
    const tail = line('')
    if (tail) yield tail
  } finally {
    if (!finished) await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

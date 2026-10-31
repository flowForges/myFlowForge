import { createServer, type Server, type Socket } from 'node:net'

// 代理测试用的"互联网":都只听 127.0.0.1:0。
//   startFakeUpstream():上游 HTTP 代理,记下每个 CONNECT 的请求行与请求头,回 200(或指定状态),之后当源站用
//   startFakeOrigin():源站。收到 HTTP 请求就记下并回 `ok <path>`;收到别的字节原样回显

export interface SeenRequest { line: string; headers: Record<string, string> }

export interface FakeServer {
  port: number
  /** 上游:CONNECT 请求;源站:为空 */
  connects: SeenRequest[]
  /** 隧道里(或源站上)收到的 HTTP 请求 */
  inner: SeenRequest[]
  close: () => Promise<void>
}

const HTTP_START = /^(GET|HEAD|POST|PUT|DELETE|OPTIONS|PATCH) /

function parseHead(head: string): SeenRequest {
  const [line, ...rest] = head.split('\r\n')
  const headers: Record<string, string> = {}
  for (const h of rest) {
    const i = h.indexOf(':')
    if (i > 0) headers[h.slice(0, i).trim().toLowerCase()] = h.slice(i + 1).trim()
  }
  return { line, headers }
}

/** 读到空行为止;返回头与剩下的字节。对端先关 → undefined */
function readHead(sock: Socket, first: Buffer = Buffer.alloc(0)): Promise<{ head: string; rest: Buffer } | undefined> {
  return new Promise((resolve) => {
    let buf = first
    const check = () => {
      const i = buf.indexOf('\r\n\r\n')
      if (i < 0) return false
      sock.off('data', onData)
      sock.off('close', onClose)
      resolve({ head: buf.subarray(0, i).toString('latin1'), rest: buf.subarray(i + 4) })
      return true
    }
    const onData = (c: Buffer) => {
      buf = Buffer.concat([buf, c])
      check()
    }
    const onClose = () => resolve(undefined)
    if (check()) return
    sock.on('data', onData)
    sock.on('close', onClose)
  })
}

/** 源站行为:第一个字节块像 HTTP 请求就回 HTTP,否则回显 */
function serveOrigin(sock: Socket, inner: SeenRequest[], first: Buffer) {
  const start = (chunk: Buffer) => {
    if (HTTP_START.test(chunk.toString('latin1'))) {
      void readHead(sock, chunk).then((r) => {
        if (!r) return
        const req = parseHead(r.head)
        inner.push(req)
        const body = `ok ${req.line.split(' ')[1]}`
        sock.end(`HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: ${body.length}\r\nX-Origin: fake\r\nConnection: close\r\n\r\n${body}`)
      })
      return
    }
    sock.write(chunk)
    sock.on('data', c => sock.write(c))
  }
  if (first.length > 0) start(first)
  else sock.once('data', start)
}

function listen(onConn: (s: Socket) => void, extra: Pick<FakeServer, 'connects' | 'inner'>): Promise<FakeServer> {
  const sockets = new Set<Socket>()
  const server: Server = createServer((s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
    s.on('error', () => {})
    onConn(s)
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') return reject(new Error('no address'))
      resolve({
        port: addr.port,
        ...extra,
        close: () => new Promise<void>((done) => {
          for (const s of sockets) s.destroy()
          server.close(() => done())
        }),
      })
    })
  })
}

export function startFakeUpstream(o: { status?: number } = {}): Promise<FakeServer> {
  const connects: SeenRequest[] = []
  const inner: SeenRequest[] = []
  return listen((sock) => {
    void readHead(sock).then((r) => {
      if (!r) return
      const req = parseHead(r.head)
      connects.push(req)
      if (!req.line.startsWith('CONNECT ')) return void sock.end('HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\n\r\n')
      const status = o.status ?? 200
      if (status !== 200) return void sock.end(`HTTP/1.1 ${status} Nope\r\nContent-Length: 0\r\n\r\n`)
      sock.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      serveOrigin(sock, inner, r.rest)
    })
  }, { connects, inner })
}

export function startFakeOrigin(): Promise<FakeServer> {
  const inner: SeenRequest[] = []
  return listen(sock => serveOrigin(sock, inner, Buffer.alloc(0)), { connects: [], inner })
}

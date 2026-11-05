// MCP 服务的按行传输。服务发来的每个字节都是敌意输入:单行有字节上限,超了立刻放弃整条流;
// 坏行(非 UTF-8、非 JSON、不是对象)丢掉;stderr 只进 64 KB 环形缓冲,不转发给任何人。
import type { Readable, Writable } from 'node:stream'

export const STDERR_KEEP = 64 * 1024
export const MAX_LINE = 4 * 1024 * 1024
/** 排队待写的字节上限是 maxLine 的几倍:服务不读 stdin 时,排队不能无限涨 */
const STDIN_QUEUE_FACTOR = 4

export type CloseWhy = 'exit' | 'overflow'

export interface LineStreams {
  stdin: Writable
  stdout: Readable
  stderr: Readable
}

export class LineTransport {
  private readonly decoder = new TextDecoder('utf-8')
  /** 未完成的行攒在一块按倍数增长的缓冲里:逐字节写入也只占 maxLine 加一块 chunk,不是一个 Buffer 一个字节 */
  private acc: Buffer = Buffer.alloc(0)
  private held = 0
  private dead = false
  private err: Buffer = Buffer.alloc(0)
  private readonly messageCbs: ((m: Record<string, unknown>, bytes: number) => void)[] = []
  private readonly junkCbs: ((bytes: number) => void)[] = []
  private readonly closeCbs: ((why: CloseWhy) => void)[] = []

  constructor(
    private readonly child: LineStreams,
    private readonly o: { maxLine: number },
  ) {
    const quiet = () => {}
    child.stdin.on('error', quiet)
    child.stdout.on('error', () => this.finish('exit'))
    child.stderr.on('error', quiet)
    child.stdout.on('data', (d: Buffer | string) => this.onData(typeof d === 'string' ? Buffer.from(d) : d))
    child.stdout.on('end', () => this.finish('exit'))
    child.stdout.on('close', () => this.finish('exit'))
    child.stderr.on('data', (d: Buffer | string) => {
      const b = typeof d === 'string' ? Buffer.from(d) : d
      const all = Buffer.concat([this.err, b])
      this.err = all.length > STDERR_KEEP ? all.subarray(all.length - STDERR_KEEP) : all
    })
  }

  /** stdin 排着队等服务来读:调用方可以据此不发可有可无的回复 */
  get congested(): boolean {
    return !this.dead && this.child.stdin.writableNeedDrain
  }

  send(obj: unknown): void {
    if (this.dead) return
    try {
      // U+2028/2029 在 JSON 里合法,但有些按行的读端把它们当换行:转义掉
      const line = JSON.stringify(obj).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
      this.child.stdin.write(`${line}\n`)
    } catch {
      // 写不进去 = 服务已走;读端会报 exit
    }
    if (!this.dead && this.child.stdin.writableLength > STDIN_QUEUE_FACTOR * this.o.maxLine) this.finish('overflow')
  }

  onMessage(cb: (m: Record<string, unknown>, bytes: number) => void): void {
    this.messageCbs.push(cb)
  }

  /** 空行、坏 UTF-8/JSON、不是对象的行:不投递,只报字节数,好让调用方给无人认领的字节记账 */
  onJunk(cb: (bytes: number) => void): void {
    this.junkCbs.push(cb)
  }

  /** 调用方判定这条流不可信(例如无人认领的字节过多) */
  overflow(): void {
    this.finish('overflow')
  }

  onClose(cb: (why: CloseWhy) => void): void {
    this.closeCbs.push(cb)
  }

  /** 只给测试看;从不进日志或事件 */
  stderrTail(): string {
    return this.err.toString('utf8')
  }

  /** 调用方主动关:不再触发 onClose */
  close(): void {
    if (this.dead) return
    this.dead = true
    this.drop()
    this.child.stderr.destroy() // 尾巴已在内存里;排着队的东西不留
  }

  private drop(): void {
    this.acc = Buffer.alloc(0)
    this.held = 0
    this.child.stdout.destroy()
    this.child.stdin.destroy() // 服务不读时 stdin 里排着的字节也一并放掉;对进程来说和 EOF 一样
  }

  private finish(why: CloseWhy): void {
    if (this.dead) return
    this.dead = true
    this.drop()
    for (const cb of this.closeCbs) {
      try {
        cb(why)
      } catch {
        // 回调的错不能打断收尾
      }
    }
  }

  private onData(chunk: Buffer): void {
    let rest = chunk
    while (!this.dead && rest.length > 0) {
      const nl = rest.indexOf(0x0a)
      if (nl < 0) {
        if (this.held + rest.length > this.o.maxLine) return this.finish('overflow')
        this.hold(rest)
        return
      }
      if (this.held + nl > this.o.maxLine) return this.finish('overflow')
      const line = this.held ? Buffer.concat([this.acc.subarray(0, this.held), rest.subarray(0, nl)]) : rest.subarray(0, nl)
      this.held = 0
      if (this.acc.length > 64 * 1024) this.acc = Buffer.alloc(0)
      rest = rest.subarray(nl + 1)
      this.deliver(line)
    }
  }

  private hold(b: Buffer): void {
    const need = this.held + b.length
    if (need > this.acc.length) {
      const next = Buffer.allocUnsafe(Math.min(Math.max(need, this.acc.length * 2, 1024), Math.max(need, this.o.maxLine)))
      this.acc.copy(next, 0, 0, this.held)
      this.acc = next
    }
    b.copy(this.acc, this.held)
    this.held = need
  }

  private junk(bytes: number): void {
    for (const cb of this.junkCbs) {
      try {
        cb(bytes)
      } catch {
        // 记账回调的错不能打断流
      }
    }
  }

  private deliver(line: Buffer): void {
    const bytes = line.length + 1
    const text = this.decoder.decode(line).trim()
    if (!text) return this.junk(bytes)
    let msg: unknown
    try {
      msg = JSON.parse(text)
    } catch {
      return this.junk(bytes)
    }
    if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) return this.junk(bytes)
    for (const cb of this.messageCbs) {
      try {
        cb(msg as Record<string, unknown>, bytes)
      } catch {
        // 一个订阅者出错不影响流
      }
    }
  }
}

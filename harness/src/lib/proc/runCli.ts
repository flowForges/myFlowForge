// 起一个编码 CLI(04 spec §5、§9):按行读、超时、卡死、取消。不碰适配器,不做打码:内容由调用方处理
import { spawn } from 'node:child_process'
import type { ShellPlan } from '../tools/types'
import { groupExists, groupMembers, type Kill, type Member } from './pgids'
import { killLadder } from './tree'

/** ShellPlan 或直接给的 {file, args, env};永远 shell:false,所以 file 必须是程序本身 */
export type CliPlan = Pick<ShellPlan, 'file' | 'args' | 'env'> & Partial<ShellPlan>

export interface CliOpts {
  cwd: string
  /** 给了就走管道并关闭;不给 → /dev/null */
  stdin?: string
  timeoutMs: number
  /** 连续这么久 stdout 没有字节 → stalled */
  idleMs: number
  signal: AbortSignal
  onLine(line: string): void
  /** 超过 maxLine 的行(stdout、stderr 都算):不缓冲、不传内容,只给字节数 */
  onDroppedLine?(bytes: number): void
  /** stderr 按行给;这里不留尾部,尾部要在打码之后取 */
  onStderrLine?(line: string): void
  /** 子进程起来后;pid 即 pgid */
  onSpawn?(pid: number): void
  /** 子进程结束、杀完之后,返回之前 */
  onClose?(pid: number): void
  /** 动手杀的时候才问:内核关闭走短梯 */
  fast?: () => boolean
  maxLine?: number
}

export interface CliResult {
  code: number | null
  signal: NodeJS.Signals | null
  /** 三者互斥,第一个原因为准 */
  timedOut: boolean
  stalled: boolean
  cancelled: boolean
  spawnError?: string
}

const MAX_LINE = 1024 * 1024
/** 组长自己退了之后,等管道关的时间;还不关 = 有进程拿着继承的句柄 */
const EXIT_DRAIN_MS = 1000
/** 杀完之后,等退出事件和最后的输出 */
const AFTER_KILL_MS = 500
/** setTimeout 超过它会立刻触发 */
const MAX_TIMER = 2 ** 31 - 1

const quietly = (fn: () => void) => {
  try {
    fn()
  } catch {
    // 回调出错不影响运行
  }
}

/** 按字节切行,所以 UTF-8 不会被切开;超长的行一到上限就不再缓冲 */
class LineSplitter {
  private chunks: Buffer[] = []
  private size = 0
  private dropping = false

  constructor(
    private max: number,
    private onLine: (line: string) => void,
    private onDropped: (bytes: number) => void,
  ) {}

  push(b: Buffer): void {
    let from = 0
    for (;;) {
      const nl = b.indexOf(10, from)
      this.take(nl < 0 ? b.subarray(from) : b.subarray(from, nl))
      if (nl < 0) return
      this.endLine()
      from = nl + 1
    }
  }

  /** 流结束:最后一行可能没有换行 */
  end(): void {
    if (this.size > 0) this.endLine()
  }

  private take(piece: Buffer): void {
    if (!this.dropping && this.size + piece.length > this.max) {
      this.dropping = true
      this.chunks = []
    }
    if (!this.dropping && piece.length) this.chunks.push(piece)
    this.size += piece.length
  }

  private endLine(): void {
    if (this.dropping) {
      const bytes = this.size
      quietly(() => this.onDropped(bytes))
    } else {
      const text = Buffer.concat(this.chunks).toString('utf8')
      const line = text.endsWith('\r') ? text.slice(0, -1) : text
      quietly(() => this.onLine(line))
    }
    this.chunks = []
    this.size = 0
    this.dropping = false
  }
}

const liveKill: Kill = (pid, sig) => process.kill(pid, sig)

export function runCli(plan: CliPlan, o: CliOpts): Promise<CliResult> {
  let released = false
  const release = () => {
    if (released) return
    released = true
    quietly(() => plan.release?.())
  }
  const nothing: CliResult = { code: null, signal: null, timedOut: false, stalled: false, cancelled: false }
  if (o.signal.aborted) {
    release()
    return Promise.resolve({ ...nothing, cancelled: true })
  }

  return new Promise(resolve => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(plan.file, plan.args, {
        cwd: o.cwd,
        env: plan.env,
        shell: false,
        detached: true,
        stdio: [o.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      })
    } catch (e) {
      release()
      return resolve({ ...nothing, spawnError: String((e as Error).message ?? e) })
    }

    let done = false
    let exited = false
    let killing = false
    let code: number | null = null
    let signal: NodeJS.Signals | null = null
    let cause: 'timedOut' | 'stalled' | 'cancelled' | undefined
    let exitAnchors: Member[] = []
    let drain: NodeJS.Timeout | undefined
    let timeout: NodeJS.Timeout | undefined
    let idle: NodeJS.Timeout | undefined
    let markClosed = () => {}
    const closed = new Promise<void>(res => {
      markClosed = res
    })

    const stopTimers = () => {
      clearTimeout(timeout)
      clearTimeout(idle)
      clearTimeout(drain)
    }
    const trigger = (why: NonNullable<typeof cause>) => {
      if (done) return
      cause ??= why
      kill()
    }
    const onAbort = () => trigger('cancelled')

    const finish = (extra: Partial<CliResult> = {}) => {
      if (done) return
      done = true
      stopTimers()
      o.signal.removeEventListener('abort', onAbort)
      out.end()
      err.end()
      if (child.pid !== undefined) quietly(() => o.onClose?.(child.pid!))
      release()
      resolve({ ...nothing, code, signal, timedOut: cause === 'timedOut', stalled: cause === 'stalled', cancelled: cause === 'cancelled', ...extra })
    }

    const kill = () => {
      if (killing || done) return
      killing = true
      stopTimers()
      const pid = child.pid!
      let fast = false
      quietly(() => {
        fast = o.fast?.() === true
      })
      void (async () => {
        try {
          await killLadder(pid, {
            fast,
            alive: () => groupExists(pid, liveKill),
            owned: () => !exited,
            ...(exited && { anchors: exitAnchors }),
          })
        } catch {
          // 出错也要收尾:不能挂住调用方
        }
        // 组长刚被杀:等退出事件和管道关闭带来的最后输出;逃出去的进程拿着管道时不等
        let wait: NodeJS.Timeout | undefined
        await Promise.race([closed, new Promise<void>(res => { wait = setTimeout(res, AFTER_KILL_MS) })])
        clearTimeout(wait)
        child.stdin?.destroy()
        child.stdout?.destroy()
        child.stderr?.destroy()
        finish()
      })()
    }

    const maxLine = o.maxLine ?? MAX_LINE
    const dropped = (n: number) => o.onDroppedLine?.(n)
    const out = new LineSplitter(maxLine, l => o.onLine(l), dropped)
    const err = new LineSplitter(maxLine, l => o.onStderrLine?.(l), dropped)

    child.on('error', e => {
      // pid 还在的 error 是"信号发不出去"这类,不是起不来
      if (child.pid === undefined) finish({ spawnError: String(e.message ?? e) })
    })
    if (child.pid === undefined) return // error 事件下一拍到

    quietly(() => o.onSpawn?.(child.pid!))

    child.stdin?.on('error', () => {}) // CLI 没读完就退:EPIPE
    child.stdin?.end(o.stdin)
    child.stdout!.on('data', (b: Buffer) => {
      if (!exited && !killing) idle?.refresh()
      out.push(b)
    })
    child.stderr!.on('data', (b: Buffer) => err.push(b))

    child.on('exit', (c, s) => {
      code = c
      signal = s
      exited = true
      if (killing) return
      stopTimers()
      // 记下此刻的组员:之后组长已不在,靠它们认组
      if (groupExists(child.pid!, liveKill)) exitAnchors = groupMembers(child.pid!).filter(m => m.pid !== child.pid)
      drain = setTimeout(kill, EXIT_DRAIN_MS)
    })
    child.on('close', () => {
      markClosed()
      if (killing) return
      clearTimeout(drain)
      // 管道都关了,组里还有进程:运行结束不留后台进程
      if (groupExists(child.pid!, liveKill)) kill()
      else finish()
    })

    timeout = setTimeout(() => trigger('timedOut'), Math.min(o.timeoutMs, MAX_TIMER))
    idle = setTimeout(() => trigger('stalled'), Math.min(o.idleMs, MAX_TIMER))
    o.signal.addEventListener('abort', onAbort, { once: true })
    if (o.signal.aborted) onAbort() // onSpawn 里取消的
  })
}

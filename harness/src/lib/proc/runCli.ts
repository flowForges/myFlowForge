// 起一个编码 CLI(04 spec §5、§9):按行读、超时、卡死、取消。不碰适配器,不做打码:内容由调用方处理
import { spawn } from 'node:child_process'
import type { ShellPlan } from '../tools/types'
import { groupExists, groupMembers, ownPgid, type Kill, type Member, type ProcDeps } from './pgids'
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
  /** 测试注入:交给杀进程阶梯 */
  procDeps?: ProcDeps
}

export interface CliResult {
  code: number | null
  signal: NodeJS.Signals | null
  /** 三者互斥,第一个原因为准 */
  timedOut: boolean
  stalled: boolean
  /** 取消了且确实杀掉了;杀不掉时是 killFailed */
  cancelled: boolean
  /** 要杀但进程还在(如信号发不出去):不能当作已结束 */
  killFailed?: boolean
  /**
   * 运行结束时还留着的进程。kept:CLI 自己退了,留下的进程已放开管道(不杀,进程组登记会留着),
   * 或者有杀不到的进程还拿着管道。killed:CLI 自己退了,留下的进程拿着管道,被杀掉了
   */
  leftovers?: 'kept' | 'killed'
  /**
   * 开始杀的时候 CLI 已经自己退了(取消落在等管道的 1 s 里):code、signal 是它自己的结局,不是我们杀出来的。
   * cancelled 仍如实为 true,怎么算由调用方定
   */
  exitedFirst?: boolean
  /** 只有错误码:Node 的报错文本会引用 env 和参数的值 */
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

const spawnFailure = (e: unknown) => {
  const code = (e as NodeJS.ErrnoException)?.code
  return typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? `spawn failed: ${code}` : 'spawn failed'
}

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

  ownPgid() // 趁现在记住:CLI 把进程数用尽之后 ps 起不来,而 kill 还发得出去

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
      return resolve({ ...nothing, spawnError: spawnFailure(e) })
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
    let isClosed = false
    let markClosed = () => {}
    const closed = new Promise<void>(res => {
      markClosed = () => {
        isClosed = true
        res()
      }
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
      resolve({ ...nothing, code, signal, timedOut: cause === 'timedOut', stalled: cause === 'stalled', cancelled: cause === 'cancelled' && !extra.killFailed, ...extra })
    }

    const kill = () => {
      if (killing || done) return
      killing = true
      stopTimers()
      const pid = child.pid!
      const selfExited = exited
      let fast = false
      quietly(() => {
        fast = o.fast?.() === true
      })
      void (async () => {
        let gone = false
        try {
          ;({ gone } = await killLadder(pid, {
            ...o.procDeps,
            fast,
            alive: () => groupExists(pid, liveKill),
            owned: () => !exited,
            ...(exited && { anchors: exitAnchors }),
          }))
        } catch {
          // 出错也要收尾:不能挂住调用方
        }
        // 组长刚被杀:等退出事件和管道关闭带来的最后输出;逃出去的进程拿着管道时不等
        let wait: NodeJS.Timeout | undefined
        await Promise.race([closed, new Promise<void>(res => { wait = setTimeout(res, AFTER_KILL_MS) })])
        clearTimeout(wait)
        child.stdin?.destroy()
        child.stdout?.destroy()
        const held = !isClosed
        child.stderr?.destroy()
        const leftovers = !gone || held ? 'kept' : selfExited ? 'killed' : undefined
        finish({ ...(cause && !gone && { killFailed: true }), ...(leftovers && { leftovers }), ...(selfExited && { exitedFirst: true }) })
      })()
    }

    const maxLine = o.maxLine ?? MAX_LINE
    const dropped = (n: number) => o.onDroppedLine?.(n)
    const out = new LineSplitter(maxLine, l => o.onLine(l), dropped)
    const err = new LineSplitter(maxLine, l => o.onStderrLine?.(l), dropped)

    child.on('error', e => {
      // pid 还在的 error 是"信号发不出去"这类,不是起不来
      if (child.pid === undefined) finish({ spawnError: spawnFailure(e) })
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
      // 记下此刻的组员:之后组长已不在,靠它们认组(还拿着管道时要杀)
      if (groupExists(child.pid!, liveKill)) exitAnchors = groupMembers(child.pid!).filter(m => m.pid !== child.pid)
      drain = setTimeout(kill, EXIT_DRAIN_MS)
    })
    child.on('close', () => {
      markClosed()
      if (killing) return
      clearTimeout(drain)
      // 管道都放开了,组里还有进程:可能是用户要的后台服务,不杀,如实报;组长已退,进程组登记留着它
      finish(groupExists(child.pid!, liveKill) ? { leftovers: 'kept' } : {})
    })

    timeout = setTimeout(() => trigger('timedOut'), Math.min(o.timeoutMs, MAX_TIMER))
    idle = setTimeout(() => trigger('stalled'), Math.min(o.idleMs, MAX_TIMER))
    o.signal.addEventListener('abort', onAbort, { once: true })
    if (o.signal.aborted) onAbort() // onSpawn 里取消的
  })
}

import { spawn, type ChildProcess } from 'node:child_process'
import { PROTOCOL_VERSION, type ControlStatus } from '../protocol/index'
import { nullLogger, type Logger } from '../kernel/log'
import { HARNESS_VERSION } from '../kernel/version'
import { isOom, nextDelayMs, shouldTrip, type Failure } from './backoff'

export interface SupervisorOpts {
  workerCmd: string
  workerArgs: string[]
  env: NodeJS.ProcessEnv
  pingMs?: number
  missLimit?: number
  drainMs?: number
  // 拉起后多久内必须 ready,否则当卡死处理
  startupMs?: number
  log?: Logger
  // 测试注入
  delayFn?: (ms: number) => Promise<void>
  now?: () => number
  onState?: (s: ControlStatus) => void
}

const STABLE_MS = 60_000 // 正常跑满这么久,连续失败计数清零
const HISTORY_MS = 30 * 60_000 // 熔断判断用到的最长窗口
const STDERR_TAIL = 8192
const STDERR_FLUSH_MS = 200

type State = ControlStatus['state']

export class Supervisor {
  private readonly pingMs: number
  private readonly missLimit: number
  private readonly drainMs: number
  private readonly startupMs: number
  private readonly log: Logger
  private readonly delayFn: (ms: number) => Promise<void>
  private readonly now: () => number

  private st: State = 'starting'
  private child?: ChildProcess
  private childExit?: Promise<void>
  private readonly expected = new WeakSet<ChildProcess>() // 主动停的进程,退出不算失败
  private restarts = 0
  private trippedReason?: 'crash-loop' | 'oom'
  private history: Failure[] = []
  private consecutive = 0
  private gen = 0 // 每次手动操作 / 进入退避 +1,作废挂起的退避重启
  private shutdownP?: Promise<void>

  constructor(private readonly opts: SupervisorOpts) {
    this.pingMs = opts.pingMs ?? 1000
    this.missLimit = opts.missLimit ?? 3
    this.drainMs = opts.drainMs ?? 30_000
    this.startupMs = opts.startupMs ?? 30_000
    this.log = opts.log ?? nullLogger
    this.delayFn = opts.delayFn ?? (ms => new Promise(r => setTimeout(r, ms)))
    this.now = opts.now ?? Date.now
  }

  async start(): Promise<void> {
    this.set('starting')
    this.spawnWorker()
  }

  state(): ControlStatus {
    const s: ControlStatus = {
      state: this.st,
      restarts: this.restarts,
      version: HARNESS_VERSION,
      protocolVersion: PROTOCOL_VERSION,
    }
    if (this.child?.pid !== undefined) s.workerPid = this.child.pid
    if (this.trippedReason) s.trippedReason = this.trippedReason
    return s
  }

  /** 排空当前工作进程(超时强杀),不再拉起 */
  shutdown(): Promise<void> {
    if (!this.shutdownP) {
      this.gen++
      this.set('stopping')
      this.shutdownP = this.stopWorker().then(() => this.emit())
    }
    return this.shutdownP
  }

  /** 排空当前工作进程后拉起新的;算一次重启,不算失败 */
  async restart(): Promise<void> {
    if (this.st === 'stopping') return
    const g = ++this.gen
    if (this.st === 'tripped') this.clearFailures()
    this.set('restarting')
    await this.stopWorker()
    if (g !== this.gen) return
    this.restarts++
    this.spawnWorker()
  }

  /** 清掉失败记录;熔断(没有工作进程)时重新拉起 */
  resetTrip(): void {
    if (this.st === 'stopping') return
    this.clearFailures()
    if (this.child) return this.emit()
    this.gen++
    this.set('starting')
    this.spawnWorker()
  }

  private clearFailures(): void {
    this.history = []
    this.consecutive = 0
    this.trippedReason = undefined
  }

  private set(s: State): void {
    this.st = s
    this.emit()
  }

  private emit(): void {
    try { this.opts.onState?.(this.state()) } catch (err) { this.log.error('onState failed', { error: String(err) }) }
  }

  private spawnWorker(): void {
    const child = spawn(this.opts.workerCmd, this.opts.workerArgs, {
      env: this.opts.env,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    })
    this.child = child
    let tail = ''
    let readyAt: number | undefined
    let misses = 0
    let heard = false // 收到过任何消息:IPC 已通,开始按漏 ping 计
    const spawnedAt = this.now()
    let hung = false
    let done = false
    let onExit!: () => void
    this.childExit = new Promise<void>(r => { onExit = r })

    const stderrEnded = new Promise<void>(r => {
      if (!child.stderr) return r()
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (d: string) => { tail = (tail + d).slice(-STDERR_TAIL) })
      child.stderr.once('close', () => r())
    })

    child.on('message', (m: { t?: string }) => {
      heard = true
      if (m?.t === 'pong') misses = 0
      else if (m?.t === 'ready' && this.child === child) {
        readyAt = this.now()
        misses = 0
        if (this.st === 'starting' || this.st === 'restarting') this.set('running')
      }
    })

    const ping = setInterval(() => {
      // 进程刚起(Node 启动可能慢于几次 ping)不算漏;启动超时另算
      const stuck = (heard && misses >= this.missLimit) || (readyAt === undefined && this.now() - spawnedAt >= this.startupMs)
      if (stuck) {
        hung = true
        clearInterval(ping)
        this.log.warn('worker hung', { pid: child.pid, misses, heard })
        child.kill('SIGKILL')
        return
      }
      if (heard) misses++
      if (child.connected) child.send({ t: 'ping' }, () => { /* 通道已关:退出事件随后到 */ })
    }, this.pingMs)

    const gone = async (code: number | null, signal: string | null) => {
      if (done) return
      done = true
      clearInterval(ping)
      // stderr 可能比 exit 晚到(OOM 信息在最后几行);等一小会儿
      await Promise.race([stderrEnded, new Promise(r => setTimeout(r, STDERR_FLUSH_MS))])
      if (this.child === child) this.child = undefined
      onExit()
      if (this.expected.has(child)) {
        this.log.info('worker stopped', { pid: child.pid, code, signal })
        return
      }
      this.onFailure({ code, signal, stderrTail: tail }, hung, readyAt)
    }
    child.once('exit', (code, signal) => void gone(code, signal))
    child.on('error', (err) => {
      // 没拿到 pid 即启动失败,不会再有 exit
      if (child.pid === undefined) void gone(null, null)
      else this.log.warn('worker channel error', { error: String(err) })
    })
    this.log.info('worker spawned', { pid: child.pid })
    this.emit()
  }

  private onFailure(exit: { code: number | null; signal: string | null; stderrTail: string }, hung: boolean, readyAt?: number): void {
    const at = this.now()
    const oom = isOom(exit)
    if (readyAt !== undefined && at - readyAt >= STABLE_MS) this.consecutive = 0
    this.consecutive++
    this.history = [...this.history.filter(f => f.at > at - HISTORY_MS), { at, oom }]
    this.log.warn('worker failed', { code: exit.code, signal: exit.signal, hung, oom, stderr: exit.stderrTail.slice(-2000) })
    if (this.st === 'stopping') return
    const d = shouldTrip(this.history, at)
    if (d.trip) {
      this.trippedReason = d.reason
      this.log.error('tripped', { reason: d.reason })
      this.set('tripped')
      return
    }
    const g = ++this.gen
    this.set('restarting')
    void this.delayFn(nextDelayMs(this.consecutive)).then(() => {
      if (g !== this.gen || this.st !== 'restarting') return
      this.restarts++
      this.spawnWorker()
    })
  }

  private async stopWorker(): Promise<void> {
    const child = this.child
    const exited = this.childExit
    if (!child || !exited) return
    this.expected.add(child)
    if (child.connected) child.send({ t: 'drain' }, () => { /* 已断开 */ })
    const timer = setTimeout(() => {
      this.log.warn('drain timeout, killing worker', { pid: child.pid })
      child.kill('SIGKILL')
    }, this.drainMs)
    await exited
    clearTimeout(timer)
  }
}

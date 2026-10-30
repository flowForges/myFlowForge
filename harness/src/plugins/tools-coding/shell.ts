// shell:在会话 cwd 下执行命令(spec §7、§7.1)。POSIX 新进程组,超时 / 取消时杀整组;Windows taskkill /T /F
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { z } from 'zod'
import { loginShellPath, shellEnv } from '../../lib/tools/shellEnv'
import { argsOf, type Tool } from '../../lib/tools/types'
import { jsonSchema } from './common'

export const DEFAULT_TIMEOUT = 120_000
export const MAX_TIMEOUT = 600_000
export const MIN_TIMEOUT = 1_000
/** 合并输出的缓冲上限;超过只留结尾 */
export const MAX_OUTPUT = 1024 * 1024
/** SIGTERM 之后等这么久再 SIGKILL */
const KILL_GRACE = 2_000
/** SIGKILL 之后管道仍不关(有进程逃出了进程组还拿着管道)→ 再等这么久就不等了 */
const CLOSE_GRACE = 1_000

export interface ShellDeps {
  /** 基础环境(按白名单过滤);默认 process.env,测试注入 */
  env?: NodeJS.ProcessEnv
  /** 登录 shell 的 PATH;默认 loginShellPath()(每进程探测一次),测试注入 `async () => ''` */
  loginPath?: () => Promise<string>
  /** timeoutMs 下限,默认 1 s;测试调小 */
  minTimeoutMs?: number
}

export interface ShellRun {
  code: number | null
  signal: NodeJS.Signals | null
  output: string
  timedOut: boolean
  cancelled: boolean
}

export interface RunShellOpts {
  cwd: string
  env: NodeJS.ProcessEnv
  timeoutMs: number
  signal: AbortSignal
  platform: NodeJS.Platform
}

/** 只留结尾的输出缓冲 */
class TailBuffer {
  private chunks: Buffer[] = []
  private size = 0
  private dropped = 0

  push(b: Buffer): void {
    this.chunks.push(b)
    this.size += b.length
    while (this.size > MAX_OUTPUT) {
      const over = this.size - MAX_OUTPUT
      const first = this.chunks[0]
      if (first.length <= over) {
        this.chunks.shift()
        this.size -= first.length
        this.dropped += first.length
      } else {
        this.chunks[0] = first.subarray(over)
        this.size -= over
        this.dropped += over
      }
    }
  }

  text(): string {
    const body = Buffer.concat(this.chunks).toString('utf8')
    return this.dropped > 0 ? `…[前 ${this.dropped} 字节已省略]\n${body}` : body
  }
}

export function runShell(command: string, opts: RunShellOpts): Promise<ShellRun> {
  if (opts.signal.aborted) return Promise.resolve({ code: null, signal: null, output: '', timedOut: false, cancelled: true })
  const win = opts.platform === 'win32'
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd: opts.cwd,
      env: opts.env,
      shell: true,
      detached: !win,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const out = new TailBuffer()
    child.stdout!.on('data', (b: Buffer) => out.push(b))
    child.stderr!.on('data', (b: Buffer) => out.push(b))

    let timedOut = false
    let cancelled = false
    let killing = false
    let done = false
    const timers: NodeJS.Timeout[] = []

    const group = (sig: NodeJS.Signals) => {
      try {
        process.kill(-child.pid!, sig)
      } catch {
        // 整组都没了
      }
    }
    const kill = () => {
      if (killing || child.pid === undefined) return
      killing = true
      if (win) {
        const tk = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
        tk.on('error', () => child.kill())
        return
      }
      group('SIGTERM')
      timers.push(
        setTimeout(() => {
          group('SIGKILL')
          timers.push(
            setTimeout(() => {
              child.stdout!.destroy()
              child.stderr!.destroy()
              finish(child.exitCode, child.signalCode)
            }, CLOSE_GRACE),
          )
        }, KILL_GRACE),
      )
    }
    const onAbort = () => {
      cancelled = true
      kill()
    }
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (done) return
      done = true
      // 杀过:组里忽略了 SIGTERM 但已关掉管道的进程,现在补一刀,不留到 2 s 定时器
      if (killing && !win) group('SIGKILL')
      for (const t of timers) clearTimeout(t)
      opts.signal.removeEventListener('abort', onAbort)
      resolve({ code, signal, output: out.text(), timedOut, cancelled })
    }

    timers.push(
      setTimeout(() => {
        timedOut = true
        kill()
      }, opts.timeoutMs),
    )
    opts.signal.addEventListener('abort', onAbort, { once: true })
    child.on('error', e => {
      if (done) return
      done = true
      for (const t of timers) clearTimeout(t)
      opts.signal.removeEventListener('abort', onAbort)
      reject(e)
    })
    child.on('close', (code, signal) => finish(code, signal))
  })
}

export const clampTimeout = (ms: number | undefined, min = MIN_TIMEOUT) => Math.min(MAX_TIMEOUT, Math.max(min, ms ?? DEFAULT_TIMEOUT))

const Args = z.object({
  command: z.string().min(1).describe('Shell command to run in the working directory'),
  timeoutMs: z.number().int().positive().optional().describe(`Timeout in milliseconds (default ${DEFAULT_TIMEOUT}, max ${MAX_TIMEOUT})`),
})

export function shellTool(deps: ShellDeps = {}): Tool {
  const base = () => deps.env ?? process.env
  const loginPath = deps.loginPath ?? (() => loginShellPath())
  return {
    name: 'shell',
    description: `Run a shell command in the working directory (POSIX /bin/sh -c, Windows cmd.exe). stdout and stderr are merged; stdin is closed, so interactive commands cannot prompt. Default timeout ${DEFAULT_TIMEOUT / 1000} s, max ${MAX_TIMEOUT / 1000} s; on timeout the whole process tree is killed.`,
    parameters: jsonSchema(Args),
    permission: raw => [{ actor: 'tools', action: 'exec', resource: argsOf(Args, raw).command }],
    async run(raw, ctx) {
      const args = argsOf(Args, raw)
      const timeoutMs = clampTimeout(args.timeoutMs, deps.minTimeoutMs)
      const b = base()
      const home = b.HOME ?? b.USERPROFILE ?? homedir()
      const env = shellEnv(b, { platform: process.platform, home, loginPath: await loginPath().catch(() => '') })
      const r = await runShell(args.command, { cwd: ctx.cwd, env, timeoutMs, signal: ctx.signal, platform: process.platform })
      if (r.timedOut) return { content: `timeout after ${timeoutMs} ms\n${r.output}`, isError: true }
      if (r.cancelled) return { content: `已取消\n${r.output}`, isError: true }
      return { content: `exit ${r.code ?? r.signal}\n${r.output}` }
    },
  }
}

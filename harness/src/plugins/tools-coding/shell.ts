// shell:在会话 cwd 下执行命令(spec §7、§7.1)。POSIX 新进程组,超时 / 取消时杀整组;Windows taskkill /T /F。
// 05 §10:命令先经内核 `sandbox` 服务生成计划;沙箱计划直接起 sandbox-exec / bwrap(它就是组长),生成失败 → 命令失败,绝不退回无沙箱
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { z } from 'zod'
import type { PgidRegistry } from '../../lib/proc/pgids'
import { loginShellPath, shellEnv } from '../../lib/tools/shellEnv'
import { argsOf, type SandboxService, type ShellPlan, type Tool } from '../../lib/tools/types'
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
  /** 进程组登记(spec §12);win32 不传 */
  registry?: Pick<PgidRegistry, 'add' | 'settle'>
  /** 内核 sandbox 服务;不在 → 按 none(03 的行为) */
  sandbox?: Pick<SandboxService, 'plan' | 'status'>
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
  timeoutMs: number
  signal: AbortSignal
  platform: NodeJS.Platform
  /** 子进程起来后(POSIX 上 pid 即 pgid);抛错被吞掉 */
  onSpawn?: (pid: number) => void
  /** 子进程结束、runShell 返回前 */
  onClose?: (pid: number) => void
}

/** 无沙箱计划(没有 sandbox 服务时):命令本身交给 shell:true */
export const unsandboxedPlan = (command: string, env: NodeJS.ProcessEnv): ShellPlan => ({ file: command, args: [], env, sandboxed: false, level: 'none', release: () => {} })

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
        let cut = over
        while (cut < first.length && (first[cut] & 0xc0) === 0x80) cut++ // 不切在 UTF-8 字符中间
        this.chunks[0] = first.subarray(cut)
        this.size -= cut
        this.dropped += cut
      }
    }
  }

  text(): string {
    const body = Buffer.concat(this.chunks).toString('utf8')
    return this.dropped > 0 ? `…[前 ${this.dropped} 字节已省略]\n${body}` : body
  }
}

/**
 * 执行一条计划。plan.release() 在命令结束、超时 / 取消杀完、起不来时各路径上恰好调一次(之后才 resolve / reject)。
 * 沙箱计划:spawn(file, args, shell:false, detached) —— sandbox-exec / bwrap 是组长,进程组登记与杀组照旧
 */
export function runShell(plan: ShellPlan, opts: RunShellOpts): Promise<ShellRun> {
  let released = false
  const release = () => {
    if (released) return
    released = true
    try {
      plan.release()
    } catch {
      // 释放失败不影响结果
    }
  }
  if (opts.signal.aborted) {
    release()
    return Promise.resolve({ code: null, signal: null, output: '', timedOut: false, cancelled: true })
  }
  const win = opts.platform === 'win32'
  return new Promise((resolve, reject) => {
    const common = { cwd: opts.cwd, env: plan.env, stdio: ['ignore', 'pipe', 'pipe'] as ('ignore' | 'pipe')[], windowsHide: true }
    let child: ReturnType<typeof spawn>
    try {
      child = plan.sandboxed
        ? spawn(plan.file, plan.args, { ...common, shell: false, detached: true })
        : spawn(plan.file, { ...common, shell: true, detached: !win })
    } catch (e) {
      release()
      return reject(e)
    }
    const hook = (fn: ((pid: number) => void) | undefined) => {
      if (!fn || child.pid === undefined) return
      try {
        fn(child.pid)
      } catch {
        // 登记失败不影响命令
      }
    }
    hook(opts.onSpawn) // 同步:子进程即使已退,在事件循环回收它之前 pid 都还在
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
        // 绝对路径:不按工作进程的 PATH / 当前目录找 taskkill
        const taskkill = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\taskkill.exe`
        const tk = spawn(taskkill, ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
        tk.on('error', () => child.kill())
        tk.on('exit', code => code !== 0 && child.kill())
      } else group('SIGTERM')
      // 两个平台同一条兜底:2 s 后 SIGKILL(win32 已是强杀),再 1 s 管道还不关(有进程拿着继承的句柄)→ 不等了
      timers.push(
        setTimeout(() => {
          if (!win) group('SIGKILL')
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
      hook(opts.onClose)
      release()
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
      hook(opts.onClose)
      release()
      reject(e)
    })
    child.on('close', (code, signal) => finish(code, signal))
  })
}

const levelOf = (sb: Pick<SandboxService, 'status'>, sessionId: string): ShellPlan['level'] => {
  try {
    return sb.status(sessionId).level
  } catch {
    return 'none'
  }
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
    description: `Run a shell command in the working directory (POSIX /bin/sh -c, Windows cmd.exe). stdout and stderr are merged; stdin is closed, so interactive commands cannot prompt. Default timeout ${DEFAULT_TIMEOUT / 1000} s, max ${MAX_TIMEOUT / 1000} s; on timeout the whole process tree is killed. A background job that keeps stdout/stderr open keeps the call running until the timeout; redirect its output (e.g. cmd >/dev/null 2>&1 &).`,
    parameters: jsonSchema(Args),
    permission: raw => [{ actor: 'tools', action: 'exec', resource: argsOf(Args, raw).command }],
    async run(raw, ctx) {
      const args = argsOf(Args, raw)
      const timeoutMs = clampTimeout(args.timeoutMs, deps.minTimeoutMs)
      const b = base()
      const home = b.HOME ?? b.USERPROFILE ?? homedir()
      const env = shellEnv(b, { platform: process.platform, home, loginPath: await loginPath().catch(() => '') })
      const sb = deps.sandbox
      let plan: ShellPlan
      if (!sb) plan = unsandboxedPlan(args.command, env)
      else {
        try {
          plan = await sb.plan(args.command, { sessionId: ctx.sessionId, cwd: ctx.cwd, spillDir: ctx.spillDir }, env)
        } catch (e) {
          // 沙箱配置生成失败:命令失败,绝不无沙箱执行
          return { content: `沙箱准备失败,命令未执行:${e instanceof Error ? e.message : String(e)}`, isError: true, meta: { sandbox: levelOf(sb, ctx.sessionId) } }
        }
      }
      const meta = { sandbox: plan.level }
      const reg = deps.registry
      const r = await runShell(plan, {
        cwd: ctx.cwd, timeoutMs, signal: ctx.signal, platform: process.platform,
        ...(reg && { onSpawn: pid => reg.add(pid), onClose: pid => reg.settle(pid) }),
      })
      if (r.cancelled) return { content: `已取消\n${r.output}`, isError: true, meta } // 取消后的宽限期里超时也触发 → 仍报取消
      if (r.timedOut) return { content: `timeout after ${timeoutMs} ms\n${r.output}`, isError: true, meta }
      return { content: `exit ${r.code ?? r.signal}\n${r.output}`, meta }
    },
  }
}

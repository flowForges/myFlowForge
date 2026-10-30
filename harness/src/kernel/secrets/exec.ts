import { spawn } from 'node:child_process'

export type ExecResult = { code: number | null; stdout: string; timedOut: boolean }
/** 注入式命令执行:密钥只走 stdin,argv 里只有命令与非敏感参数 */
export type Exec = (cmd: string, args: string[], stdin: string, timeoutMs: number) => Promise<ExecResult>

export const realExec: Exec = (cmd, args, stdin, timeoutMs) =>
  new Promise(resolve => {
    let stdout = ''
    let timedOut = false
    let settled = false
    const done = (r: ExecResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(r)
    }
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
      done({ code: null, stdout: '', timedOut: true })
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d: string) => { stdout += d })
    child.on('error', () => done({ code: null, stdout: '', timedOut })) // ENOENT 等
    child.on('close', code => done({ code, stdout, timedOut }))
    child.stdin.on('error', () => {}) // 进程先退出时写 stdin 会 EPIPE
    child.stdin.end(stdin)
  })

/** 兜底计时:即使注入的 exec 不守约,也不让调用方挂住 */
export function withTimeout(exec: Exec, timeoutMs: number): (cmd: string, args: string[], stdin?: string) => Promise<ExecResult> {
  return (cmd, args, stdin = '') => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const guard = new Promise<ExecResult>(r => {
      timer = setTimeout(() => r({ code: null, stdout: '', timedOut: true }), timeoutMs + 500)
    })
    return Promise.race([exec(cmd, args, stdin, timeoutMs).catch(() => ({ code: null, stdout: '', timedOut: false })), guard])
      .finally(() => clearTimeout(timer))
  }
}

/** 失败种类(只用于日志,不含输出内容) */
export function failure(cmd: string, r: ExecResult): Error {
  return new Error(r.timedOut ? `${cmd} timed out` : r.code === null ? `${cmd} not runnable` : `${cmd} exited ${r.code}`)
}

/** 主密钥在、但解不开(换用户 / 换机器 / 内容损坏);与"后端暂时不可用"区分 */
export class KeyUnreadableError extends Error {}

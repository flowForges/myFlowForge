import type { Exec, ExecResult } from './exec'

export type Call = { cmd: string; args: string[]; stdin: string; timeoutMs: number }

/** 内存版 `security`:只认本实现用到的三条命令;never 碰真钥匙串 */
export function fakeSecurity(opts: { hangOn?: (c: Call) => boolean; failAll?: boolean } = {}) {
  const items = new Map<string, string>() // `${acct}|${svc}` -> value
  const calls: Call[] = []
  const exec: Exec = (cmd, args, stdin, timeoutMs) => {
    const c = { cmd, args, stdin, timeoutMs }
    calls.push(c)
    if (opts.hangOn?.(c)) return new Promise<ExecResult>(() => {}) // 永不返回(钥匙串弹窗)
    if (opts.failAll || cmd !== 'security') return Promise.resolve({ code: null, stdout: '', timedOut: false })
    const flag = (a: string[], f: string) => a[a.indexOf(f) + 1]
    if (args[0] === '-i') {
      for (const line of stdin.split('\n').filter(Boolean)) {
        const m = /^add-generic-password -a (\S+) -s (\S+) -U -w "((?:[^"\\]|\\.)*)"/.exec(line)
        if (!m) return Promise.resolve({ code: 1, stdout: '', timedOut: false })
        items.set(`${m[1]}|${m[2]}`, m[3].replace(/\\(.)/g, '$1'))
      }
      return Promise.resolve({ code: 0, stdout: '', timedOut: false })
    }
    const key = `${flag(args, '-a')}|${flag(args, '-s')}`
    if (args[0] === 'find-generic-password') {
      const v = items.get(key)
      return Promise.resolve(v === undefined ? { code: 44, stdout: '', timedOut: false } : { code: 0, stdout: v + '\n', timedOut: false })
    }
    if (args[0] === 'delete-generic-password') {
      const had = items.delete(key)
      return Promise.resolve({ code: had ? 0 : 44, stdout: '', timedOut: false })
    }
    return Promise.resolve({ code: 1, stdout: '', timedOut: false })
  }
  return { exec, calls, items }
}

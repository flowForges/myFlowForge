import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { Logger } from '../kernel/log'

const DAY_MS = 86_400_000
const RETENTION_DAYS = 7

const ymd = (t: number) => {
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** JSON 行日志,写 `<dir>/<name>-YYYY-MM-DD.log`;创建时删除 7 天前的同名日志 */
export function createFileLogger(dir: string, name: string, now: () => number = Date.now): Logger {
  mkdirSync(dir, { recursive: true })
  const cutoff = ymd(now() - RETENTION_DAYS * DAY_MS)
  const re = new RegExp(`^${name}-(\\d{4}-\\d{2}-\\d{2})\\.log$`)
  for (const f of readdirSync(dir)) {
    const m = re.exec(f)
    if (m && m[1] < cutoff) {
      try { unlinkSync(join(dir, f)) } catch { /* 忽略 */ }
    }
  }
  const write = (level: string, msg: string, data?: unknown) => {
    const t = now()
    const line = JSON.stringify({ ts: new Date(t).toISOString(), level, msg, ...(data === undefined ? {} : { data }) })
    try { appendFileSync(join(dir, `${name}-${ymd(t)}.log`), line + '\n') } catch { /* 日志失败不影响进程 */ }
  }
  return {
    info: (msg, data) => write('info', msg, data),
    warn: (msg, data) => write('warn', msg, data),
    error: (msg, data) => write('error', msg, data),
  }
}

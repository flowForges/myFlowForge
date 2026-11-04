import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import type { Logger } from '../kernel/log'

// 登录项(launchd / systemd)启动的监管进程没有 app 的代理环境变量;app 拉起时把代理存下来,登录项启动时恢复。
// ★代理 URL 可能带账号:只进文件(0600)和工作进程的环境,不进日志、错误信息、RPC。

export const PROXY_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'] as const
/** 存哪个:HTTPS 优先,再 ALL,最后 HTTP;大写在前 */
const PICK_ORDER = ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy'] as const

const MAX_URL = 2048
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/

/** 纯函数;文件由调用方读写 */
export function resolveProxyEnv(env: NodeJS.ProcessEnv, saved: { url: string } | undefined): {
  env: NodeJS.ProcessEnv
  write?: { url: string }
  remove?: true
} {
  const out: NodeJS.ProcessEnv = { ...env }
  const fromApp = out.MFFAI_SPAWNED_BY_APP === '1'
  delete out.MFFAI_SPAWNED_BY_APP
  const url = PICK_ORDER.map(k => env[k]).find(v => !!v?.trim())?.trim()
  if (fromApp) {
    if (!url) return { env: out, remove: true }
    out.NODE_USE_ENV_PROXY = '1'
    return { env: out, write: { url } }
  }
  if (url) {
    out.NODE_USE_ENV_PROXY = '1'
    return { env: out }
  }
  if (!saved?.url) return { env: out }
  for (const k of PROXY_KEYS) out[k] = saved.url
  const no = [env.NO_PROXY || env.no_proxy, 'localhost', '127.0.0.1'].filter(Boolean).join(',')
  out.NO_PROXY = no
  out.no_proxy = no
  out.NODE_USE_ENV_PROXY = '1'
  return { env: out }
}

/** 读不出 / 格式不对一律当没有;日志只写原因代码,不写内容(JSON.parse 的报错会带片段) */
export function readSavedProxy(file: string, log: Logger): { url: string } | undefined {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') log.warn('proxy file unreadable, ignored', { code: code ?? 'unknown' })
    return undefined
  }
  try {
    const url = (JSON.parse(raw) as { url?: unknown } | null)?.url
    if (typeof url === 'string' && url.trim() && url.length <= MAX_URL && !CONTROL.test(url)) return { url: url.trim() }
  } catch { /* 下面统一记录 */ }
  log.warn('proxy file invalid, ignored')
  return undefined
}

/** 按 resolveProxyEnv 的结果写 / 删文件;失败只记原因代码 */
export function persistProxy(file: string, r: { write?: { url: string }; remove?: true }, log: Logger): void {
  try {
    if (r.write) {
      const tmp = `${file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify({ url: r.write.url }), { mode: 0o600 })
      try { chmodSync(tmp, 0o600) } catch { /* Windows */ }
      renameSync(tmp, file)
      log.info('proxy saved')
    } else if (r.remove) {
      rmSync(file, { force: true })
      log.info('proxy cleared')
    }
  } catch (err) {
    log.warn('proxy file update failed', { code: (err as NodeJS.ErrnoException).code ?? 'unknown' })
  }
}

/** 监管进程用:算出给工作进程的环境,并同步文件 */
export function workerEnvFor(env: NodeJS.ProcessEnv, file: string, log: Logger): NodeJS.ProcessEnv {
  const fromApp = env.MFFAI_SPAWNED_BY_APP === '1'
  const r = resolveProxyEnv(env, fromApp ? undefined : readSavedProxy(file, log))
  persistProxy(file, r, log)
  return r.env
}

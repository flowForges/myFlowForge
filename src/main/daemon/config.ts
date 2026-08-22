import { z } from 'zod'
import { randomBytes } from 'node:crypto'
import { sysFile } from '../config/paths'
import { readJson, writeJson } from '../config/store'

export const DaemonConfigSchema = z.object({
  version: z.literal(1).catch(1),
  /** 访问令牌。只在**非回环**监听时才会被要求(决策 B-3) */
  token: z.string().catch(''),
})
export type DaemonConfig = z.infer<typeof DaemonConfigSchema>

const file = () => sysFile('daemon.json')
export const readDaemonConfig = (): DaemonConfig => readJson(file(), DaemonConfigSchema, () => ({ version: 1, token: '' }))

/** 没有就生成一个。32 字节随机 —— 这东西是整台机器的钥匙,不能是人能猜的。 */
export function ensureToken(): string {
  const c = readDaemonConfig()
  if (c.token) return c.token
  const token = randomBytes(32).toString('base64url')
  writeJson(file(), { version: 1, token })
  return token
}

export function resetToken(): string {
  const token = randomBytes(32).toString('base64url')
  writeJson(file(), { version: 1, token })
  return token
}

/** `1.2.3.4:6767` / `:6767` / `6767` → { host, port } */
export function parseListen(spec: string): { host: string; port: number } {
  const s = spec.trim()
  if (/^\d+$/.test(s)) return { host: '127.0.0.1', port: Number(s) }
  const i = s.lastIndexOf(':')
  if (i < 0) return { host: s, port: 6767 }
  const host = s.slice(0, i) || '127.0.0.1'
  const port = Number(s.slice(i + 1))
  return { host, port: Number.isFinite(port) && port > 0 ? port : 6767 }
}

/**
 * 绑的是不是只有本机能连到的地址。
 * ★这条判断决定「要不要强制令牌」—— 判错的后果是**一个不需要任何凭据、能控制整台机器的公网端口**,
 * 所以宁可保守:只认明确的回环写法,别的一律当成对外。
 */
const LOOPBACK_NAMES = new Set(['localhost', '::1', '0:0:0:0:0:0:0:1'])
/** 严格四段 127.x.x.x。★不能用 `startsWith('127.')` —— 那会把 `127.0.0.1.evil.com` 判成回环。 */
const IPV4_LOOPBACK = /^127(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/

export function isLoopback(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '')
  return LOOPBACK_NAMES.has(h) || IPV4_LOOPBACK.test(h)
}

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

// socket 双向挑战应答(PROTOCOL_VERSION 3):token 只用作 HMAC 密钥,本身不上线路。
// 1. 客户端 → auth.challenge {clientNonce}
// 2. 服务端 → {serverNonce, proof: serverProof}   客户端先校验,不对就断开、绝不发自己的 proof
// 3. 客户端 → auth.verify {proof: clientProof}    服务端校验通过才处理其他方法

const NONCE_RE = /^[A-Za-z0-9_-]{43}$/

/** 32 字节随机数,base64url(43 字符) */
export function newNonce(): string {
  return randomBytes(32).toString('base64url')
}

export function isNonce(s: unknown): s is string {
  return typeof s === 'string' && NONCE_RE.test(s)
}

const hmac = (token: string, msg: string): string =>
  createHmac('sha256', Buffer.from(token, 'utf8')).update(msg, 'utf8').digest('base64url')

/** 服务端证明自己知道 token */
export function serverProof(token: string, clientNonce: string, serverNonce: string): string {
  return hmac(token, `mffai-server|${clientNonce}|${serverNonce}`)
}

/** 客户端证明自己知道 token;标签不同,服务端 proof 不能拿来冒充 */
export function clientProof(token: string, serverNonce: string, clientNonce: string): string {
  return hmac(token, `mffai-client|${serverNonce}|${clientNonce}`)
}

/** 常数时间比较;长度不同 / 非字符串直接 false */
export function proofEquals(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const x = Buffer.from(a, 'utf8')
  const y = Buffer.from(b, 'utf8')
  return x.length === y.length && timingSafeEqual(x, y)
}

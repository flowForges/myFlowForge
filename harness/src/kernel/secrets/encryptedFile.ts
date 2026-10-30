import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { parseMap } from './plainFile'

// credentials.enc = { v:1, iv, tag, data }(base64),AES-256-GCM 加密整个 { key: value } 映射

export function encryptMap(key: Buffer, map: Record<string, string>): string {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([c.update(JSON.stringify(map), 'utf8'), c.final()])
  return JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') })
}

/** 主密钥不对 / 文件被改 → 抛错 */
export function decryptMap(key: Buffer, text: string): Record<string, string> {
  const j = JSON.parse(text) as { v?: unknown; iv?: unknown; tag?: unknown; data?: unknown }
  if (j.v !== 1 || typeof j.iv !== 'string' || typeof j.tag !== 'string' || typeof j.data !== 'string') throw new Error('bad format')
  const iv = Buffer.from(j.iv, 'base64')
  const tag = Buffer.from(j.tag, 'base64')
  // Node 接受截短的 tag(4 字节即 2^32 强度):只认 12 字节 iv + 16 字节 tag
  if (iv.length !== 12 || tag.length !== 16) throw new Error('bad iv/tag length')
  const d = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 })
  d.setAuthTag(tag)
  return parseMap(Buffer.concat([d.update(Buffer.from(j.data, 'base64')), d.final()]).toString('utf8'))
}

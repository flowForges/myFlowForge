// id_token 校验:RS256 + JWKS,只用 node:crypto(spec §9)
import { createPublicKey, verify, type webcrypto } from 'node:crypto'
type JsonWebKey = webcrypto.JsonWebKey

export const ISSUER = 'https://auth.openai.com'
const LEEWAY_S = 60

export interface Jwks { keys: (JsonWebKey & { kid?: string; alg?: string; use?: string })[] }

export interface Claims {
  iss: string
  sub: string
  aud: string | string[]
  exp: number
  nonce?: string
  email?: string
  [k: string]: unknown
}

export class IdTokenError extends Error {
  constructor(reason: string) {
    super(`invalid id_token: ${reason}`)
    this.name = 'IdTokenError'
  }
}

function part(s: string): Record<string, unknown> {
  const v = JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as unknown
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object')
  return v as Record<string, unknown>
}

/** 校验签名、iss、aud、exp、nonce、sub;失败抛 IdTokenError(消息不含 token) */
export function verifyIdToken(token: string, o: { jwks: Jwks; clientId: string; nonce: string; now?: number }): Claims {
  const parts = token.split('.')
  if (parts.length !== 3) throw new IdTokenError('malformed')
  const [h, p, s] = parts
  let header: Record<string, unknown>
  let claims: Record<string, unknown>
  try {
    header = part(h)
    claims = part(p)
  } catch {
    throw new IdTokenError('malformed')
  }
  if (header.alg !== 'RS256') throw new IdTokenError('unsupported alg')
  const keys = o.jwks.keys.filter(k => k.kty === 'RSA' && (!k.use || k.use === 'sig') && (!k.alg || k.alg === 'RS256'))
  // 有 kid 按 kid 取;无 kid 只在唯一候选时接受
  const jwk = typeof header.kid === 'string' ? keys.find(k => k.kid === header.kid) : keys.length === 1 ? keys[0] : undefined
  if (!jwk) throw new IdTokenError('unknown key')
  let ok = false
  try {
    ok = verify('RSA-SHA256', Buffer.from(`${h}.${p}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(s, 'base64url'))
  } catch {
    ok = false
  }
  if (!ok) throw new IdTokenError('bad signature')

  const nowS = (o.now ?? Date.now()) / 1000
  if (claims.iss !== ISSUER) throw new IdTokenError('issuer')
  const aud = claims.aud
  if (!(aud === o.clientId || (Array.isArray(aud) && aud.includes(o.clientId)))) throw new IdTokenError('audience')
  if (Array.isArray(aud) && aud.length > 1 && claims.azp !== o.clientId) throw new IdTokenError('azp')
  if (typeof claims.exp !== 'number' || claims.exp + LEEWAY_S <= nowS) throw new IdTokenError('expired')
  if (typeof claims.nbf === 'number' && claims.nbf - LEEWAY_S > nowS) throw new IdTokenError('not yet valid')
  if (claims.nonce !== o.nonce) throw new IdTokenError('nonce')
  if (typeof claims.sub !== 'string' || !claims.sub) throw new IdTokenError('subject')
  return claims as Claims
}

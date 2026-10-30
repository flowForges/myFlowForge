import { describe, expect, it } from 'vitest'
import { clientProof, isNonce, newNonce, proofEquals, serverProof } from './auth'

describe('challenge-response auth', () => {
  const T = 'a'.repeat(64)
  const cn = newNonce()
  const sn = newNonce()

  it('nonces are 32 random bytes in base64url', () => {
    expect(isNonce(cn)).toBe(true)
    expect(cn).not.toBe(sn)
    expect(Buffer.from(cn, 'base64url')).toHaveLength(32)
  })

  it('isNonce rejects anything but 43 base64url chars', () => {
    for (const bad of ['', 'a'.repeat(42), 'a'.repeat(44), 'a'.repeat(42) + '=', 'a'.repeat(42) + '+', 'a'.repeat(42) + '/', 1, null, undefined, {}]) {
      expect(isNonce(bad as never)).toBe(false)
    }
    expect(isNonce('A-_' + 'z'.repeat(40))).toBe(true)
  })

  it('proofs are deterministic, base64url, and differ by label', () => {
    expect(serverProof(T, cn, sn)).toBe(serverProof(T, cn, sn))
    expect(serverProof(T, cn, sn)).toMatch(/^[A-Za-z0-9_-]{43}$/)
    // 同样的两个 nonce 顺序也一样时,只靠标签区分:服务端 proof 不能拿来当客户端 proof
    expect(clientProof(T, cn, sn)).not.toBe(serverProof(T, cn, sn))
  })

  it('proofs differ by argument order and by token', () => {
    expect(serverProof(T, cn, sn)).not.toBe(serverProof(T, sn, cn))
    expect(clientProof(T, sn, cn)).not.toBe(clientProof(T, cn, sn))
    expect(serverProof(T, cn, sn)).not.toBe(serverProof('b'.repeat(64), cn, sn))
  })

  it('proofEquals: equal / unequal / length mismatch / non-strings', () => {
    const p = serverProof(T, cn, sn)
    expect(proofEquals(p, p.slice())).toBe(true)
    expect(proofEquals(p, clientProof(T, sn, cn))).toBe(false)
    expect(proofEquals(p, p.slice(1))).toBe(false)
    expect(proofEquals(p, p + 'x')).toBe(false)
    expect(proofEquals(p, '')).toBe(false)
    expect(proofEquals(p, undefined as never)).toBe(false)
    expect(proofEquals(p, 42 as never)).toBe(false)
  })
})

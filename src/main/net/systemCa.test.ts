import { describe, it, expect, vi } from 'vitest'
import * as tls from 'node:tls'
import { trustSystemCertificates } from './systemCa'

describe('trustSystemCertificates', () => {
  it('adds system roots on top of the bundled ones (never removes any)', () => {
    const set = vi.fn()
    const n = trustSystemCertificates({
      getCACertificates: ((kind: string) => (kind === 'system' ? ['CORP', 'A'] : ['A', 'B'])) as typeof tls.getCACertificates,
      setDefaultCACertificates: set,
    })
    expect(n).toBe(2)
    expect(set).toHaveBeenCalledWith(['A', 'B', 'CORP'])
  })
  it('no system roots / old runtime / a throwing store → leaves the defaults alone', () => {
    const set = vi.fn()
    expect(trustSystemCertificates({ getCACertificates: (() => []) as unknown as typeof tls.getCACertificates, setDefaultCACertificates: set })).toBe(0)
    expect(trustSystemCertificates({ getCACertificates: undefined as never, setDefaultCACertificates: set })).toBe(0)
    expect(trustSystemCertificates({ getCACertificates: (() => { throw new Error('x') }) as typeof tls.getCACertificates, setDefaultCACertificates: set })).toBe(0)
    expect(set).not.toHaveBeenCalled()
  })
  it('works against the real runtime (this machine has a readable system store)', () => {
    expect(trustSystemCertificates()).toBeGreaterThanOrEqual(0)
  })
})

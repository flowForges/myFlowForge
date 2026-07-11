import { describe, it, expect, vi } from 'vitest'

// Pretend the content Worker is configured so the happy paths run (the real NSFW_WORKER_URL ships empty).
vi.mock('../../shared/nsfw', () => ({
  NSFW_WORKER_URL: 'https://test.workers.dev',
  nsfwConfigured: () => true,
}))

import { nsfwValidate, nsfwCatalog, nsfwPreview, nsfwInstallPet, nsfwInstallBg, type NsfwFetch } from './nsfwService'

// Build a fake fetch from a route table keyed by "METHOD path-or-prefix".
function fakeFetch(handler: (url: string, init?: { method?: string }) => {
  ok: boolean; status: number; body?: unknown; bytes?: Uint8Array; ct?: string
}): NsfwFetch {
  return async (url, init) => {
    const r = handler(url, init)
    return {
      ok: r.ok,
      status: r.status,
      json: async () => r.body,
      arrayBuffer: async () => (r.bytes ?? new Uint8Array()).buffer as ArrayBuffer,
      headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? (r.ct ?? 'image/webp') : null) },
    }
  }
}

describe('nsfwValidate', () => {
  it('200 → ok', async () => {
    const f = fakeFetch(() => ({ ok: true, status: 200 }))
    expect(await nsfwValidate('CODE', f)).toEqual({ ok: true })
  })
  it('403 → 激活码无效', async () => {
    const f = fakeFetch(() => ({ ok: false, status: 403 }))
    expect(await nsfwValidate('CODE', f)).toEqual({ ok: false, error: '激活码无效' })
  })
  it('empty code rejected without a request', async () => {
    const f = vi.fn()
    expect(await nsfwValidate('   ', f as unknown as NsfwFetch)).toEqual({ ok: false, error: '请输入激活码' })
    expect(f).not.toHaveBeenCalled()
  })
  it('network error → friendly message', async () => {
    const f: NsfwFetch = async () => { throw new Error('net') }
    expect(await nsfwValidate('CODE', f)).toEqual({ ok: false, error: '无法连接内容服务' })
  })
})

describe('nsfwCatalog', () => {
  it('returns pets + backgrounds', async () => {
    const f = fakeFetch(() => ({ ok: true, status: 200, body: { pets: [{ id: 'a', name: 'A', states: ['idle'] }], backgrounds: [{ id: 'b', name: 'B' }] } }))
    expect(await nsfwCatalog('CODE', f)).toEqual({ pets: [{ id: 'a', name: 'A', states: ['idle'] }], backgrounds: [{ id: 'b', name: 'B' }] })
  })
  it('403 → re-activate error', async () => {
    const f = fakeFetch(() => ({ ok: false, status: 403 }))
    expect(await nsfwCatalog('CODE', f)).toEqual({ error: '激活码已失效,请重新激活' })
  })
  it('malformed body → empty arrays', async () => {
    const f = fakeFetch(() => ({ ok: true, status: 200, body: { junk: 1 } }))
    expect(await nsfwCatalog('CODE', f)).toEqual({ pets: [], backgrounds: [] })
  })
})

describe('nsfwPreview', () => {
  // The happy path writes a cache file to disk (storeBackgroundFromBytes) — covered by backgroundStore
  // tests; here we only assert the no-write error path.
  it('404 → error before writing', async () => {
    const f = fakeFetch(() => ({ ok: false, status: 404 }))
    expect(await nsfwPreview('pet', 'x', 'CODE', f)).toEqual({ error: '下载失败(404)' })
  })
})

describe('install error paths (no file writes)', () => {
  it('installPet: idle image 404 → error before writing', async () => {
    const f = fakeFetch(() => ({ ok: false, status: 404 }))
    const r = await nsfwInstallPet('pet-x', { id: 'a', name: 'A', states: ['idle'] }, 'CODE', f)
    expect('error' in r).toBe(true)
  })
  it('installBg: 404 → error before writing', async () => {
    const f = fakeFetch(() => ({ ok: false, status: 404 }))
    const r = await nsfwInstallBg({ id: 'b', name: 'B' }, 'CODE', f)
    expect(r).toEqual({ error: '下载失败(404)' })
  })
})

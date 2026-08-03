import { describe, it, expect, vi } from 'vitest'

// Pretend the content Worker is configured so the happy paths run (the real NSFW_WORKER_URL ships empty).
vi.mock('../../shared/nsfw', () => ({
  NSFW_WORKER_URL: 'https://test.workers.dev',
  nsfwConfigured: () => true,
}))

import { nsfwValidate, nsfwCatalog, nsfwPreview, nsfwGallery, parsePreviewFrame, nsfwInstallPet, nsfwInstallBg, type NsfwFetch, type RawFetch } from './nsfwService'

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
  it('a preview-cache HIT returns the cached file with ZERO network (no Cloudflare request)', async () => {
    let fetches = 0
    const f: NsfwFetch = async () => { fetches++; return { ok: true, status: 200, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0), headers: { get: () => 'image/jpeg' } } }
    // cache keyed by the Worker PATH (not the ?key= URL) — see nsfwPreview.
    const cache = { lookup: (k: string) => (k === 'content/bg/ns01' ? 'cached123.jpg' : null), record: () => {} }
    const r = await nsfwPreview('bg', 'ns01', 'CODE', f, cache)
    expect(r).toEqual({ url: 'forge-bg://img/cached123.jpg' })
    expect(fetches).toBe(0)                    // ← the whole point: no re-download on re-open
  })
})

describe('nsfwGallery (design E — streaming proxy, cache-first)', () => {
  // A raw fetch (returns Response-like) built from a per-URL route table.
  function rawFetchMock(handle: (url: string, init?: RequestInit) => { ok?: boolean; status?: number; json?: unknown; body?: ReadableStream | null }): { fetch: RawFetch; catalogUrls: string[]; posts: unknown[] } {
    const catalogUrls: string[] = []; const posts: unknown[] = []
    const fetch: RawFetch = async (url, init) => {
      if (url.includes('/catalog')) catalogUrls.push(url)
      if (url.includes('/previews') && init?.body) posts.push(JSON.parse(init.body as string))
      const r = handle(url, init)
      return { ok: r.ok ?? ((r.status ?? 200) < 400), status: r.status ?? 200, json: async () => r.json, body: r.body ?? null } as unknown as Response
    }
    return { fetch, catalogUrls, posts }
  }
  const CAT = { pets: [{ id: 'p1', name: 'P1', states: ['idle'] }], backgrounds: [{ id: 'b1', name: 'B1' }] }

  it('429 on /catalog → rateLimited (client greys out 刷新)', async () => {
    const { fetch } = rawFetchMock(() => ({ status: 429 }))
    expect(await nsfwGallery('CODE', fetch, undefined, () => {})).toEqual({ error: '刷新太频繁,请稍后再试', rateLimited: true })
  })
  it('403 on /catalog → re-activate error', async () => {
    const { fetch } = rawFetchMock(() => ({ status: 403 }))
    expect(await nsfwGallery('CODE', fetch, undefined, () => {})).toEqual({ error: '激活码已失效,请重新激活' })
  })
  it('cache-first: all thumbnails on disk → returns them, NEVER opens the /previews stream', async () => {
    const { fetch, catalogUrls, posts } = rawFetchMock((url) => (url.includes('/catalog') ? { json: CAT } : {}))
    const cache = { lookup: (k: string) => (k === 'content/pet/p1/idle' ? 'ap.webp' : k === 'content/bg/b1' ? 'ab.jpg' : null), record: () => {} }
    const r = await nsfwGallery('CODE', fetch, cache, () => {})
    if ('error' in r) throw new Error('unexpected: ' + r.error)
    expect(r.previews).toEqual({ 'pet:p1': 'forge-bg://img/ap.webp', 'bg:b1': 'forge-bg://img/ab.jpg' })
    expect(catalogUrls.length).toBe(1)
    await new Promise((res) => setTimeout(res, 0))
    expect(posts).toEqual([])                                    // nothing missing → no stream request
  })
  it('missing thumbnails → returns the cached ones immediately + streams ONLY the missing keys', async () => {
    const { fetch, posts } = rawFetchMock((url) => (url.includes('/catalog') ? { json: CAT } : { body: null }))
    const cache = { lookup: (k: string) => (k === 'content/bg/b1' ? 'ab.jpg' : null), record: () => {} } // p1 missing, b1 cached
    const r = await nsfwGallery('CODE', fetch, cache, () => {})
    if ('error' in r) throw new Error('unexpected: ' + r.error)
    expect(r.previews).toEqual({ 'bg:b1': 'forge-bg://img/ab.jpg' })  // cached returned right away
    await new Promise((res) => setTimeout(res, 0))                     // let the detached stream fire the POST
    expect(posts).toEqual([{ code: 'CODE', keys: ['pet:p1'] }])       // only the missing one requested
  })
  it('force re-streams everything (ignores cache): POSTs all keys', async () => {
    const { fetch, posts } = rawFetchMock((url) => (url.includes('/catalog') ? { json: CAT } : { body: null }))
    const cache = { lookup: () => 'x.webp', record: () => {} } // everything "cached", but force ignores it
    await nsfwGallery('CODE', fetch, cache, () => {}, { force: true })
    await new Promise((res) => setTimeout(res, 0))
    expect(posts).toEqual([{ code: 'CODE', keys: ['pet:p1', 'bg:b1'] }])
  })
})

describe('parsePreviewFrame (stream frame → disk + cache)', () => {
  it('decodes [extLen][ext][keyLen][key][img], stores the image, records the cache key, returns {key,url}', () => {
    const key = 'bg:x1', ext = 'webp', img = Buffer.from('IMGDATA')
    const extB = Buffer.from(ext), keyB = Buffer.from(key)
    const head = Buffer.alloc(1 + extB.length + 2 + keyB.length)
    head[0] = extB.length; extB.copy(head, 1); head.writeUInt16BE(keyB.length, 1 + extB.length); keyB.copy(head, 1 + extB.length + 2)
    const recorded: string[] = []
    const out = parsePreviewFrame(Buffer.concat([head, img]), { lookup: () => null, record: (k: string) => recorded.push(k) })
    expect(out?.key).toBe('bg:x1')
    expect(out?.url).toMatch(/^forge-bg:\/\/img\//)
    expect(recorded).toEqual(['content/bg/x1'])                  // same key nsfwPreview() looks up → cache hit later
  })
  it('empty image bytes → null (no store, no record)', () => {
    const head = Buffer.from([4, 0x77, 0x65, 0x62, 0x70, 0x00, 0x05, 0x62, 0x67, 0x3a, 0x78, 0x31]) // ext webp, key "bg:x1", no img
    expect(parsePreviewFrame(head, { lookup: () => null, record: () => { throw new Error('should not record') } })).toBeNull()
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

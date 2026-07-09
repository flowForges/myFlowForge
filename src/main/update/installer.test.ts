import { describe, it, expect, vi } from 'vitest'
import { ManualDmgInstaller, pickInstaller } from './installer'
import type { InstallerDeps } from './installer'
import type { UpdateInfo, InstallProgress } from '@shared/types'

const INFO: UpdateInfo = { version: '2.4.0', notes: '', dmgUrl: 'https://x/a.dmg', dmgSize: 6, dmgName: 'a.dmg' }

async function* twoChunks() {
  yield new Uint8Array([1, 2, 3])
  yield new Uint8Array([4, 5, 6])
}

// A fake writer that records bytes written + whether it appended (resume).
function fakeStore() {
  const files = new Map<string, number[]>()
  const appended: string[] = []
  const deps = {
    partSize: async (p: string) => files.get(p)?.length ?? 0,
    openWriter: (p: string, append: boolean) => {
      if (append) appended.push(p); else files.set(p, [])
      const buf = files.get(p) ?? (files.set(p, []), files.get(p)!)
      return { write: async (c: Uint8Array) => { buf.push(...c) }, close: async () => {} }
    },
    finalize: vi.fn(async () => {}),
    discard: vi.fn(async (p: string) => { files.delete(p) }),
  }
  return { files, appended, deps }
}

function deps(overrides: Partial<InstallerDeps> = {}): InstallerDeps {
  const store = fakeStore()
  return {
    fetch: async () => ({ ok: true, status: 200, headers: { get: () => '6' }, body: twoChunks() }),
    openPath: vi.fn(async () => ''),
    showItemInFolder: vi.fn(),
    join: (d, n) => `${d}/${n}`,
    tmpDir: '/tmp',
    ...store.deps,
    ...overrides,
  }
}

describe('ManualDmgInstaller', () => {
  it('streams to a .part file, finalizes to the dmg, opens it, reports terminal 100%', async () => {
    const d = deps()
    const seen: InstallProgress[] = []
    await new ManualDmgInstaller(d).run(INFO, p => seen.push(p))
    expect(d.finalize).toHaveBeenCalledWith('/tmp/a.dmg.part', '/tmp/a.dmg')
    expect(d.openPath).toHaveBeenCalledWith('/tmp/a.dmg')
    expect(d.showItemInFolder).toHaveBeenCalledWith('/tmp/a.dmg')
    expect(seen.at(-1)).toEqual({ stage: '正在打开安装器…', pct: 100 })
    expect(seen.some(p => p.stage === '正在下载更新包…')).toBe(true)
  })

  it('resumes from a partial .part: sends Range and appends (does not restart)', async () => {
    const store = fakeStore()
    store.files.set('/tmp/a.dmg.part', [1, 2, 3])   // 3 bytes already downloaded
    let sentRange: string | undefined
    const d = deps({
      ...store.deps,
      fetch: async (_url, init) => {
        sentRange = init?.headers?.Range
        return { ok: true, status: 206, headers: { get: () => '3' }, body: (async function* () { yield new Uint8Array([4, 5, 6]) })() }
      },
    })
    await new ManualDmgInstaller(d).run(INFO, () => {})
    expect(sentRange).toBe('bytes=3-')          // asked to continue from byte 3
    expect(store.appended).toContain('/tmp/a.dmg.part')   // appended, not truncated
    expect(store.files.get('/tmp/a.dmg.part')).toEqual([1, 2, 3, 4, 5, 6])
    expect(d.finalize).toHaveBeenCalled()
  })

  it('restarts cleanly when the server ignores Range (200 not 206)', async () => {
    const store = fakeStore()
    store.files.set('/tmp/a.dmg.part', [9, 9])   // stale partial
    const d = deps({
      ...store.deps,
      fetch: async () => ({ ok: true, status: 200, headers: { get: () => '6' }, body: twoChunks() }),
    })
    await new ManualDmgInstaller(d).run(INFO, () => {})
    expect(store.files.get('/tmp/a.dmg.part')).toEqual([1, 2, 3, 4, 5, 6])   // rewritten from scratch
  })

  it('throttles progress to integer-percent changes (no per-chunk flood)', async () => {
    const big: UpdateInfo = { ...INFO, dmgSize: 500 }
    const many = (async function* () { for (let i = 0; i < 500; i++) yield new Uint8Array([1]) })()
    const d = deps({ fetch: async () => ({ ok: true, status: 200, headers: { get: () => '500' }, body: many }) })
    const downloadEmits: InstallProgress[] = []
    await new ManualDmgInstaller(d).run(big, p => { if (p.pct < 95) downloadEmits.push(p) })
    expect(downloadEmits.length).toBeLessThanOrEqual(92)
  })

  it('throws (keeping the .part for resume) when the download ends short', async () => {
    const store = fakeStore()
    const d = deps({ ...store.deps, fetch: async () => ({ ok: true, status: 200, headers: { get: () => '6' }, body: (async function* () { yield new Uint8Array([1]) })() }) })
    await expect(new ManualDmgInstaller(d).run(INFO, () => {})).rejects.toThrow(/未完成/)
    expect(store.files.has('/tmp/a.dmg.part')).toBe(true)   // kept for a resume
  })

  it('throws on a non-ok download response', async () => {
    const d = deps({ fetch: async () => ({ ok: false, status: 500, headers: { get: () => null }, body: twoChunks() }) })
    await expect(new ManualDmgInstaller(d).run(INFO, () => {})).rejects.toThrow()
  })
})

describe('pickInstaller', () => {
  it('returns a ManualDmgInstaller for now', () => {
    expect(pickInstaller(deps())).toBeInstanceOf(ManualDmgInstaller)
  })
})

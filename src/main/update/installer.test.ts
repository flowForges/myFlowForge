import { describe, it, expect, vi } from 'vitest'
import { ManualDmgInstaller, pickInstaller } from './installer'
import type { InstallerDeps } from './installer'
import type { UpdateInfo, InstallProgress } from '@shared/types'

const INFO: UpdateInfo = { version: '2.4.0', notes: '', dmgUrl: 'https://x/a.dmg', dmgSize: 6, dmgName: 'a.dmg' }

async function* twoChunks() {
  yield new Uint8Array([1, 2, 3])
  yield new Uint8Array([4, 5, 6])
}

function deps(overrides: Partial<InstallerDeps> = {}): InstallerDeps {
  return {
    fetch: async () => ({ ok: true, headers: { get: () => '6' }, body: twoChunks() }),
    writeFile: vi.fn(async () => {}),
    openPath: vi.fn(async () => ''),
    showItemInFolder: vi.fn(),
    join: (d, n) => `${d}/${n}`,
    tmpDir: '/tmp',
    ...overrides,
  }
}

describe('ManualDmgInstaller', () => {
  it('downloads, writes, opens, and reports terminal 100%', async () => {
    const d = deps()
    const seen: InstallProgress[] = []
    await new ManualDmgInstaller(d).run(INFO, p => seen.push(p))
    expect(d.writeFile).toHaveBeenCalledWith('/tmp/a.dmg', expect.any(Uint8Array))
    expect(d.openPath).toHaveBeenCalledWith('/tmp/a.dmg')
    expect(d.showItemInFolder).toHaveBeenCalledWith('/tmp/a.dmg')
    expect(seen.at(-1)).toEqual({ stage: '正在打开安装器…', pct: 100 })
    expect(seen.some(p => p.stage === '正在下载更新包…')).toBe(true)
  })
  it('throttles progress to integer-percent changes (no per-chunk flood)', async () => {
    // 500 tiny 1-byte chunks over a 500-byte download → percent changes at most ~91 times,
    // NOT 500. This guards the CPU/fan fix from regressing back to per-chunk emission.
    const big: UpdateInfo = { ...INFO, dmgSize: 500 }
    const many = (async function* () { for (let i = 0; i < 500; i++) yield new Uint8Array([1]) })()
    const d = deps({ fetch: async () => ({ ok: true, headers: { get: () => '500' }, body: many }) })
    const downloadEmits: InstallProgress[] = []
    await new ManualDmgInstaller(d).run(big, p => { if (p.pct < 95) downloadEmits.push(p) })
    expect(downloadEmits.length).toBeLessThanOrEqual(92)
  })
  it('throws when the downloaded size does not match', async () => {
    const d = deps({ fetch: async () => ({ ok: true, headers: { get: () => '6' }, body: (async function* () { yield new Uint8Array([1]) })() }) })
    await expect(new ManualDmgInstaller(d).run(INFO, () => {})).rejects.toThrow(/校验/)
  })
  it('throws on a non-ok download response', async () => {
    const d = deps({ fetch: async () => ({ ok: false, headers: { get: () => null }, body: twoChunks() }) })
    await expect(new ManualDmgInstaller(d).run(INFO, () => {})).rejects.toThrow()
  })
})

describe('pickInstaller', () => {
  it('returns a ManualDmgInstaller for now', () => {
    expect(pickInstaller(deps())).toBeInstanceOf(ManualDmgInstaller)
  })
})

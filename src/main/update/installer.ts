import type { UpdateInfo, InstallProgress } from '@shared/types'

export interface UpdateInstaller {
  run(info: UpdateInfo, onProgress: (p: InstallProgress) => void): Promise<void>
}

// Streams the download to a temp file so the whole DMG never sits in memory (buffering a 170MB dmg +
// its final copy spiked ~340MB and made the machine lag), and supports RESUME: a partial `.part` file
// is continued with a Range request instead of restarting from zero.
export interface DownloadWriter {
  write(chunk: Uint8Array): Promise<void>
  close(): Promise<void>
}

export interface InstallerDeps {
  // `init.headers` carries the Range header for a resume; `status` distinguishes 206 (partial) from 200.
  fetch: (url: string, init?: { headers?: Record<string, string> }) => Promise<{
    ok: boolean; status: number; headers: { get(n: string): string | null }; body: AsyncIterable<Uint8Array>
  }>
  join: (dir: string, name: string) => string
  tmpDir: string
  openPath: (p: string) => Promise<string>
  showItemInFolder: (p: string) => void
  // Resume + streaming primitives (injectable for tests).
  partSize: (path: string) => Promise<number>                    // bytes already on disk, 0 if none
  openWriter: (path: string, append: boolean) => DownloadWriter  // append=true → resume
  finalize: (from: string, to: string) => Promise<void>          // rename .part → final dmg
  discard: (path: string) => Promise<void>                       // delete a stale/corrupt .part
}

export class ManualDmgInstaller implements UpdateInstaller {
  constructor(private deps: InstallerDeps) {}

  async run(info: UpdateInfo, onProgress: (p: InstallProgress) => void): Promise<void> {
    const dest = this.deps.join(this.deps.tmpDir, info.dmgName)
    const part = `${dest}.part`
    const total = info.dmgSize || 0

    // How many bytes we already have from a previous interrupted attempt.
    let received = await this.deps.partSize(part).catch(() => 0)
    if (total > 0 && received >= total) { received = 0; await this.deps.discard(part).catch(() => {}) }

    const init = received > 0 ? { headers: { Range: `bytes=${received}-` } } : undefined
    const res = await this.deps.fetch(info.dmgUrl, init)
    if (!res.ok) throw new Error('下载失败:服务器返回错误')
    // Asked to resume but the server ignored Range (200, not 206) → start clean from 0.
    const resuming = received > 0 && res.status === 206
    if (received > 0 && !resuming) { received = 0; await this.deps.discard(part).catch(() => {}) }

    const pctOf = (n: number) => (total > 0 ? Math.min(90, Math.floor((n / total) * 90)) : 0)
    onProgress({ stage: resuming ? '继续下载更新包…' : '正在下载更新包…', pct: pctOf(received), log: `拉取 ${info.dmgName}` })

    // A 170MB dmg yields thousands of chunks; only emit when the integer percent changes (≤91 updates).
    const writer = this.deps.openWriter(part, resuming)
    let lastPct = -1
    try {
      for await (const chunk of res.body) {
        await writer.write(chunk)
        received += chunk.length
        const pct = pctOf(received)
        if (pct !== lastPct) { lastPct = pct; onProgress({ stage: '正在下载更新包…', pct }) }
      }
    } finally {
      await writer.close()
    }

    onProgress({ stage: '校验完整性…', pct: 95, log: '校验下载大小' })
    if (total > 0 && received !== total) {
      // Ended early → KEEP the .part so the next attempt resumes. Only an over-size is corruption.
      if (received > total) await this.deps.discard(part).catch(() => {})
      throw new Error(`下载未完成(${received}/${total}),重试可断点续传`)
    }

    await this.deps.finalize(part, dest)
    await this.deps.openPath(dest)
    this.deps.showItemInFolder(dest)
    onProgress({ stage: '正在打开安装器…', pct: 100 })
  }
}

export function pickInstaller(deps: InstallerDeps): UpdateInstaller {
  // option 3（签名后）在此按 app.isPackaged && isSigned() 返回 AutoUpdater；现恒为手动。
  return new ManualDmgInstaller(deps)
}

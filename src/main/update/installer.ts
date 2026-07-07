import type { UpdateInfo, InstallProgress } from '@shared/types'

export interface UpdateInstaller {
  run(info: UpdateInfo, onProgress: (p: InstallProgress) => void): Promise<void>
}

export interface InstallerDeps {
  fetch: (url: string) => Promise<{ ok: boolean; headers: { get(n: string): string | null }; body: AsyncIterable<Uint8Array> }>
  writeFile: (path: string, data: Uint8Array) => Promise<void>
  openPath: (p: string) => Promise<string>
  showItemInFolder: (p: string) => void
  join: (dir: string, name: string) => string
  tmpDir: string
}

export class ManualDmgInstaller implements UpdateInstaller {
  constructor(private deps: InstallerDeps) {}

  async run(info: UpdateInfo, onProgress: (p: InstallProgress) => void): Promise<void> {
    const res = await this.deps.fetch(info.dmgUrl)
    if (!res.ok) throw new Error('下载失败:服务器返回错误')
    const total = Number(res.headers.get('content-length')) || info.dmgSize || 0
    const chunks: Uint8Array[] = []
    let received = 0
    onProgress({ stage: '正在下载更新包…', pct: 0, log: `拉取 ${info.dmgName}` })
    // A 170MB dmg yields thousands of chunks; emitting progress per-chunk floods IPC + React
    // re-renders and pins the CPU (fan spins up). Only emit when the integer percent changes,
    // capping the stream at ≤91 updates for the whole download.
    let lastPct = -1
    for await (const chunk of res.body) {
      chunks.push(chunk)
      received += chunk.length
      const pct = total > 0 ? Math.min(90, Math.floor((received / total) * 90)) : 0
      if (pct !== lastPct) {
        lastPct = pct
        onProgress({ stage: '正在下载更新包…', pct })
      }
    }
    const data = new Uint8Array(received)
    let offset = 0
    for (const c of chunks) { data.set(c, offset); offset += c.length }

    onProgress({ stage: '校验完整性…', pct: 95, log: '校验下载大小' })
    if (info.dmgSize > 0 && received !== info.dmgSize) {
      throw new Error(`下载校验失败:大小不符(${received}/${info.dmgSize})`)
    }

    const dest = this.deps.join(this.deps.tmpDir, info.dmgName)
    await this.deps.writeFile(dest, data)
    await this.deps.openPath(dest)
    this.deps.showItemInFolder(dest)
    onProgress({ stage: '正在打开安装器…', pct: 100 })
  }
}

export function pickInstaller(deps: InstallerDeps): UpdateInstaller {
  // option 3（签名后）在此按 app.isPackaged && isSigned() 返回 AutoUpdater；现恒为手动。
  return new ManualDmgInstaller(deps)
}

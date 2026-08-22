import { app, dialog, shell } from 'electron'
import { writeFile } from 'node:fs/promises'
import { showOsNotification } from '../notify/osNotify'
import type { HostCapabilities, PickOptions, SaveResult } from './capabilities'

function properties(o: PickOptions): ('openFile' | 'openDirectory' | 'multiSelections' | 'createDirectory')[] {
  const p: ('openFile' | 'openDirectory' | 'multiSelections' | 'createDirectory')[] =
    [o.kind === 'directory' ? 'openDirectory' : 'openFile']
  if (o.multi) p.push('multiSelections')
  if (o.createDirectory) p.push('createDirectory')
  return p
}

export function createElectronHost(): HostCapabilities {
  return {
    version: () => app.getVersion(),
    tempDir: () => app.getPath('temp'),
    appPath: () => app.getAppPath(),
    isPackaged: () => app.isPackaged,

    openExternal: async (url) => { await shell.openExternal(url) },
    // 原样透出 shell.openPath 的「失败返回字符串」契约,见接口注释。
    openPath: (p) => shell.openPath(p),
    revealInFileManager: (p) => shell.showItemInFolder(p),

    async pickPaths(o) {
      const r = await dialog.showOpenDialog({
        properties: properties(o),
        ...(o.title ? { title: o.title } : {}),
        ...(o.filters ? { filters: o.filters } : {}),
      })
      // 取消必须是 []:调用方一律取 [0],undefined 会当场抛,而取消是最常走的那条路。
      return r.canceled ? [] : r.filePaths
    },

    async saveFile(defaultName, data, title): Promise<SaveResult> {
      const r = await dialog.showSaveDialog({ defaultPath: defaultName, ...(title ? { title } : {}) })
      if (r.canceled || !r.filePath) return { ok: false, canceled: true }
      try { await writeFile(r.filePath, data as never, 'utf8'); return { ok: true, path: r.filePath } }
      catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) } }
    },

    // 不另写一份。osNotify 里已经埋了两个踩出来的坑:macOS 上 Notification 被 GC 掉就静默不弹、
    // Windows 上没设 setAppUserModelId 会把通知整批丢弃。
    notify: (n) => showOsNotification({ title: n.title, body: n.body, route: { workspacePath: '' } }, n.onClick ?? (() => {})),

    async fileIcon(p) {
      try { const img = await app.getFileIcon(p, { size: 'normal' }); return img.isEmpty() ? undefined : img.toDataURL() }
      catch { return undefined }
    },
  }
}

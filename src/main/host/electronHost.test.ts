import { describe, it, expect, vi, beforeEach } from 'vitest'

const { showOpenDialog, showSaveDialog, openPath, openExternal, showItemInFolder, getFileIcon, writeFileMock, showOsNotificationMock } = vi.hoisted(() => ({
  showOpenDialog: vi.fn(), showSaveDialog: vi.fn(),
  openPath: vi.fn(), openExternal: vi.fn(), showItemInFolder: vi.fn(), getFileIcon: vi.fn(),
  writeFileMock: vi.fn(), showOsNotificationMock: vi.fn(),
}))
vi.mock('electron', () => ({
  dialog: { showOpenDialog, showSaveDialog },
  shell: { openPath, openExternal, showItemInFolder },
  app: { getVersion: () => '1.1.2', getPath: (k: string) => `/tmp/${k}`, getAppPath: () => '/app', isPackaged: true, getFileIcon },
}))
vi.mock('node:fs/promises', () => ({ writeFile: (...a: unknown[]) => writeFileMock(...a) }))
vi.mock('../notify/osNotify', () => ({ showOsNotification: (...a: unknown[]) => showOsNotificationMock(...a) }))

import { createElectronHost } from './electronHost'

describe('createElectronHost', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('pickPaths 取消时返回空数组,不是 undefined', async () => {
    // 调用方全都写 `(await caps.pickPaths(…))[0]`。返回 undefined 会当场抛,
    // 而「用户按了取消」是最常走的一条路 —— 取消不该变成红字报错。
    showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    await expect(createElectronHost().pickPaths({ kind: 'directory' })).resolves.toEqual([])
  })

  it('目录模式把 kind / createDirectory 翻译成 Electron 的 properties', async () => {
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/x'] })
    await createElectronHost().pickPaths({ kind: 'directory', createDirectory: true })
    expect(showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({ properties: ['openDirectory', 'createDirectory'] }))
  })

  it('多选文件模式带上 multiSelections,并把全部路径带回来', async () => {
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/a', '/b'] })
    const r = await createElectronHost().pickPaths({ kind: 'file', multi: true })
    expect(showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({ properties: ['openFile', 'multiSelections'] }))
    expect(r).toEqual(['/a', '/b'])
  })

  it('filters 与 title 原样传给对话框(选宠物图/背景图靠它挡住非图片)', async () => {
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/a.png'] })
    const filters = [{ name: '图片', extensions: ['png', 'gif'] }]
    await createElectronHost().pickPaths({ kind: 'file', filters, title: '选一张' })
    expect(showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({ filters, title: '选一张' }))
  })

  it('没给 title/filters 时不要把 undefined 塞进对话框参数里', async () => {
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/x'] })
    await createElectronHost().pickPaths({ kind: 'file' })
    const arg = showOpenDialog.mock.calls[0]![0]
    expect('title' in arg).toBe(false)
    expect('filters' in arg).toBe(false)
  })

  it('openPath 成功回空串,失败把错误字符串原样带回来', async () => {
    // shell.openPath 的契约是「成功空串 / 失败返回描述」,不是抛。包装时把它变成 throw 或
    // 吞掉,都会让「打开失败」在界面上变成什么也没发生。
    openPath.mockResolvedValue('no such file')
    await expect(createElectronHost().openPath('/nope')).resolves.toBe('no such file')
  })

  it('saveFile 取消时不写盘,并报 canceled(而不是报错)', async () => {
    showSaveDialog.mockResolvedValue({ canceled: true })
    await expect(createElectronHost().saveFile('a.json', '{}', '导出')).resolves.toEqual({ ok: false, canceled: true })
    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it('saveFile 成功时把内容写到选中的路径,并把路径带回来给界面显示', async () => {
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/out/a.json' })
    await expect(createElectronHost().saveFile('a.json', '{"x":1}')).resolves.toEqual({ ok: true, path: '/out/a.json' })
    expect(writeFileMock).toHaveBeenCalledWith('/out/a.json', '{"x":1}', 'utf8')
  })

  it('saveFile 写盘抛异常时转成 {ok:false,error},不让 rejection 穿出去', async () => {
    // 盘满 ENOSPC / 无权 EPERM 是真实存在的。穿出去会变成渲染层的未处理 rejection:
    // 红字行不出现,用户看到的是「点了没反应」。
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/out/a.json' })
    writeFileMock.mockRejectedValue(new Error('ENOSPC: no space left on device'))
    await expect(createElectronHost().saveFile('a.json', '{}')).resolves.toMatchObject({ ok: false, error: expect.stringContaining('ENOSPC') })
  })

  it('fileIcon 拿到空图标时返回 undefined,让调用方回退到字形', async () => {
    getFileIcon.mockResolvedValue({ isEmpty: () => true, toDataURL: () => 'data:x' })
    await expect(createElectronHost().fileIcon('/App.app')).resolves.toBeUndefined()
  })

  it('fileIcon 抛异常时返回 undefined,不连累整个下拉列表', async () => {
    getFileIcon.mockRejectedValue(new Error('nope'))
    await expect(createElectronHost().fileIcon('/App.app')).resolves.toBeUndefined()
  })

  it('notify 走既有的 osNotify(那里埋着 macOS GC 和 Windows 静默丢弃两个坑)', () => {
    const onClick = vi.fn()
    createElectronHost().notify({ title: 't', body: 'b', onClick })
    expect(showOsNotificationMock).toHaveBeenCalledWith(expect.objectContaining({ title: 't', body: 'b' }), onClick)
  })

  it('没给 onClick 也不能炸 —— osNotify 会无条件调它', () => {
    createElectronHost().notify({ title: 't', body: 'b' })
    const cb = showOsNotificationMock.mock.calls[0]![1] as () => void
    expect(() => cb()).not.toThrow()
  })

  it('version / tempDir / appPath / isPackaged 直接答,不经过任何对话框', () => {
    const h = createElectronHost()
    expect(h.version()).toBe('1.1.2')
    expect(h.tempDir()).toBe('/tmp/temp')
    expect(h.appPath()).toBe('/app')
    expect(h.isPackaged()).toBe(true)
    expect(showOpenDialog).not.toHaveBeenCalled()
  })
})

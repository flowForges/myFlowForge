import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react'
import { PathPickerProvider, usePathPicker } from './PathPicker'
import type { HostStatusView } from '@shared/remote/hostView'

const hostListeners: ((s: HostStatusView) => void)[] = []
const LOCAL: HostStatusView = { hostId: null, label: '本机', state: { status: 'local' }, methods: [] }
const REMOTE: HostStatusView = { hostId: 'h1', label: '云服务器', state: { status: 'ready', version: '1.1.2', methods: [] }, methods: [] }

const pickDirectory = vi.fn(async () => '/local/dir')
const pickFile = vi.fn(async () => '/local/file')
const fsBrowse = vi.fn(async ({ path }: { path?: string }) => ({
  path: path || '/home/me',
  parent: path === '/' ? null : '/',
  entries: [
    { name: 'projects', path: '/home/me/projects', dir: true },
    { name: 'notes.txt', path: '/home/me/notes.txt', dir: false },
  ],
  isWorkspace: false,
}))
const fsBrowseRoots = vi.fn(async () => [{ name: '主目录', path: '/home/me', dir: true }])

beforeEach(() => {
  hostListeners.length = 0
  vi.clearAllMocks()
  ;(window as unknown as { forge: unknown }).forge = {
    pickDirectory, pickFile, fsBrowse, fsBrowseRoots,
    hostsStatus: vi.fn(async () => LOCAL),
    onHostStatus: (cb: (s: HostStatusView) => void) => { hostListeners.push(cb); return () => {} },
  }
})

let lastResult: string | null | undefined
function Probe({ kind }: { kind: 'directory' | 'file' }) {
  const { pick } = usePathPicker()
  return <button onClick={async () => { lastResult = await pick(kind) }}>选</button>
}
const setHost = async (s: HostStatusView) => { await act(async () => { hostListeners.forEach((l) => l(s)) }) }

describe('PathPicker', () => {
  it('★本机时走系统原生对话框(有收藏夹和搜索,体验比自己画的树好)', async () => {
    render(<PathPickerProvider><Probe kind="directory" /></PathPickerProvider>)
    await act(async () => { fireEvent.click(screen.getByText('选')) })
    expect(pickDirectory).toHaveBeenCalled()
    expect(fsBrowse).not.toHaveBeenCalled()
    expect(lastResult).toBe('/local/dir')
  })

  it('★连着远程主机时改用服务端目录浏览器 —— 本机对话框里根本没有那台机器的目录', async () => {
    render(<PathPickerProvider><Probe kind="directory" /></PathPickerProvider>)
    await setHost(REMOTE)
    await act(async () => { fireEvent.click(screen.getByText('选')) })
    await waitFor(() => expect(fsBrowse).toHaveBeenCalled())
    expect(pickDirectory).not.toHaveBeenCalled()
  })

  it('★浏览器要说清是在看哪台机器的文件系统', async () => {
    // 远程时最容易搞错的就是「这是谁的文件系统」。
    render(<PathPickerProvider><Probe kind="directory" /></PathPickerProvider>)
    await setHost(REMOTE)
    await act(async () => { fireEvent.click(screen.getByText('选')) })
    expect(await screen.findByText(/正在浏览「云服务器」上的目录/)).toBeInTheDocument()
  })

  it('选目录模式下不列文件;选文件模式下才列', async () => {
    const { unmount } = render(<PathPickerProvider><Probe kind="directory" /></PathPickerProvider>)
    await setHost(REMOTE)
    await act(async () => { fireEvent.click(screen.getByText('选')) })
    await waitFor(() => expect(fsBrowse).toHaveBeenCalledWith(expect.objectContaining({ filesToo: false })))
    unmount()

    hostListeners.length = 0
    render(<PathPickerProvider><Probe kind="file" /></PathPickerProvider>)
    await setHost(REMOTE)
    await act(async () => { fireEvent.click(screen.getByText('选')) })
    await waitFor(() => expect(fsBrowse).toHaveBeenCalledWith(expect.objectContaining({ filesToo: true })))
  })

  it('点「选择这个目录」把当前路径交回去', async () => {
    render(<PathPickerProvider><Probe kind="directory" /></PathPickerProvider>)
    await setHost(REMOTE)
    await act(async () => { fireEvent.click(screen.getByText('选')) })
    const btn = await screen.findByText(/选择这个目录/)
    await act(async () => { fireEvent.click(btn) })
    expect(lastResult).toBe('/home/me')
  })

  it('★取消要 resolve 成 null,而不是让那个 promise 永远挂着', async () => {
    // 挂着的话调用方(比如「新建工作区」向导)就卡在那一步,而界面上什么都不剩。
    render(<PathPickerProvider><Probe kind="directory" /></PathPickerProvider>)
    await setHost(REMOTE)
    await act(async () => { fireEvent.click(screen.getByText('选')) })
    const cancel = await screen.findByText('取消')
    await act(async () => { fireEvent.click(cancel) })
    expect(lastResult).toBeNull()
  })

  it('Esc 也能取消', async () => {
    render(<PathPickerProvider><Probe kind="directory" /></PathPickerProvider>)
    await setHost(REMOTE)
    await act(async () => { fireEvent.click(screen.getByText('选')) })
    await screen.findByText('取消')
    await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }) })
    expect(lastResult).toBeNull()
  })

  it('★没有 provider 时退回原生对话框,不抛 —— 宠物窗和一堆测试都不在 provider 里', async () => {
    render(<Probe kind="file" />)
    await act(async () => { fireEvent.click(screen.getByText('选')) })
    expect(pickFile).toHaveBeenCalled()
    expect(lastResult).toBe('/local/file')
  })
})

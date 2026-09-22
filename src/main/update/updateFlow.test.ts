import { describe, it, expect, vi } from 'vitest'
import { createUpdateFlow, type UpdateFlowDeps } from './updateFlow'
import type { UpdateBusyItem } from '@shared/types'

const INFO = { version: '1.2.3', notes: '', assetUrl: 'u', assetSize: 1, assetName: 'myFlowForge-1.2.3-arm64.dmg' }
const CHAT: UpdateBusyItem = { kind: 'chat', workspacePath: '/ws/a', label: 'a · 修 bug' }

function setup(over: Partial<UpdateFlowDeps> = {}) {
  let busy: UpdateBusyItem[] = []
  let tick: (() => void) | null = null
  const d: UpdateFlowDeps = {
    listBusy: () => busy,
    planEnv: (assetName) => ({ platform: 'darwin', isPackaged: true, execPath: '/Applications/myFlowForge.app/Contents/MacOS/myFlowForge', assetName, canWrite: () => true }),
    pid: 4242,
    tmpDir: '/tmp',
    join: (a, b) => `${a}/${b}`,
    writeScript: vi.fn(async () => {}),
    spawnDetached: vi.fn(),
    quit: vi.fn(),
    openPath: vi.fn(async () => ''),
    reveal: vi.fn(),
    emitReady: vi.fn(),
    emitProgress: vi.fn(),
    emitDone: vi.fn(),
    emitError: vi.fn(),
    setInterval: vi.fn((fn: () => void) => { tick = fn; return 1 }),
    clearInterval: vi.fn(() => { tick = null }),
    setTimeout: (fn) => fn(),
    ...over,
  }
  const flow = createUpdateFlow(d)
  return { d, flow, setBusy: (b: UpdateBusyItem[]) => { busy = b }, tick: () => tick?.() }
}
const flush = () => new Promise(r => setTimeout(r, 0))

describe('updateFlow', () => {
  it('idle when the download finishes → installs right away (mac: detached script, then quit)', async () => {
    const { d, flow } = setup()
    flow.downloaded('/tmp/a.dmg', INFO)
    await flush()
    expect(d.writeScript).toHaveBeenCalledWith('/tmp/myflowforge-apply-update.sh', expect.stringContaining("TARGET='/Applications/myFlowForge.app'"))
    expect(d.spawnDetached).toHaveBeenCalledWith('/bin/sh', ['/tmp/myflowforge-apply-update.sh'])
    expect(d.quit).toHaveBeenCalled()
    expect(d.openPath).not.toHaveBeenCalled()
    expect(d.emitReady).not.toHaveBeenCalled()
  })

  it('windows: runs the setup exe silently with --updated --force-run', async () => {
    const { d, flow } = setup({ planEnv: (assetName) => ({ platform: 'win32', isPackaged: true, execPath: 'C:\\x\\myFlowForge.exe', assetName, canWrite: () => true }) })
    flow.downloaded('C:\\t\\s.exe', { ...INFO, assetName: 'myFlowForge-1.2.3-x64-setup.exe' })
    await flush()
    expect(d.spawnDetached).toHaveBeenCalledWith('C:\\t\\s.exe', ['/S', '--updated', '--force-run'])
    expect(d.quit).toHaveBeenCalled()
  })

  it('busy when the download finishes → does NOT quit, reports what is running', async () => {
    const { d, flow, setBusy } = setup()
    setBusy([CHAT])
    flow.downloaded('/tmp/a.dmg', INFO)
    await flush()
    expect(d.emitReady).toHaveBeenCalledWith([CHAT], false)
    expect(d.spawnDetached).not.toHaveBeenCalled()
    expect(d.quit).not.toHaveBeenCalled()
    expect(flow.pending()).toBe(true)
  })

  it('"wait" installs as soon as everything finishes — and not before', async () => {
    const { d, flow, setBusy, tick } = setup()
    setBusy([CHAT])
    flow.downloaded('/tmp/a.dmg', INFO)
    flow.apply('wait')
    expect(d.emitReady).toHaveBeenLastCalledWith([CHAT], true)
    tick(); await flush()
    expect(d.quit).not.toHaveBeenCalled()
    setBusy([])
    tick(); await flush()
    expect(d.quit).toHaveBeenCalledTimes(1)
    expect(d.clearInterval).toHaveBeenCalled()
  })

  it('"cancel" stops waiting; "force" installs even while busy', async () => {
    const { d, flow, setBusy, tick } = setup()
    setBusy([CHAT])
    flow.downloaded('/tmp/a.dmg', INFO)
    flow.apply('wait')
    flow.apply('cancel')
    setBusy([]); tick(); await flush()
    expect(d.quit).not.toHaveBeenCalled()
    setBusy([CHAT])
    flow.apply('force'); await flush()
    expect(d.quit).toHaveBeenCalledTimes(1)
  })

  it('"now" re-checks at click time (a session started during the download blocks it)', async () => {
    const { d, flow, setBusy } = setup()
    setBusy([CHAT])
    flow.downloaded('/tmp/a.dmg', INFO)
    flow.apply('now'); await flush()
    expect(d.quit).not.toHaveBeenCalled()
    setBusy([])
    flow.apply('now'); await flush()
    expect(d.quit).toHaveBeenCalledTimes(1)
  })

  it('cannot replace in place (e.g. running from the dmg) → falls back to opening the installer, never quits', async () => {
    const { d, flow } = setup({ planEnv: (assetName) => ({ platform: 'darwin', isPackaged: true, execPath: '/Volumes/x/myFlowForge.app/Contents/MacOS/myFlowForge', assetName, canWrite: () => true }) })
    flow.downloaded('/tmp/a.dmg', INFO)
    await flush()
    expect(d.openPath).toHaveBeenCalledWith('/tmp/a.dmg')
    expect(d.emitDone).toHaveBeenCalled()
    expect(d.quit).not.toHaveBeenCalled()
  })

  it('a failed hand-off reports an error and keeps the app running', async () => {
    const { d, flow } = setup({ writeScript: vi.fn(async () => { throw new Error('EACCES') }) })
    flow.downloaded('/tmp/a.dmg', INFO)
    await flush()
    expect(d.emitError).toHaveBeenCalledWith(expect.stringContaining('EACCES'))
    expect(d.quit).not.toHaveBeenCalled()
  })

  it('does nothing before a download exists', () => {
    const { d, flow } = setup()
    flow.apply('force')
    expect(d.spawnDetached).not.toHaveBeenCalled()
    expect(flow.pending()).toBe(false)
  })
})

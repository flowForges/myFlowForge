import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CH } from './channels'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, dialog: {}, app: { getVersion: () => '0', getPath: () => '/tmp' }, shell: {} }))
vi.mock('../orchestrator/orchestrator', () => ({ Orchestrator: class { startRun() {} getRun() { return null } } }))
vi.mock('../sessionImport/sources/index', () => ({
  scanAll: () => ([{ source: 'claude', externalId: 'a', cwd: '/other', title: 't', startedAt: 1, lastTs: 1, messageCount: 2, filePaths: ['/f'], hasBody: true }]),
  readSession: () => ([{ who: 'user', text: 'hi', ts: '' }]),
}))
const imported: string[] = []
vi.mock('../sessionImport/importWorkspace', () => ({ importWorkspace: (c: string) => imported.push(c) }))
vi.mock('../sessionImport/importStore', () => ({ readIndex: () => ({ version: 1, scannedAt: 0, sessions: [] }), upsertSessions: (s: any[], at: number) => ({ version: 1, scannedAt: at, sessions: s }) }))
vi.mock('../config/store', async (orig) => ({ ...(await orig() as object), readWorkspaceRegistry: () => [] }))

async function invoke(channel: string, ...args: unknown[]) {
  const { ipcMain } = await import('electron') as any
  const call = ipcMain.handle.mock.calls.find((c: any[]) => c[0] === channel)
  if (!call) throw new Error(`no handler ${channel}`)
  return call[1]({}, ...args)
}

describe('session import IPC', () => {
  beforeEach(async () => { imported.length = 0; const { ipcMain } = await import('electron') as any; ipcMain.handle.mockClear() })
  it('scan returns grouped result; unmatched cwd → own group', async () => {
    const { registerIpc } = await import('./handlers')
    registerIpc(() => {}, {})
    const res = await invoke(CH.sessionImportScan)
    expect(res.groups[0].wsPath).toBe('/other')
    expect(res.groups[0].matched).toBe(false)
  })
  it('run upserts + registers lightweight ws for unmatched cwd', async () => {
    const { registerIpc } = await import('./handlers')
    registerIpc(() => {}, {})
    const session = { source: 'claude', externalId: 'a', cwd: '/other', title: 't', startedAt: 1, lastTs: 1, messageCount: 2, filePaths: ['/f'], hasBody: true }
    await invoke(CH.sessionImportRun, [session])
    expect(imported).toEqual(['/other'])
  })
  it('run broadcasts workspacesChanged so the sidebar refreshes live', async () => {
    const { registerIpc } = await import('./handlers')
    const broadcast = vi.fn()
    registerIpc(broadcast, {})
    const session = { source: 'claude', externalId: 'a', cwd: '/other', title: 't', startedAt: 1, lastTs: 1, messageCount: 2, filePaths: ['/f'], hasBody: true }
    await invoke(CH.sessionImportRun, [session])
    expect(broadcast).toHaveBeenCalledWith(CH.workspacesChanged, {})
  })
  it('read dispatches to adapter', async () => {
    const { registerIpc } = await import('./handlers')
    registerIpc(() => {}, {})
    const msgs = await invoke(CH.sessionImportRead, { source: 'claude', filePaths: ['/f'] })
    expect(msgs[0].text).toBe('hi')
  })
})

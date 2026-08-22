import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CH } from './channels'
import { tableCalls } from './testTable'

// registerIpc 现在返回方法表,不再往 ipcMain 上挂。tableCalls 把它摊成旧 mock.calls 的形状,
// 于是下面的 invoke() 一行不用改。
let calls: [string, (e: unknown, ...a: any[]) => any][] = []

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, dialog: {}, app: { getVersion: () => '0', getPath: () => '/tmp' }, shell: {} }))
vi.mock('../sessionImport/sources/index', () => ({
  scanAll: () => ([{ source: 'claude', externalId: 'a', cwd: '/other', title: 't', startedAt: 1, lastTs: 1, messageCount: 2, filePaths: ['/f'], hasBody: true }]),
  readSession: () => ([{ who: 'user', text: 'hi', ts: '' }]),
}))
const imported: string[] = []
vi.mock('../sessionImport/importWorkspace', () => ({ importWorkspace: (c: string) => imported.push(c) }))
vi.mock('../sessionImport/importStore', () => ({ readIndex: () => ({ version: 1, scannedAt: 0, sessions: [] }), upsertSessions: (s: any[], at: number) => ({ version: 1, scannedAt: at, sessions: s }) }))
vi.mock('../config/store', async (orig) => ({ ...(await orig() as object), readWorkspaceRegistry: () => [] }))

async function invoke(channel: string, ...args: unknown[]) {
  const call = calls.find((c) => c[0] === channel)
  if (!call) throw new Error(`no handler ${channel}`)
  return call[1]({}, ...args)
}

describe('session import IPC', () => {
  beforeEach(() => { imported.length = 0; calls = [] })
  it('scan returns grouped result; unmatched cwd → own group', async () => {
    const { registerIpc } = await import('./handlers')
    calls = tableCalls(registerIpc(() => {}, {}))
    const res = await invoke(CH.sessionImportScan)
    expect(res.groups[0].wsPath).toBe('/other')
    expect(res.groups[0].matched).toBe(false)
  })
  it('run upserts + registers lightweight ws for unmatched cwd', async () => {
    const { registerIpc } = await import('./handlers')
    calls = tableCalls(registerIpc(() => {}, {}))
    const session = { source: 'claude', externalId: 'a', cwd: '/other', title: 't', startedAt: 1, lastTs: 1, messageCount: 2, filePaths: ['/f'], hasBody: true }
    await invoke(CH.sessionImportRun, [session])
    expect(imported).toEqual(['/other'])
  })
  it('run broadcasts workspacesChanged so the sidebar refreshes live', async () => {
    const { registerIpc } = await import('./handlers')
    const broadcast = vi.fn()
    calls = tableCalls(registerIpc(broadcast, {}))
    const session = { source: 'claude', externalId: 'a', cwd: '/other', title: 't', startedAt: 1, lastTs: 1, messageCount: 2, filePaths: ['/f'], hasBody: true }
    await invoke(CH.sessionImportRun, [session])
    expect(broadcast).toHaveBeenCalledWith(CH.workspacesChanged, {})
  })
  it('read dispatches to adapter', async () => {
    const { registerIpc } = await import('./handlers')
    calls = tableCalls(registerIpc(() => {}, {}))
    const msgs = await invoke(CH.sessionImportRead, { source: 'claude', filePaths: ['/f'] })
    expect(msgs[0].text).toBe('hi')
  })
})

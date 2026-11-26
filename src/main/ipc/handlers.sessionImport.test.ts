import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CH } from './channels'
import { fakeHost } from '../host/fakeHost'
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
const continued: any[] = []
const takenWs = mkdtempSync(join(tmpdir(), 'si-ws-'))
afterAll(() => rmSync(takenWs, { recursive: true, force: true }))
vi.mock('../sessionImport/takeover', () => ({
  continueExternal: async (s: any, d: any) => { continued.push([s, d]); return { ok: true, wsPath: takenWs, sessionId: 's-1', created: true, wsAdded: true } },
  canContinue: async (s: any) => s.source !== 'cursor',
}))
vi.mock('../config/store', async (orig) => ({ ...(await orig() as object), readWorkspaceRegistry: () => [] }))

async function invoke(channel: string, ...args: unknown[]) {
  const call = calls.find((c) => c[0] === channel)
  if (!call) throw new Error(`no handler ${channel}`)
  return call[1]({}, ...args)
}

describe('session import IPC', () => {
  beforeEach(() => { imported.length = 0; continued.length = 0; calls = [] })
  it('scan returns grouped result; unmatched cwd → own group', async () => {
    const { registerIpc } = await import('./handlers')
    calls = tableCalls(registerIpc(() => {}, {}, fakeHost()))
    const res = await invoke(CH.sessionImportScan)
    expect(res.groups[0].wsPath).toBe('/other')
    expect(res.groups[0].matched).toBe(false)
  })
  it('run upserts + registers lightweight ws for unmatched cwd', async () => {
    const { registerIpc } = await import('./handlers')
    calls = tableCalls(registerIpc(() => {}, {}, fakeHost()))
    const session = { source: 'claude', externalId: 'a', cwd: '/other', title: 't', startedAt: 1, lastTs: 1, messageCount: 2, filePaths: ['/f'], hasBody: true }
    await invoke(CH.sessionImportRun, [session])
    expect(imported).toEqual(['/other'])
  })
  it('run broadcasts workspacesChanged so the sidebar refreshes live', async () => {
    const { registerIpc } = await import('./handlers')
    const broadcast = vi.fn()
    calls = tableCalls(registerIpc(broadcast, {}, fakeHost()))
    const session = { source: 'claude', externalId: 'a', cwd: '/other', title: 't', startedAt: 1, lastTs: 1, messageCount: 2, filePaths: ['/f'], hasBody: true }
    await invoke(CH.sessionImportRun, [session])
    expect(broadcast).toHaveBeenCalledWith(CH.workspacesChanged, {})
  })
  it('read dispatches to adapter', async () => {
    const { registerIpc } = await import('./handlers')
    calls = tableCalls(registerIpc(() => {}, {}, fakeHost()))
    const msgs = await invoke(CH.sessionImportRead, { source: 'claude', filePaths: ['/f'] })
    expect(msgs[0].text).toBe('hi')
  })
  it('continue takes the session over, refreshes the sidebar and the session list, and returns where it lives', async () => {
    const { registerIpc } = await import('./handlers')
    const broadcast = vi.fn()
    calls = tableCalls(registerIpc(broadcast, {}, fakeHost()))
    const session = { source: 'codex', externalId: 'x1', cwd: '/other', title: 't', startedAt: 1, lastTs: 1, messageCount: 2, filePaths: ['/f'], hasBody: true }
    const r = await invoke(CH.sessionImportContinue, session)
    expect(r).toEqual({ ok: true, wsPath: takenWs, sessionId: 's-1', created: true, wsAdded: true })
    expect(continued[0][0]).toMatchObject({ source: 'codex', externalId: 'x1' })
    expect(typeof continued[0][1].defaultModel).toBe('function')
    expect(broadcast).toHaveBeenCalledWith(CH.workspacesChanged, {})
    expect(broadcast).toHaveBeenCalledWith(CH.sessionsChanged, expect.objectContaining({ workspacePath: takenWs }))
  })
  it('scan marks which sessions can be continued in place', async () => {
    const { registerIpc } = await import('./handlers')
    calls = tableCalls(registerIpc(() => {}, {}, fakeHost()))
    const res = await invoke(CH.sessionImportScan)
    expect(res.groups[0].sessions[0].continuable).toBe(true)
  })
})

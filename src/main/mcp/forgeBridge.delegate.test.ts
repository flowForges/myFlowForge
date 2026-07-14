import { describe, it, expect, vi, afterEach } from 'vitest'
import * as net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { startBridge, type ForgeBridge } from './forgeBridge'

let bridge: ForgeBridge | null = null
afterEach(async () => { await bridge?.close().catch(() => {}); bridge = null })

function call(socketPath: string, req: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(socketPath, () => c.write(JSON.stringify(req) + '\n'))
    let buf = ''
    c.on('data', d => { buf += d.toString(); const i = buf.indexOf('\n'); if (i >= 0) { resolve(JSON.parse(buf.slice(0, i))); c.end() } })
    c.on('error', reject)
  })
}

const ctxBase = {
  store: { getContext: () => null, writeArtifact: vi.fn(), appendMessage: vi.fn() } as any,
  runId: 'chat', workspaceName: '/w',
  agentName: () => 'chat', agentStage: () => 'chat',
  ask: async () => null, setContext: () => {},
}

describe('forgeBridge delegate', () => {
  it('转发 args 给 ctx.delegate,回传结果', async () => {
    const delegate = vi.fn(async () => ({ text: '各项目汇总' }))
    const dir = mkdtempSync(join(tmpdir(), 'fb-'))
    bridge = await startBridge(dir, { ...ctxBase, delegate })
    const r = await call(bridge.socketPath, { id: '1', tool: 'delegate', agentId: 'chat', args: { task: '看登录', projects: ['a'], write: false } })
    expect(delegate).toHaveBeenCalledWith({ task: '看登录', projects: ['a'], write: false })
    expect(r.result).toEqual({ text: '各项目汇总' })
  })
  it('未配置 delegate 时报错', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fb-'))
    bridge = await startBridge(dir, { ...ctxBase })
    const r = await call(bridge.socketPath, { id: '2', tool: 'delegate', agentId: 'chat', args: { task: 'x' } })
    expect(r.error).toMatch(/delegate/)
  })
})

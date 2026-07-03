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

describe('forgeBridge propose_plan', () => {
  it('转发 approach 给 ctx.proposePlan,回传裁决', async () => {
    const proposePlan = vi.fn(async () => ({ approved: true }))
    const dir = mkdtempSync(join(tmpdir(), 'fb-'))
    bridge = await startBridge(dir, { ...ctxBase, proposePlan })
    const r = await call(bridge.socketPath, { id: '1', tool: 'propose_plan', agentId: 'chat', args: { approach: '先建模型' } })
    expect(proposePlan).toHaveBeenCalledWith('先建模型', undefined)
    expect(r.result).toEqual({ approved: true })
  })
  it('未配置 proposePlan 时报错', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fb-'))
    bridge = await startBridge(dir, { ...ctxBase })
    const r = await call(bridge.socketPath, { id: '2', tool: 'propose_plan', agentId: 'chat', args: { approach: 'x' } })
    expect(r.error).toMatch(/propose_plan/)
  })
})

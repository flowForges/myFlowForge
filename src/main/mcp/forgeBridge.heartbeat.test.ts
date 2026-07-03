import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as net from 'node:net'
import { startBridge, type BridgeRunCtx, type ForgeBridge } from './forgeBridge'

function sendRecv(socket: net.Socket, req: object): Promise<any> {
  return new Promise((resolve, reject) => {
    let buf = ''
    const onData = (chunk: Buffer) => {
      buf += chunk.toString()
      const idx = buf.indexOf('\n')
      if (idx < 0) return
      socket.off('data', onData)
      try { resolve(JSON.parse(buf.slice(0, idx))) } catch (err) { reject(err) }
    }
    socket.on('data', onData)
    socket.write(JSON.stringify(req) + '\n')
  })
}

function connectTo(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath)
    socket.once('connect', () => resolve(socket))
    socket.once('error', reject)
  })
}

let tmpDir: string
let bridge: ForgeBridge | undefined
let socket: net.Socket | undefined

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'forge-heartbeat-'))
  bridge = undefined
  socket = undefined
})

afterEach(async () => {
  try { socket?.destroy() } catch { /* ignore */ }
  if (bridge) await bridge.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

function makeCtx(): BridgeRunCtx {
  return {
    store: {
      getContext: vi.fn().mockReturnValue('ctx-value'),
      writeArtifact: vi.fn(),
      appendMessage: vi.fn(),
    } as unknown as BridgeRunCtx['store'],
    runId: 'run-heartbeat',
    workspaceName: 'ws',
    agentName: vi.fn((id: string) => id),
    agentStage: vi.fn().mockReturnValue('develop'),
    ask: vi.fn(),
    setContext: vi.fn(),
    onBeat: vi.fn(),
  }
}

describe('ForgeBridge heartbeat', () => {
  it('responds to heartbeat and treats every tool call as agent activity', async () => {
    const ctx = makeCtx()
    bridge = await startBridge(tmpDir, ctx)
    socket = await connectTo(bridge.socketPath)

    const hb = await sendRecv(socket, { id: 'hb-1', tool: 'heartbeat', agentId: 'a1', args: {} })
    expect(hb).toEqual({ id: 'hb-1', result: { ok: true } })
    expect(ctx.onBeat).toHaveBeenCalledWith('a1')

    const read = await sendRecv(socket, { id: 'ctx-1', tool: 'read_context', agentId: 'a1', args: { key: 'k' } })
    expect(read).toEqual({ id: 'ctx-1', result: { value: 'ctx-value' } })
    expect(ctx.onBeat).toHaveBeenCalledTimes(2)
    expect(ctx.onBeat).toHaveBeenLastCalledWith('a1')
  })
})

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as net from 'node:net'
import { RunStore } from '../orchestrator/runStore'
import { startBridge, type ForgeBridge } from '../mcp/forgeBridge'
import { makeProposeRun } from './proposeRun'
import type { Workspace } from '../config/schema'
import type { StartRunOpts } from '../orchestrator/orchestrator'
import type { RunState } from '@shared/types'

// End-to-end seam: a chat agent calling forge_propose_plan → forgeMcp send('propose_plan') →
// bridge socket → ctx.proposePlan → makeProposeRun. The plan is emitted as a request; only after
// the user approves (proposeRun.resolve(id, {decision:'allow'})) is orchestrator.startRun called.
// We exercise the socket round-trip with a real bridge + the real makeProposeRun, spying startRun.

function sendRecv(socket: net.Socket, req: object): Promise<any> {
  return new Promise((resolve, reject) => {
    let buf = ''
    const onData = (chunk: Buffer) => {
      buf += chunk.toString()
      const idx = buf.indexOf('\n')
      if (idx !== -1) { socket.off('data', onData); try { resolve(JSON.parse(buf.slice(0, idx))) } catch (e) { reject(e) } }
    }
    socket.on('data', onData)
    socket.write(JSON.stringify(req) + '\n')
  })
}
function connectTo(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(socketPath)
    s.once('connect', () => resolve(s)); s.once('error', reject)
  })
}

const ws: Workspace = {
  name: 'feat-x', path: '/abs/feat-x', workflowId: 'wf',
  stages: [{ key: 'develop', provider: 'claude', model: 'opus-4.8' }],
  projects: [{ repoId: 'r', name: 'app', branch: 'main', provider: 'claude', model: 'opus-4.8' }],
  status: 'idle',
  plugins: [], stepPlugins: [],
}

let dir: string
let bridge: ForgeBridge

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cwt-')) })
afterEach(async () => { await bridge?.close().catch(() => {}); rmSync(dir, { recursive: true, force: true }) })

describe('chat forge_propose_plan → bridge → proposeRun → (approve) startRun (e2e seam)', () => {
  it('a propose_plan tool call emits a plan-request; user approval starts the run with reconstructed opts', async () => {
    const startRun = vi.fn<(o: StartRunOpts) => void>()
    const emitPlanRequest = vi.fn<(wsPath: string, req: { id: string; approach: string; stages: { name: string; agents: number }[]; task?: string }) => void>()
    const proposeRun = makeProposeRun({
      getRun: () => null as RunState | null, readWorkspace: () => ws, readWorkflows: () => [],
      writeWorkspace: vi.fn(), startRun, emitPlanRequest, emitNote: vi.fn(),
      setSessionMode: vi.fn(), emitModeChanged: vi.fn(),
    })
    const store = new RunStore(dir, 'chat-bridge')
    bridge = await startBridge(store.runDir, {
      store, runId: 'chat', workspaceName: dir,
      agentName: () => 'chat', agentStage: () => 'chat',
      ask: async () => null, setContext: () => {},
      proposePlan: (approach, task) => proposeRun(ws.path, approach, task),
    })
    const sock = await connectTo(bridge.socketPath)
    const resP = sendRecv(sock, { id: '1', tool: 'propose_plan', agentId: 'chat', args: { approach: '先建模型', task: '做登录' } })

    // The plan is proposed (request emitted) but not started yet.
    await vi.waitFor(() => expect(emitPlanRequest).toHaveBeenCalledOnce())
    expect(startRun).not.toHaveBeenCalled()
    const { id } = emitPlanRequest.mock.calls[0][1]

    // User approves → run starts.
    proposeRun.resolve(id, { decision: 'allow' })
    const res = await resP
    sock.end()

    expect(res.result).toEqual({ approved: true })
    expect(startRun).toHaveBeenCalledOnce()
    const opts = startRun.mock.calls[0][0]
    expect(opts).toMatchObject({ runId: 'run-feat-x', task: '做登录' })
    expect(opts.developProjects[0]).toMatchObject({ name: 'app', cwd: '/abs/feat-x/app' })
  })

  it('reports approved:false (no concurrent run) when a run is already live at approval time', async () => {
    const startRun = vi.fn<(o: StartRunOpts) => void>()
    const emitPlanRequest = vi.fn<(wsPath: string, req: { id: string; approach: string; stages: { name: string; agents: number }[]; task?: string }) => void>()
    const live = { id: 'r', status: 'run', workspacePath: ws.path } as RunState
    const proposeRun = makeProposeRun({
      getRun: () => live, readWorkspace: () => ws, readWorkflows: () => [],
      writeWorkspace: vi.fn(), startRun, emitPlanRequest, emitNote: vi.fn(),
      setSessionMode: vi.fn(), emitModeChanged: vi.fn(),
    })
    const store = new RunStore(dir, 'chat-bridge')
    bridge = await startBridge(store.runDir, {
      store, runId: 'chat', workspaceName: dir,
      agentName: () => 'chat', agentStage: () => 'chat',
      ask: async () => null, setContext: () => {},
      proposePlan: (approach, task) => proposeRun(ws.path, approach, task),
    })
    const sock = await connectTo(bridge.socketPath)
    const resP = sendRecv(sock, { id: '2', tool: 'propose_plan', agentId: 'chat', args: { approach: 'x' } })
    await vi.waitFor(() => expect(emitPlanRequest).toHaveBeenCalledOnce())
    const { id } = emitPlanRequest.mock.calls[0][1]
    proposeRun.resolve(id, { decision: 'allow' })
    const res = await resP
    sock.end()

    expect(res.result.approved).toBe(false)
    expect(startRun).not.toHaveBeenCalled()
  })
})

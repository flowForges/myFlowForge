import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import * as net from 'node:net'
import { RunStore } from '../orchestrator/runStore'
import type { BridgeRunCtx, ForgeBridge } from './forgeBridge'
import { startBridge } from './forgeBridge'

// ─── helpers ────────────────────────────────────────────────────────────────

/** Write a JSON-line, read exactly one JSON-line response */
function sendRecv(socket: net.Socket, req: object): Promise<object> {
  return new Promise((resolve, reject) => {
    let buf = ''
    const onData = (chunk: Buffer) => {
      buf += chunk.toString()
      const idx = buf.indexOf('\n')
      if (idx !== -1) {
        socket.off('data', onData)
        try {
          resolve(JSON.parse(buf.slice(0, idx)))
        } catch (e) {
          reject(e)
        }
      }
    }
    socket.on('data', onData)
    socket.write(JSON.stringify(req) + '\n')
  })
}

/** Connect to the bridge socket and return the socket */
function connectTo(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(socketPath)
    s.once('connect', () => resolve(s))
    s.once('error', reject)
  })
}

/** Read the next available line from the socket (non-blocking accumulator) */
function readLine(socket: net.Socket): Promise<object> {
  return new Promise((resolve, reject) => {
    let buf = ''
    const onData = (chunk: Buffer) => {
      buf += chunk.toString()
      const idx = buf.indexOf('\n')
      if (idx !== -1) {
        socket.off('data', onData)
        try { resolve(JSON.parse(buf.slice(0, idx))) } catch (e) { reject(e) }
      }
    }
    socket.on('data', onData)
  })
}

// ─── fixtures ───────────────────────────────────────────────────────────────

let tmpDir: string
let bridge: ForgeBridge | undefined
let sockets: net.Socket[] = []

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'forge-test-'))
  bridge = undefined
  sockets = []
})

afterEach(async () => {
  for (const s of sockets) { try { s.destroy() } catch { /* ignore */ } }
  if (bridge) { await bridge.close() }
  rmSync(tmpDir, { recursive: true, force: true })
})

function makeCtx(overrides: Partial<BridgeRunCtx> = {}): BridgeRunCtx {
  return {
    store: {
      getContext: vi.fn().mockReturnValue(null),
      writeArtifact: vi.fn().mockReturnValue({ path: '/tmp/artifact.md', kind: 'md' }),
      appendMessage: vi.fn(),
    } as unknown as BridgeRunCtx['store'],
    runId: 'run-test-1',
    workspaceName: 'test-ws',
    agentName: vi.fn().mockImplementation((id: string) => `Agent(${id})`),
    agentStage: vi.fn().mockReturnValue(''),
    ask: vi.fn().mockResolvedValue(null),
    setContext: vi.fn(),
    ...overrides,
  }
}

// ─── Test 1: round-trip read_context ────────────────────────────────────────

describe('ForgeBridge', () => {
  it('1. round-trip read_context returns value from store', async () => {
    const ctx = makeCtx({
      store: {
        getContext: vi.fn().mockReturnValue(42),
        writeArtifact: vi.fn(),
        appendMessage: vi.fn(),
      } as unknown as BridgeRunCtx['store'],
    })

    bridge = await startBridge(tmpDir, ctx)
    const s = await connectTo(bridge.socketPath)
    sockets.push(s)

    const res = await sendRecv(s, { id: 'req-1', tool: 'read_context', agentId: 'agent1', args: { key: 'myKey' } }) as any

    expect(res.id).toBe('req-1')
    expect(res.result).toEqual({ value: 42 })
    expect(ctx.store.appendMessage).toHaveBeenCalledOnce()
    const msg = (ctx.store.appendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(msg.type).toBe('read')   // read_context is a probe, not a progress/status event
    expect(msg.from.agentId).toBe('agent1')
  })

  // ─── Test 2: write_artifact happy + traversal rejection ───────────────────

  it('2. write_artifact succeeds and traversal rejection returns error without closing connection', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'ws-'))
    const store = new RunStore(ws, 'run-x')
    const appendMessage = vi.fn()
    const storeProxy: BridgeRunCtx['store'] = {
      getContext: store.getContext.bind(store),
      writeArtifact: store.writeArtifact.bind(store),
      appendMessage,
    }

    const ctx = makeCtx({ store: storeProxy })
    bridge = await startBridge(tmpDir, ctx)
    const s = await connectTo(bridge.socketPath)
    sockets.push(s)

    // Happy path
    const ok = await sendRecv(s, {
      id: 'req-write-1',
      tool: 'write_artifact',
      agentId: 'agent1',
      args: { name: 'output.md', content: '# hello' },
    }) as any
    expect(ok.id).toBe('req-write-1')
    expect(ok.result.path).toContain('output.md')

    // Traversal: should return error, NOT close connection
    const err = await sendRecv(s, {
      id: 'req-write-2',
      tool: 'write_artifact',
      agentId: 'agent1',
      args: { name: '../escape.md', content: 'bad' },
    }) as any
    expect(err.id).toBe('req-write-2')
    expect(err.error).toBeTruthy()

    // Connection still works after the error
    const ok2 = await sendRecv(s, {
      id: 'req-write-3',
      tool: 'write_artifact',
      agentId: 'agent1',
      args: { name: 'second.md', content: 'still works' },
    }) as any
    expect(ok2.result.path).toContain('second.md')

    rmSync(ws, { recursive: true, force: true })
  })

  // ─── Test 3: ask concurrency — no head-of-line blocking ───────────────────

  it('3. ask does not block read_context on same connection — no head-of-line blocking', async () => {
    let resolveAsk: (v: string) => void
    const askPromise = new Promise<string>(res => { resolveAsk = res })

    const ctx = makeCtx({
      ask: vi.fn().mockReturnValue(new Promise(res => {
        // Delay 80ms to simulate user thinking
        setTimeout(() => res('yes-do-it'), 80)
      })),
      store: {
        getContext: vi.fn().mockReturnValue(99),
        writeArtifact: vi.fn(),
        appendMessage: vi.fn(),
      } as unknown as BridgeRunCtx['store'],
    })

    bridge = await startBridge(tmpDir, ctx)
    const s = await connectTo(bridge.socketPath)
    sockets.push(s)

    // Collect responses in arrival order
    const responses: object[] = []
    const collectTwo = new Promise<void>((resolve) => {
      let buf = ''
      s.on('data', (chunk: Buffer) => {
        buf += chunk.toString()
        let idx: number
        while ((idx = buf.indexOf('\n')) !== -1) {
          responses.push(JSON.parse(buf.slice(0, idx)))
          buf = buf.slice(idx + 1)
          if (responses.length === 2) resolve()
        }
      })
    })

    // Send ask first, then immediately send read_context
    s.write(JSON.stringify({ id: 'ask-1', tool: 'ask', agentId: 'agent1', args: { question: 'Do you agree?' } }) + '\n')
    // Small tick to ensure ask is in flight before read_context
    await new Promise(r => setTimeout(r, 5))
    s.write(JSON.stringify({ id: 'ctx-1', tool: 'read_context', agentId: 'agent1', args: { key: 'x' } }) + '\n')

    await collectTwo

    // read_context (ctx-1) should arrive FIRST even though ask (ask-1) was sent first
    expect((responses[0] as any).id).toBe('ctx-1')
    expect((responses[0] as any).result).toEqual({ value: 99 })
    expect((responses[1] as any).id).toBe('ask-1')
    expect((responses[1] as any).result).toEqual({ answer: 'yes-do-it' })
  })

  // ─── Test 4: handoff ──────────────────────────────────────────────────────

  it('4. handoff calls setContext + appendMessage with type handoff, returns {ok:true}', async () => {
    const ctx = makeCtx()
    bridge = await startBridge(tmpDir, ctx)
    const s = await connectTo(bridge.socketPath)
    sockets.push(s)

    const res = await sendRecv(s, {
      id: 'hoff-1',
      tool: 'handoff',
      agentId: 'agent1',
      args: { summary: 'All done!', artifacts: [{ path: '/tmp/a.md', kind: 'md' }] },
    }) as any

    expect(res.id).toBe('hoff-1')
    expect(res.result).toEqual({ ok: true })

    const { setContext, store } = ctx
    expect(setContext).toHaveBeenCalledWith('handoff:agent1', 'All done!')
    const msg = (store.appendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(msg.type).toBe('handoff')
    expect(msg.from.agentId).toBe('agent1')
    expect(msg.artifacts).toEqual([{ path: '/tmp/a.md', kind: 'md' }])
  })

  // 回归(P1):mcpTools provider(codex/qoder)经真 forge_handoff 工具上报设计文档时,除写 handoff:<id>
  // 摘要外,还须把 .md 文档 artifact 记为 handoff-doc:<id>,否则设计评审门控的 buildDesignDocs 读不到,
  // 只能退化成短摘要、拿不到可打开的方案全文(纯文本围栏路径的 onHandoff 已经这样做了,MCP 路径此前漏了)。
  it('4c. handoff with a .md artifact also writes handoff-doc:<agentId> for the design gate', async () => {
    const ctx = makeCtx()
    bridge = await startBridge(tmpDir, ctx)
    const s = await connectTo(bridge.socketPath)
    sockets.push(s)
    await sendRecv(s, {
      id: 'hoff-doc',
      tool: 'handoff',
      agentId: 'agent1',
      args: { summary: 'plan', artifacts: [{ path: 'design/PLAN.md', kind: 'doc' }] },
    })
    expect(ctx.setContext).toHaveBeenCalledWith('handoff-doc:agent1', 'design/PLAN.md')
  })

  it('4d. handoff with no doc artifact does NOT write handoff-doc', async () => {
    const ctx = makeCtx()
    bridge = await startBridge(tmpDir, ctx)
    const s = await connectTo(bridge.socketPath)
    sockets.push(s)
    await sendRecv(s, {
      id: 'hoff-nodoc',
      tool: 'handoff',
      agentId: 'agent1',
      args: { summary: 'plan', artifacts: [{ path: 'src/main.ts', kind: 'code' }] },
    })
    const keys = (ctx.setContext as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0])
    expect(keys).not.toContain('handoff-doc:agent1')
  })

  // ─── Test 4b: ask forwards options through to ctx.ask ──────────────────────

  it('4b. ask forwards args.options to ctx.ask and returns the answer', async () => {
    const askSpy = vi.fn().mockResolvedValue('全量正则替换')
    const ctx = makeCtx({ ask: askSpy })
    bridge = await startBridge(tmpDir, ctx)
    const s = await connectTo(bridge.socketPath)
    sockets.push(s)

    const options = [{ t: '逐文件迁移', d: '分批' }, { t: '全量正则替换', d: '最快' }]
    const res = await sendRecv(s, {
      id: 'ask-opt-1', tool: 'ask', agentId: 'agent1',
      args: { question: '选择策略', options },
    }) as any

    expect(res.id).toBe('ask-opt-1')
    expect(res.result).toEqual({ answer: '全量正则替换' })
    expect(askSpy).toHaveBeenCalledWith('agent1', '选择策略', options)
  })

  // ─── Test 5: malformed JSON line → error, connection stays open ───────────

  it('5. malformed JSON line returns {id:"unknown", error} and connection stays alive', async () => {
    const ctx = makeCtx({
      store: {
        getContext: vi.fn().mockReturnValue('alive'),
        writeArtifact: vi.fn(),
        appendMessage: vi.fn(),
      } as unknown as BridgeRunCtx['store'],
    })

    bridge = await startBridge(tmpDir, ctx)
    const s = await connectTo(bridge.socketPath)
    sockets.push(s)

    const errRes = await sendRecv(s, {} as any) as any
    // We'll actually send raw bad JSON manually
    // Reset by doing a proper sendRecv for a valid message to confirm it still works
    // First, test raw bad input:
    const badPromise = new Promise<object>((resolve, reject) => {
      let buf = ''
      const onData = (chunk: Buffer) => {
        buf += chunk.toString()
        const idx = buf.indexOf('\n')
        if (idx !== -1) {
          s.off('data', onData)
          try { resolve(JSON.parse(buf.slice(0, idx))) } catch (e) { reject(e) }
        }
      }
      s.on('data', onData)
      s.write('NOT_JSON_AT_ALL\n')
    })

    const bad = await badPromise as any
    expect(bad.id).toBe('unknown')
    expect(bad.error).toBeTruthy()

    // Connection still usable
    const good = await sendRecv(s, {
      id: 'ctx-ok',
      tool: 'read_context',
      agentId: 'agent1',
      args: { key: 'foo' },
    }) as any
    expect(good.id).toBe('ctx-ok')
    expect(good.result).toEqual({ value: 'alive' })
  })

  // ─── Test 6: close() removes socket file; subsequent connect fails ─────────

  it('6. close() removes socket file; subsequent connect fails', async () => {
    const ctx = makeCtx()
    bridge = await startBridge(tmpDir, ctx)
    const socketPath = bridge.socketPath

    expect(existsSync(socketPath)).toBe(true)

    await bridge.close()
    bridge = undefined // prevent afterEach double-close

    expect(existsSync(socketPath)).toBe(false)

    // Connect should fail
    await expect(connectTo(socketPath)).rejects.toThrow()
  })

  // ─── Test 7: long runDir falls back to tmpdir ─────────────────────────────

  it('7. long runDir path >100 chars results in socketPath under tmpdir()', async () => {
    // Create a directory path whose join with 'forge.sock' exceeds 100 chars
    const longSegment = 'a'.repeat(90)
    const longDir = join(tmpDir, longSegment)
    const { mkdirSync } = await import('node:fs')
    mkdirSync(longDir, { recursive: true })

    const ctx = makeCtx({ runId: 'run-long' })
    bridge = await startBridge(longDir, ctx)

    expect(bridge.socketPath).toContain(tmpdir())
    expect(bridge.socketPath).toContain('run-long')
    expect(bridge.socketPath.length).toBeLessThanOrEqual(104) // darwin limit
  })

  // ─── Test 8: audit messages stamped with stage from ctx.agentStage ──────────

  it('8. stamps audit messages with the stage from ctx.agentStage', async () => {
    const appended: any[] = []
    const ctx = makeCtx({
      store: {
        getContext: vi.fn().mockReturnValue('val'),
        writeArtifact: vi.fn(),
        appendMessage: (m: any) => appended.push(m),
      } as unknown as BridgeRunCtx['store'],
      agentStage: vi.fn().mockReturnValue('develop'),
    })

    bridge = await startBridge(tmpDir, ctx)
    const s = await connectTo(bridge.socketPath)
    sockets.push(s)

    await sendRecv(s, { id: 'req-stage-1', tool: 'read_context', agentId: 'a1', args: { key: 'k' } })

    expect(appended).toHaveLength(1)
    expect(appended[0].from.stageKey).toBe('develop')
  })

  // ─── Test 9: close() removes leftover mcp.*.json files next to the socket ───

  it('9. removes leftover mcp.*.json next to the socket on close', async () => {
    const ctx = makeCtx()
    bridge = await startBridge(tmpDir, ctx)
    const socketDir = dirname(bridge.socketPath)

    // Simulate per-agent MCP config files written by the adapter
    const file1 = join(socketDir, 'mcp.agent_1.json')
    const file2 = join(socketDir, 'mcp.agent_2.json')
    writeFileSync(file1, '{}')
    writeFileSync(file2, '{}')

    expect(existsSync(file1)).toBe(true)
    expect(existsSync(file2)).toBe(true)

    await bridge.close()
    bridge = undefined // prevent afterEach double-close

    expect(existsSync(file1)).toBe(false)
    expect(existsSync(file2)).toBe(false)
  })

})

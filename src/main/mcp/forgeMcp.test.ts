/**
 * forgeMcp.test.ts
 *
 * Tests:
 *   A) createForgeServer — 4 tools registered, round-trips, error handling
 *   B) connectBridge — against a real startBridge (unix socket round-trip)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

import { createForgeServer, connectBridge, toolsToRegister, type SendFn } from './forgeMcp.js'
import { startBridge } from './forgeBridge.js'
import type { BridgeRunCtx } from './forgeBridge.js'

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Wire a McpServer directly to a Client via InMemoryTransport and return the client. */
async function wireClient(sendFn: SendFn): Promise<Client> {
  const server = createForgeServer(sendFn)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

  const client = new Client({ name: 'test-client', version: '0.0.1' })
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ])
  return client
}

// ─── Section T: toolsToRegister ──────────────────────────────────────────────

describe('T: toolsToRegister', () => {
  it('includes forge_propose_plan by default and respects an allowlist', () => {
    expect(toolsToRegister()).toContain('forge_propose_plan')
    expect(toolsToRegister()).toContain('forge_heartbeat')
    expect(toolsToRegister()).toHaveLength(6)
    expect(toolsToRegister(new Set(['forge_propose_plan']))).toEqual(['forge_propose_plan'])
    expect(toolsToRegister(new Set(['forge_ask']))).toEqual(['forge_ask'])
  })
})

// ─── Section A: createForgeServer ─────────────────────────────────────────────

describe('A: createForgeServer', () => {
  it('A1. lists exactly 6 tools with correct names', async () => {
    const send = vi.fn().mockResolvedValue({})
    const client = await wireClient(send)

    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual([
      'forge_ask',
      'forge_handoff',
      'forge_heartbeat',
      'forge_propose_plan',
      'forge_read_context',
      'forge_write_artifact',
    ])
  })

  it('A2. forge_read_context — calls send with right tool/args, returns JSON text', async () => {
    const send = vi.fn().mockResolvedValue({ value: 'hello-world' })
    const client = await wireClient(send)

    const res = await client.callTool({ name: 'forge_read_context', arguments: { key: 'myKey' } })
    expect(send).toHaveBeenCalledWith('read_context', { key: 'myKey' })
    const text = (res.content as Array<{ type: string; text: string }>)[0].text
    expect(JSON.parse(text)).toEqual({ value: 'hello-world' })
    expect(res.isError).toBeFalsy()
  })

  it('A3. forge_ask — returns answer text', async () => {
    const send = vi.fn().mockResolvedValue({ answer: 'Sure!' })
    const client = await wireClient(send)

    const res = await client.callTool({ name: 'forge_ask', arguments: { question: 'Proceed?' } })
    expect(send).toHaveBeenCalledWith('ask', { question: 'Proceed?', options: undefined })
    const text = (res.content as Array<{ type: string; text: string }>)[0].text
    expect(text).toBe('Sure!')
    expect(res.isError).toBeFalsy()
  })

  it('A3b. forge_ask — forwards options array to send', async () => {
    const send = vi.fn().mockResolvedValue({ answer: '逐文件迁移' })
    const client = await wireClient(send)

    const options = [{ t: '逐文件迁移', d: '分批' }, { t: '全量替换', d: '最快' }]
    const res = await client.callTool({ name: 'forge_ask', arguments: { question: '选择策略', options } })
    expect(send).toHaveBeenCalledWith('ask', { question: '选择策略', options })
    const text = (res.content as Array<{ type: string; text: string }>)[0].text
    expect(text).toBe('逐文件迁移')
  })

  it('A4. forge_ask — null answer returns fallback text', async () => {
    const send = vi.fn().mockResolvedValue({ answer: null })
    const client = await wireClient(send)

    const res = await client.callTool({ name: 'forge_ask', arguments: { question: 'Anything?' } })
    const text = (res.content as Array<{ type: string; text: string }>)[0].text
    expect(text).toBe('(用户未作答)')
  })

  it('A5. forge_write_artifact — returns 已写入 <path> text', async () => {
    const send = vi.fn().mockResolvedValue({ path: '/tmp/output.md' })
    const client = await wireClient(send)

    const res = await client.callTool({
      name: 'forge_write_artifact',
      arguments: { name: 'output.md', content: '# Hello' },
    })
    expect(send).toHaveBeenCalledWith('write_artifact', { name: 'output.md', content: '# Hello' })
    const text = (res.content as Array<{ type: string; text: string }>)[0].text
    expect(text).toBe('已写入 /tmp/output.md')
    expect(res.isError).toBeFalsy()
  })

  it('A6. forge_handoff — calls send and returns "ok"', async () => {
    const send = vi.fn().mockResolvedValue({ ok: true })
    const client = await wireClient(send)

    const res = await client.callTool({
      name: 'forge_handoff',
      arguments: {
        summary: 'Done',
        artifacts: [{ path: '/tmp/a.md', kind: 'md' }],
      },
    })
    expect(send).toHaveBeenCalledWith('handoff', {
      summary: 'Done',
      artifacts: [{ path: '/tmp/a.md', kind: 'md' }],
    })
    const text = (res.content as Array<{ type: string; text: string }>)[0].text
    expect(text).toBe('ok')
    expect(res.isError).toBeFalsy()
  })

  it('A7. send rejection → isError true, error text in content', async () => {
    const send = vi.fn().mockRejectedValue(new Error('Forge bridge 不可用'))
    const client = await wireClient(send)

    const res = await client.callTool({ name: 'forge_read_context', arguments: { key: 'x' } })
    expect(res.isError).toBe(true)
    const text = (res.content as Array<{ type: string; text: string }>)[0].text
    expect(text).toContain('Forge bridge 不可用')
  })
})

// ─── Section B: connectBridge ─────────────────────────────────────────────────

function makeBridgeCtx(overrides: Partial<BridgeRunCtx> = {}): BridgeRunCtx {
  return {
    store: {
      getContext: vi.fn().mockReturnValue('ctx-value'),
      writeArtifact: vi.fn().mockReturnValue({ path: '/tmp/art.md', kind: 'md' }),
      appendMessage: vi.fn(),
    } as unknown as BridgeRunCtx['store'],
    runId: 'run-mcp-test',
    workspaceName: 'test-ws',
    agentName: vi.fn().mockImplementation((id: string) => `Agent(${id})`),
    agentStage: vi.fn().mockReturnValue(''),
    ask: vi.fn().mockResolvedValue('yes'),
    setContext: vi.fn(),
    ...overrides,
  }
}

describe('B: connectBridge', () => {
  let tmpDir: string
  let bridgeHandle: Awaited<ReturnType<typeof startBridge>> | undefined

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'forge-mcp-test-'))
  })

  afterEach(async () => {
    if (bridgeHandle) {
      await bridgeHandle.close()
      bridgeHandle = undefined
    }
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('B1. send(read_context) resolves with bridge result', async () => {
    const ctx = makeBridgeCtx()
    bridgeHandle = await startBridge(tmpDir, ctx)

    const { send } = connectBridge(bridgeHandle.socketPath, 'agent-test')
    const result = await send('read_context', { key: 'someKey' }) as { value: unknown }

    expect(result.value).toBe('ctx-value')
    expect(ctx.store.getContext).toHaveBeenCalledWith('someKey')
  })

  it('B2. two concurrent sends correlate correctly (no mix-up)', async () => {
    // ask takes 80ms; read_context is immediate
    const ctx = makeBridgeCtx({
      store: {
        getContext: vi.fn().mockReturnValue(99),
        writeArtifact: vi.fn(),
        appendMessage: vi.fn(),
      } as unknown as BridgeRunCtx['store'],
      ask: vi.fn().mockImplementation(() =>
        new Promise<string | null>((res) => setTimeout(() => res('the-answer'), 80)),
      ),
    })

    bridgeHandle = await startBridge(tmpDir, ctx)
    const { send } = connectBridge(bridgeHandle.socketPath, 'agent-concurrent')

    // Fire both concurrently — ask is slow, read_context is fast
    const [askResult, ctxResult] = await Promise.all([
      send('ask', { question: 'Q?' }) as Promise<{ answer: string }>,
      send('read_context', { key: 'x' }) as Promise<{ value: number }>,
    ])

    expect(askResult.answer).toBe('the-answer')
    expect(ctxResult.value).toBe(99)
  }, 10_000)

  it('B2b. send issued immediately after connectBridge() resolves (queued during connect)', async () => {
    // Regression test: connectBridge() is async (socket still connecting), so
    // a send() on the same tick should not be rejected even though socket.writable
    // is false during the connect phase. Node queues the write.
    const ctx = makeBridgeCtx()
    bridgeHandle = await startBridge(tmpDir, ctx)

    // connectBridge returns immediately (socket not yet connected)
    const { send } = connectBridge(bridgeHandle.socketPath, 'agent-immediate')

    // Issue a send IMMEDIATELY (same tick) — should queue and resolve, not reject
    const result = await send('read_context', { key: 'immKey' }) as { value: unknown }

    expect(result.value).toBe('ctx-value')
    expect(ctx.store.getContext).toHaveBeenCalledWith('immKey')
  })

  it('B3. after bridge.close() pending send rejects with bridge error', async () => {
    const ctx = makeBridgeCtx({
      // ask will never resolve on its own — we close the bridge first
      ask: vi.fn().mockReturnValue(new Promise(() => { /* never resolves */ })),
    })

    bridgeHandle = await startBridge(tmpDir, ctx)
    const { send } = connectBridge(bridgeHandle.socketPath, 'agent-close')

    // Send an ask that will never come back
    const pendingAsk = send('ask', { question: 'will this ever answer?' })

    // Give the socket a moment to connect and send the request
    await new Promise((r) => setTimeout(r, 20))

    // Close the bridge — this should cause the socket to close
    await bridgeHandle.close()
    bridgeHandle = undefined

    await expect(pendingAsk).rejects.toThrow('Forge bridge 不可用')
  })
})

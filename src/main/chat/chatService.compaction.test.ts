import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sendTurn } from './chatService'
import type { ChatEvent } from '@shared/types'

/**
 * 整条链路:真 codex provider(假 app-server 说真协议)→ sendTurn → 阶段事件。
 *
 * ★★分段各自绿过不算数(这仓库栽过两次)。这里断言的是**界面真正收到的那个事件**:
 *  压缩开始时 think 折叠块的标题要变成「压缩上下文中…」,压缩完再变回去。
 */

vi.mock('../config/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/store')>()
  return { ...actual, readSettings: () => ({ ...actual.readSettings(), codexTransport: 'app-server' as const }) }
})

let ws: string
let oldPath: string | undefined

// 假 codex:开一轮 → 报一次上下文压缩(started/completed 一对)→ 给一句正文 → 收尾。
const FAKE = `#!/usr/bin/env node
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
let buf = ''
process.stdin.on('data', (b) => {
  buf += b.toString()
  let nl
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
    if (!line) continue
    const m = JSON.parse(line)
    if (m.method === 'initialize') out({ jsonrpc: '2.0', id: m.id, result: {} })
    else if (m.method === 'thread/start' || m.method === 'thread/resume') out({ jsonrpc: '2.0', id: m.id, result: { thread: { id: 'th1' } } })
    else if (m.method === 'turn/start') {
      out({ jsonrpc: '2.0', id: m.id, result: {} })
      out({ jsonrpc: '2.0', method: 'item/started', params: { threadId: 'th1', turnId: 'tu1', startedAtMs: 0,
        item: { id: 'cmp1', type: 'contextCompaction' } } })
      out({ jsonrpc: '2.0', method: 'item/completed', params: { threadId: 'th1', turnId: 'tu1', completedAtMs: 1,
        item: { id: 'cmp1', type: 'contextCompaction' } } })
      out({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { delta: '压完了,继续' } })
      out({ jsonrpc: '2.0', method: 'turn/completed', params: {} })
      setTimeout(() => process.exit(0), 20)
    }
  }
})
`

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'svc-compact-'))
  const bin = join(ws, 'codex')
  writeFileSync(bin, FAKE); chmodSync(bin, 0o755)
  oldPath = process.env.PATH
  process.env.PATH = `${ws}:${oldPath ?? ''}`
})
afterEach(() => {
  process.env.PATH = oldPath
  rmSync(ws, { recursive: true, force: true })
})

describe('真 codex provider(app-server)→ sendTurn → 阶段事件', () => {
  it('★★自动压缩期间报「压缩中」,压缩完回到「在想」', async () => {
    const { makeCodexProvider } = await import('../agents/providers/codex')
    const events: ChatEvent[] = []
    await sendTurn(
      { workspacePath: ws, sessionId: 's1', agent: 'codex', agentLabel: 'Codex', model: 'default', text: '继续', attachments: [] },
      {
        provider: makeCodexProvider({ bin: 'codex', defaultModels: [] }),
        env: process.env, emit: (e) => events.push(e), confirm: async () => 'allow',
      },
    )
    const phases = events.filter(e => e.type === 'phase').map(e => (e as { phase: string }).phase)
    expect(phases, '界面压根没收到「在压缩」这件事').toEqual(['compacting', 'thinking'])
  })

  it('★同一个阶段不重复广播 —— 每条 item 都发一次等于给界面刷噪音', async () => {
    const { makeCodexProvider } = await import('../agents/providers/codex')
    const events: ChatEvent[] = []
    await sendTurn(
      { workspacePath: ws, sessionId: 's2', agent: 'codex', agentLabel: 'Codex', model: 'default', text: '继续', attachments: [] },
      {
        provider: makeCodexProvider({ bin: 'codex', defaultModels: [] }),
        env: process.env, emit: (e) => events.push(e), confirm: async () => 'allow',
      },
    )
    // 假 codex 只压缩一次,所以恰好两条;起手就是 thinking,不该先冒一条多余的 thinking。
    expect(events.filter(e => e.type === 'phase')).toHaveLength(2)
  })
})

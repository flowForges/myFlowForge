/**
 * forgeMcp.ts — Standalone MCP server entry for Forge tooling.
 *
 * Spawned by CLI agents with ELECTRON_RUN_AS_NODE=1.
 * MUST NOT import electron or any app module other than node builtins.
 * Talks to the Electron main process ONLY via the unix socket (FORGE_SOCKET).
 *
 * Wire protocol (mirrors forgeBridge.ts):
 *   → {id, tool, agentId, args}   (JSON line)
 *   ← {id, result}  |  {id, error}  (JSON line)
 */

import * as net from 'node:net'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

// ─── Types ────────────────────────────────────────────────────────────────────

export type SendFn = (tool: string, args: Record<string, unknown>) => Promise<unknown>

// ─── toolsToRegister / listForgeTools ────────────────────────────────────────

const ALL_TOOLS = ['forge_read_context', 'forge_write_artifact', 'forge_ask', 'forge_handoff', 'forge_heartbeat', 'forge_propose_plan'] as const

export function toolsToRegister(allowed?: Set<string>): string[] {
  return ALL_TOOLS.filter(t => !allowed || allowed.has(t))
}

/** Pure helper: return the subset of ALL_TOOLS matching the comma-separated whitelist.
 *  If `forgeTools` is undefined/empty, return all tool names. */
export function listForgeTools(forgeTools?: string): string[] {
  if (!forgeTools) return ALL_TOOLS.slice()
  const allow = new Set(forgeTools.split(',').map(s => s.trim()).filter(Boolean))
  return ALL_TOOLS.filter(n => allow.has(n))
}

// ─── createForgeServer ────────────────────────────────────────────────────────

/**
 * Build and configure a McpServer with Forge tools.
 * `send` is the only dependency — inject a real bridge send or a failing stub.
 * `allowed` optionally restricts which tools are registered (default: all).
 */
export function createForgeServer(send: SendFn, allowed?: Set<string>): McpServer {
  const server = new McpServer({ name: 'forge', version: '1.0.0' })
  const reg = new Set(toolsToRegister(allowed))

  // forge_read_context
  if (reg.has('forge_read_context')) server.registerTool(
    'forge_read_context',
    {
      description: '从 Forge 黑板读取上下文值',
      inputSchema: { key: z.string() },
    },
    async ({ key }) => {
      try {
        const result = await send('read_context', { key })
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
      } catch (err: unknown) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: errorMessage(err) }],
        }
      }
    },
  )

  // forge_write_artifact
  if (reg.has('forge_write_artifact')) server.registerTool(
    'forge_write_artifact',
    {
      description: '向 Forge 写入制品文件',
      inputSchema: {
        name: z.string(),
        content: z.string(),
      },
    },
    async ({ name, content }) => {
      try {
        const result = await send('write_artifact', { name, content }) as { path?: string }
        const path = result?.path ?? name
        return { content: [{ type: 'text' as const, text: `已写入 ${path}` }] }
      } catch (err: unknown) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: errorMessage(err) }],
        }
      }
    },
  )

  // forge_ask
  const reqOptionSchema = z.object({ t: z.string(), d: z.string() })
  if (reg.has('forge_ask')) server.registerTool(
    'forge_ask',
    {
      description: '向用户提问并等待回答（阻塞直到用户作答）。传入 options 则以单选形式呈现，返回所选项的 t。',
      inputSchema: { question: z.string(), options: z.array(reqOptionSchema).optional() },
    },
    async ({ question, options }) => {
      try {
        const result = await send('ask', { question, options }) as { answer?: string | null }
        const text = result?.answer ?? '(用户未作答)'
        return { content: [{ type: 'text' as const, text }] }
      } catch (err: unknown) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: errorMessage(err) }],
        }
      }
    },
  )

  // forge_handoff
  const artifactSchema = z.object({ path: z.string(), kind: z.string() })
  if (reg.has('forge_handoff')) server.registerTool(
    'forge_handoff',
    {
      description: '向编排器发出交接信号，附带摘要和可选制品列表',
      inputSchema: {
        summary: z.string(),
        artifacts: z.array(artifactSchema).optional(),
      },
    },
    async ({ summary, artifacts }) => {
      try {
        await send('handoff', { summary, artifacts })
        return { content: [{ type: 'text' as const, text: 'ok' }] }
      } catch (err: unknown) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: errorMessage(err) }],
        }
      }
    },
  )

  // forge_heartbeat
  if (reg.has('forge_heartbeat')) server.registerTool(
    'forge_heartbeat',
    {
      description: '长操作期间上报存活,无副作用',
      inputSchema: { note: z.string().optional() },
    },
    async ({ note }) => {
      try {
        await send('heartbeat', note ? { note } : {})
        return { content: [{ type: 'text' as const, text: 'ok' }] }
      } catch (err: unknown) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: errorMessage(err) }],
        }
      }
    },
  )

  // forge_propose_plan
  if (reg.has('forge_propose_plan')) server.registerTool(
    'forge_propose_plan',
    {
      description: '提交技术方案,等待用户批准后才执行工作流(批准前不要自行执行阶段)。默认跑工作区配置的全部阶段与全部项目;当任务较小或只涉及部分项目时,应按需裁剪以省 token。参数:stages=只跑这些阶段的 key(如 ["requirement","develop"] 只做需求分析+开发,跳过测试与 CR);projects=每个"逐项目阶段"默认只作用于这些项目名;stageProjects=按阶段分别指定项目子集的映射,如 {"design":["a","b","c","d","e"],"develop":["a","b"]} 表示"分析全部 5 个项目、但只在 a/b 里写代码"(优先级高于 projects)。全部省略则全量执行。',
      inputSchema: { approach: z.string(), task: z.string().optional(), stages: z.array(z.string()).optional(), projects: z.array(z.string()).optional(), stageProjects: z.record(z.string(), z.array(z.string())).optional() },
    },
    async ({ approach, task, stages, projects, stageProjects }) => {
      const r = await send('propose_plan', { approach, task, stages, projects, stageProjects }) as { approved: boolean; feedback?: string }
      let text: string
      if (r.approved) {
        text = '已批准,工作流已启动'
      } else if (r.feedback) {
        text = `未批准,请据反馈修改后重新提交:${r.feedback}`
      } else {
        text = '用户已取消'
      }
      return { content: [{ type: 'text' as const, text }] }
    },
  )

  return server
}

// ─── connectBridge ────────────────────────────────────────────────────────────

interface BridgeHandle {
  send: SendFn
}

/**
 * Connect to the Forge unix socket and return a `{ send }` handle.
 * Requests are JSON-lines with id correlation; responses are matched by id.
 * If the socket closes/errors, all pending sends are rejected.
 */
export function connectBridge(socketPath: string, agentId: string): BridgeHandle {
  // Pending resolvers: id → { resolve, reject }
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  let seq = 0
  let buf = ''

  const socket = net.createConnection(socketPath)

  const rejectAll = (reason: string) => {
    const err = new Error(reason)
    for (const { reject } of pending.values()) {
      reject(err)
    }
    pending.clear()
  }

  socket.on('data', (chunk: Buffer) => {
    buf += chunk.toString()
    let idx: number
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line) continue
      try {
        const msg = JSON.parse(line) as { id: string; result?: unknown; error?: string }
        const handler = pending.get(msg.id)
        if (!handler) continue
        pending.delete(msg.id)
        if (Object.prototype.hasOwnProperty.call(msg, 'error')) {
          handler.reject(new Error(msg.error ?? 'Bridge error'))
        } else {
          handler.resolve(msg.result)
        }
      } catch {
        // Malformed line from bridge — ignore
      }
    }
  })

  socket.on('error', () => rejectAll('Forge bridge 不可用'))
  socket.on('close', () => rejectAll('Forge bridge 不可用'))

  const send: SendFn = (tool, args) =>
    new Promise((resolve, reject) => {
      const id = `fmcp-${Date.now()}-${++seq}`
      pending.set(id, { resolve, reject })
      const payload = JSON.stringify({ id, tool, agentId, args }) + '\n'
      // Only reject if socket is truly dead (destroyed or writable+not connecting)
      // During connection phase, socket.writable is false but socket.connecting is true,
      // and Node queues writes correctly.
      if (socket.destroyed || (!socket.writable && !socket.connecting)) {
        pending.delete(id)
        reject(new Error('Forge bridge 不可用'))
        return
      }
      socket.write(payload, (err) => {
        if (err) {
          pending.delete(id)
          reject(err)
        }
      })
    })

  return { send }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function noopSend(_tool: string, _args: Record<string, unknown>): Promise<never> {
  return Promise.reject(new Error('Forge bridge 不可用'))
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  const socketPath = process.env.FORGE_SOCKET
  const agentId = process.env.FORGE_AGENT_ID ?? 'unknown'
  const allowedList = listForgeTools(process.env.FORGE_TOOLS)
  const allowed = process.env.FORGE_TOOLS ? new Set(allowedList) : undefined

  let send: SendFn
  if (socketPath) {
    try {
      const bridge = connectBridge(socketPath, agentId)
      send = bridge.send
    } catch {
      send = noopSend
    }
  } else {
    send = noopSend
  }

  const server = createForgeServer(send, allowed)
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

// Guard: only run main when executed directly (CJS require.main === module)
// electron-vite builds CJS for main; in CJS require.main === module works.
if (require.main === module) {
  main().catch((err) => {
    console.error('[forgeMcp] fatal:', err)
    process.exit(1)
  })
}

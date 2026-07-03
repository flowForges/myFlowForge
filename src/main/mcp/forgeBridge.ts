import * as net from 'node:net'
import { rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import type { RunStore } from '../orchestrator/runStore'
import type { AgentMessage } from '../orchestrator/types'

// ─── Public types ────────────────────────────────────────────────────────────

export interface BridgeRunCtx {
  store: Pick<RunStore, 'getContext' | 'writeArtifact' | 'appendMessage'>
  runId: string
  workspaceName: string
  agentName(agentId: string): string
  agentStage(agentId: string): string
  ask(agentId: string, question: string, options?: { t: string; d: string }[]): Promise<string | null>
  setContext(key: string, value: unknown): void
  onBeat?(agentId: string): void
  proposePlan?(approach: string, task?: string): Promise<{ approved: boolean; feedback?: string }>
}

export interface ForgeBridge {
  socketPath: string
  close(): Promise<void>
}

// ─── Implementation ──────────────────────────────────────────────────────────

let _seq = 0
function nextSeq() { return ++_seq }

function makeId() {
  return `mcp-${Date.now()}-${nextSeq()}`
}

function isoTs(): string {
  return new Date().toISOString().slice(11, 19)
}

export function startBridge(runDir: string, ctx: BridgeRunCtx): Promise<ForgeBridge> {
  return new Promise((resolve, reject) => {
    // Determine socket path with darwin sun_path limit fallback (100 char threshold)
    const candidate = join(runDir, 'forge.sock')
    const socketPath = candidate.length > 100
      ? join(tmpdir(), `forge-${ctx.runId}.sock`)
      : candidate

    // Remove stale socket file before listening
    rmSync(socketPath, { force: true })

    const allSockets = new Set<net.Socket>()
    const server = net.createServer((socket) => {
      allSockets.add(socket)
      socket.once('close', () => allSockets.delete(socket))
      handleConnection(socket, ctx)
    })

    server.listen(socketPath, () => {
      resolve({
        socketPath,
        close(): Promise<void> {
          return new Promise((res, rej) => {
            // Destroy all open sockets immediately
            for (const s of allSockets) {
              try { s.destroy() } catch { /* ignore */ }
            }
            server.close((err) => {
              rmSync(socketPath, { force: true })
              // Remove per-agent MCP config files written next to the socket (esp. on the
              // tmpdir fallback path, where nothing else would ever clean them up).
              try {
                const dir = dirname(socketPath)
                for (const f of readdirSync(dir)) {
                  if (/^mcp\..*\.json$/.test(f)) { try { rmSync(join(dir, f), { force: true }) } catch { /* ignore */ } }
                }
              } catch { /* dir gone — ignore */ }
              if (err) rej(err)
              else res()
            })
          })
        },
      })
    })

    server.once('error', reject)
  })
}

// ─── Connection handler ───────────────────────────────────────────────────────

function handleConnection(socket: net.Socket, ctx: BridgeRunCtx) {
  let buf = ''

  socket.on('data', (chunk: Buffer) => {
    buf += chunk.toString()
    let idx: number
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line) continue
      // Process each line concurrently (no await — fire and forget per request)
      void processLine(line, socket, ctx)
    }
  })

  socket.on('error', () => { /* ignore ECONNRESET etc. */ })
}

async function processLine(line: string, socket: net.Socket, ctx: BridgeRunCtx) {
  let id: string = 'unknown'
  try {
    const req = JSON.parse(line) as {
      id: string
      tool: string
      agentId: string
      args: Record<string, unknown>
    }
    id = req.id ?? 'unknown'

    const result = await dispatch(req, ctx)
    sendResponse(socket, { id, result })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    sendResponse(socket, { id, error: message })
  }
}

function sendResponse(socket: net.Socket, payload: object) {
  if (!socket.writable) return
  socket.write(JSON.stringify(payload) + '\n')
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

async function dispatch(
  req: { id: string; tool: string; agentId: string; args: Record<string, unknown> },
  ctx: BridgeRunCtx,
): Promise<unknown> {
  const { tool, agentId, args } = req
  ctx.onBeat?.(agentId)

  switch (tool) {
    case 'heartbeat': {
      return { ok: true }
    }

    case 'read_context': {
      const key = args.key as string
      const value = ctx.store.getContext(key) ?? null
      // 'read' (not 'status'): a context probe is not progress. Agents often probe many guessed
      // keys when upstream handoff lacks structure — keep those out of the status/progress stream.
      appendAudit(ctx, agentId, 'read', args, [])
      return { value }
    }

    case 'write_artifact': {
      const name = args.name as string
      const content = args.content as string
      // May throw for traversal attacks — propagates as error response
      const ref = ctx.store.writeArtifact(name, content)
      appendAudit(ctx, agentId, 'status', args, [ref])
      return { path: ref.path }
    }

    case 'ask': {
      const question = args.question as string
      const options = args.options as { t: string; d: string }[] | undefined
      const answer = await ctx.ask(agentId, question, options)
      appendAudit(ctx, agentId, 'question', { ...args, answer }, [])
      return { answer }
    }

    case 'handoff': {
      const summary = args.summary as string
      const artifacts = (args.artifacts as Array<{ path: string; kind: string }> | undefined) ?? []
      ctx.setContext(`handoff:${agentId}`, summary)
      appendAudit(ctx, agentId, 'handoff', args, artifacts)
      return { ok: true }
    }

    case 'propose_plan': {
      if (!ctx.proposePlan) throw new Error('propose_plan not supported')
      const r = await ctx.proposePlan(args.approach as string, args.task as string | undefined)
      appendAudit(ctx, agentId, 'status', { approach: args.approach, approved: r.approved }, [])
      return r
    }

    default:
      throw new Error(`unknown tool: ${tool}`)
  }
}

// ─── Audit helper ─────────────────────────────────────────────────────────────

function appendAudit(
  ctx: BridgeRunCtx,
  agentId: string,
  type: AgentMessage['type'],
  payload: unknown,
  artifacts: Array<{ path: string; kind: string }>,
) {
  const msg: AgentMessage = {
    id: makeId(),
    runId: ctx.runId,
    from: {
      runId: ctx.runId,
      stageKey: ctx.agentStage(agentId),
      agentId,
      name: ctx.agentName(agentId),
    },
    to: 'orchestrator',
    type,
    payload,
    artifacts,
    ts: isoTs(),
  }
  ctx.store.appendMessage(msg)
}

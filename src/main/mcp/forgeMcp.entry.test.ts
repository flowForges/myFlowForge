/**
 * M-11: the env → stdio-entry seam. A local turn's env (cuBeginTurn) goes through the claude config file
 * (forgeMcpArgs) into the env block the MCP child gets; the entry reads FORGE_SOCKET / FORGE_AGENT_ID / FORGE_TOOLS
 * from exactly that block and serves the ten computer tools over a real cu socket, tagged with the turn's token.
 * Nothing here spawns a process: the entry's config reader and server run in-process.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { COMPUTER_TOOLS } from '@shared/computerUse'
import { connectBridge, createForgeServer, forgeEntryConfig } from './forgeMcp'
import { forgeCodexConfigArgs, forgeMcpArgs } from '../agents/mcpConfig'
import { cuBeginTurn } from '../computerUse/chatTurn'
import { startCuBridge, type CuBridge } from '../computerUse/cuBridge'
import type { ComputerUseHost } from '../host/capabilities'

const KEY = { workspacePath: '/w', sessionId: 's' }
const TOKEN = 'cu.ABCDEFGHIJKLMNOP'
const roots: string[] = []
const bridges: CuBridge[] = []
afterEach(async () => {
  for (const b of bridges.splice(0)) await b.close()
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

/** just the turn API cuBeginTurn uses: mode on, token minted, tools granted for a local turn */
const fakeCu = (): ComputerUseHost => ({
  service: {
    beginTurn: (_k: unknown, origin: unknown) => ({ tools: origin === 'local' }),
    endTurn: () => {}, modeOf: () => 'ask', tokenFor: () => TOKEN,
  },
} as unknown as ComputerUseHost)

async function armedTurn() {
  const dir = mkdtempSync(join(tmpdir(), 'cu-entry-'))
  roots.push(dir)
  const seen: { agentId: string; op: unknown }[] = []
  const bridge = await startCuBridge(join(dir, 'computer-use'), async (agentId, _tool, a) => {
    seen.push({ agentId, op: a.op })
    return { ok: true, text: '<untrusted_screen_text>TextEdit</untrusted_screen_text>' }
  })
  bridges.push(bridge)
  const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' }
  const end = cuBeginTurn(fakeCu(), KEY, {
    origin: 'local', agent: 'claude', armed: { socketPath: bridge.socketPath, configDir: bridge.configDir },
    env, mcpEntry: '/app/out/main/forgeMcp.js', note: () => {},
  })
  return { env, end, seen, bridge }
}

describe('env → stdio entry (M-11)', () => {
  it('the claude config file hands the entry FORGE_SOCKET / FORGE_AGENT_ID / FORGE_TOOLS; the entry serves the ten tools over the cu socket with the token', async () => {
    const { env, end, seen, bridge } = await armedTurn()
    const args = forgeMcpArgs(env)
    expect(args[0]).toBe('--mcp-config')
    const child = JSON.parse(readFileSync(args[1], 'utf8')).mcpServers.forge as { args: string[]; env: Record<string, string> }
    expect(child.args).toEqual(['/app/out/main/forgeMcp.js'])

    const cfg = forgeEntryConfig(child.env)
    expect(cfg.socketPath).toBe(bridge.socketPath)
    expect(cfg.agentId).toBe(TOKEN)
    expect([...cfg.allowed!].sort()).toEqual([...COMPUTER_TOOLS].sort())

    const server = createForgeServer(connectBridge(cfg.socketPath!, cfg.agentId).send, cfg.allowed)
    const [ct, st] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'claude-code', version: '9.9.9' })
    await Promise.all([server.connect(st), client.connect(ct)])
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual([...COMPUTER_TOOLS].sort())
    const r = await client.callTool({ name: 'computer_front_app', arguments: {} })
    expect(r.isError).toBeFalsy()
    expect(seen).toEqual([{ agentId: TOKEN, op: 'front_app' }])
    await client.close()
    end()
  })

  it('codex: the token is kept out of argv and forwarded by name; the turn env still carries it for the entry', async () => {
    const { env, end } = await armedTurn()
    const argv = forgeCodexConfigArgs(env).join(' ')
    expect(argv).not.toContain(TOKEN)
    expect(argv).toContain('mcp_servers.forge.env_vars=["FORGE_AGENT_ID"]')
    expect(forgeEntryConfig({ FORGE_SOCKET: env.FORGE_SOCKET, FORGE_TOOLS: env.FORGE_TOOLS, FORGE_AGENT_ID: env.FORGE_AGENT_ID }).agentId).toBe(TOKEN)
    end()
  })

  it('no FORGE_TOOLS: the entry registers no computer tool; no FORGE_AGENT_ID reads as unknown', () => {
    const cfg = forgeEntryConfig({ FORGE_SOCKET: '/s' })
    expect(cfg.allowed).toBeUndefined()
    expect(cfg.agentId).toBe('unknown')
    expect(forgeEntryConfig({}).socketPath).toBeUndefined()
  })
})

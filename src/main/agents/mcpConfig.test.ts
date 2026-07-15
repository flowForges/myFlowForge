import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { forgeMcpArgs, tomlString, tomlArray, tomlInlineTable, forgeServerSpec, forgeCodexConfigArgs, forgeAllowedToolNames } from './mcpConfig'

let tmpDir: string
beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'mcp-cfg-')) })
afterEach(() => rmSync(tmpDir, { recursive: true, force: true }))

describe('forgeAllowedToolNames', () => {
  const full = (tools: string) => ({ FORGE_SOCKET: join(tmpDir, 'forge.sock'), FORGE_AGENT_ID: 'chat', FORGE_MCP_ENTRY: '/app/out/main/forgeMcp.js', FORGE_TOOLS: tools })

  it('maps FORGE_TOOLS to mcp__forge__<tool> names when forge is injected', () => {
    expect(forgeAllowedToolNames(full('forge_propose_plan,forge_delegate')))
      .toEqual(['mcp__forge__forge_propose_plan', 'mcp__forge__forge_delegate'])
  })

  it('trims whitespace and drops empties', () => {
    expect(forgeAllowedToolNames(full(' forge_delegate , , forge_ask ')))
      .toEqual(['mcp__forge__forge_delegate', 'mcp__forge__forge_ask'])
  })

  it('returns [] when forge is not injected (missing socket)', () => {
    expect(forgeAllowedToolNames({ FORGE_AGENT_ID: 'chat', FORGE_MCP_ENTRY: '/x/forgeMcp.js', FORGE_TOOLS: 'forge_delegate' })).toEqual([])
  })

  it('returns [] when FORGE_TOOLS is empty/absent even if injected', () => {
    expect(forgeAllowedToolNames(full(''))).toEqual([])
    const { FORGE_TOOLS: _omit, ...noTools } = full('x')
    expect(forgeAllowedToolNames(noTools)).toEqual([])
  })
})

describe('forgeMcpArgs', () => {
  it('returns [] when FORGE_SOCKET is missing', () => {
    expect(forgeMcpArgs({ FORGE_AGENT_ID: 'a1', FORGE_MCP_ENTRY: '/x/forgeMcp.js' })).toEqual([])
  })

  it('returns [] when FORGE_AGENT_ID is missing', () => {
    const socket = join(tmpDir, 'forge.sock')
    expect(forgeMcpArgs({ FORGE_SOCKET: socket, FORGE_MCP_ENTRY: '/x/forgeMcp.js' })).toEqual([])
  })

  it('returns [] when FORGE_MCP_ENTRY is missing', () => {
    const socket = join(tmpDir, 'forge.sock')
    expect(forgeMcpArgs({ FORGE_SOCKET: socket, FORGE_AGENT_ID: 'a1' })).toEqual([])
  })

  it('writes mcp config file and returns [--mcp-config, path] when all three env vars present', () => {
    const socket = join(tmpDir, 'forge.sock')
    const mcpEntry = '/app/out/main/forgeMcp.js'
    const result = forgeMcpArgs({ FORGE_SOCKET: socket, FORGE_AGENT_ID: 'develop:projA', FORGE_MCP_ENTRY: mcpEntry })

    expect(result).toHaveLength(2)
    expect(result[0]).toBe('--mcp-config')
    const cfgFile = result[1]
    expect(cfgFile).toMatch(/mcp\.develop_projA\.json$/)
    expect(existsSync(cfgFile)).toBe(true)

    const cfg = JSON.parse(readFileSync(cfgFile, 'utf8'))
    expect(cfg.mcpServers.forge.command).toBe(process.execPath)
    expect(cfg.mcpServers.forge.args).toEqual([mcpEntry])
    expect(cfg.mcpServers.forge.env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(cfg.mcpServers.forge.env.FORGE_SOCKET).toBe(socket)
    expect(cfg.mcpServers.forge.env.FORGE_AGENT_ID).toBe('develop:projA')
  })

  it('sanitizes special chars in agentId for filename', () => {
    const socket = join(tmpDir, 'forge.sock')
    const result = forgeMcpArgs({ FORGE_SOCKET: socket, FORGE_AGENT_ID: 'stage/agent@v2', FORGE_MCP_ENTRY: '/x/mcp.js' })
    expect(result[1]).toMatch(/mcp\.stage_agent_v2\.json$/)
  })

  it('places config file in same directory as socket', () => {
    const socket = join(tmpDir, 'forge.sock')
    const result = forgeMcpArgs({ FORGE_SOCKET: socket, FORGE_AGENT_ID: 'a1', FORGE_MCP_ENTRY: '/x/mcp.js' })
    expect(result[1]).toMatch(new RegExp(`^${tmpDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  })
})

describe('tomlString', () => {
  it('wraps in double quotes', () => {
    expect(tomlString('hello')).toBe('"hello"')
  })
  it('escapes backslash and double quote', () => {
    expect(tomlString('a\\b"c')).toBe('"a\\\\b\\"c"')
  })
  it('escapes control chars (newline/tab)', () => {
    expect(tomlString('a\nb\tc')).toBe('"a\\nb\\tc"')
  })
  it('handles spaces (macOS dev path)', () => {
    expect(tomlString('/My App/Electron')).toBe('"/My App/Electron"')
  })
  it('escapes DEL (0x7f)', () => {
    expect(tomlString('\x7f')).toBe('"\\u007f"')
  })
  it('escapes C1 control chars (0x80-0x9f)', () => {
    expect(tomlString('\x80\x9f')).toBe('"\\u0080\\u009f"')
  })
})

describe('tomlArray', () => {
  it('serializes each element as a TOML string', () => {
    expect(tomlArray(['/x/forgeMcp.js'])).toBe('["/x/forgeMcp.js"]')
  })
  it('serializes empty array', () => {
    expect(tomlArray([])).toBe('[]')
  })
  it('serializes multiple elements with quoting', () => {
    expect(tomlArray(['a', 'b c'])).toBe('["a", "b c"]')
  })
})

describe('tomlInlineTable', () => {
  it('serializes bare keys with quoted string values', () => {
    expect(tomlInlineTable({ FOO: 'bar' })).toBe('{FOO="bar"}')
  })
  it('serializes empty table', () => {
    expect(tomlInlineTable({})).toBe('{}')
  })
  it('serializes multiple keys', () => {
    expect(tomlInlineTable({ A: '1', B: 'x y' })).toBe('{A="1", B="x y"}')
  })
  it('escapes string values', () => {
    expect(tomlInlineTable({ P: 'a"b' })).toBe('{P="a\\"b"}')
  })
})

describe('forgeServerSpec', () => {
  it('returns null when FORGE_SOCKET missing', () => {
    expect(forgeServerSpec({ FORGE_AGENT_ID: 'a1', FORGE_MCP_ENTRY: '/x/m.js' })).toBeNull()
  })
  it('returns null when FORGE_AGENT_ID missing', () => {
    expect(forgeServerSpec({ FORGE_SOCKET: '/s.sock', FORGE_MCP_ENTRY: '/x/m.js' })).toBeNull()
  })
  it('returns null when FORGE_MCP_ENTRY missing', () => {
    expect(forgeServerSpec({ FORGE_SOCKET: '/s.sock', FORGE_AGENT_ID: 'a1' })).toBeNull()
  })
  it('propagates FORGE_TOOLS into the MCP child env when present (allowlist must reach the child)', () => {
    const spec = forgeServerSpec({ FORGE_SOCKET: '/s.sock', FORGE_AGENT_ID: 'a1', FORGE_MCP_ENTRY: '/x/m.js', FORGE_TOOLS: 'forge_propose_plan' })
    expect(spec!.env.FORGE_TOOLS).toBe('forge_propose_plan')
  })
  it('omits FORGE_TOOLS from the child env when not set (full toolset)', () => {
    const spec = forgeServerSpec({ FORGE_SOCKET: '/s.sock', FORGE_AGENT_ID: 'a1', FORGE_MCP_ENTRY: '/x/m.js' })
    expect(spec!.env.FORGE_TOOLS).toBeUndefined()
  })
  it('returns command/args/env spec when all three present', () => {
    const spec = forgeServerSpec({ FORGE_SOCKET: '/s.sock', FORGE_AGENT_ID: 'a1', FORGE_MCP_ENTRY: '/x/m.js' })
    expect(spec).toEqual({
      command: process.execPath,
      args: ['/x/m.js'],
      env: { ELECTRON_RUN_AS_NODE: '1', FORGE_SOCKET: '/s.sock', FORGE_AGENT_ID: 'a1' }
    })
  })
})

describe('forgeCodexConfigArgs', () => {
  it('returns [] when env incomplete', () => {
    expect(forgeCodexConfigArgs({ FORGE_SOCKET: '/s.sock' })).toEqual([])
  })
  it('returns three -c overrides with valid TOML values when env complete', () => {
    const env = { FORGE_SOCKET: '/s.sock', FORGE_AGENT_ID: 'develop:projA', FORGE_MCP_ENTRY: '/x/forgeMcp.js' }
    const args = forgeCodexConfigArgs(env)
    expect(args).toEqual([
      '-c', `mcp_servers.forge.command=${tomlString(process.execPath)}`,
      '-c', 'mcp_servers.forge.args=["/x/forgeMcp.js"]',
      '-c', 'mcp_servers.forge.env={ELECTRON_RUN_AS_NODE="1", FORGE_SOCKET="/s.sock", FORGE_AGENT_ID="develop:projA"}'
    ])
  })
  it('alternates -c flag and value (6 elements)', () => {
    const args = forgeCodexConfigArgs({ FORGE_SOCKET: '/s.sock', FORGE_AGENT_ID: 'a1', FORGE_MCP_ENTRY: '/m.js' })
    expect(args).toHaveLength(6)
    expect(args[0]).toBe('-c')
    expect(args[2]).toBe('-c')
    expect(args[4]).toBe('-c')
  })
  it('quotes a path containing spaces in the assembled args override', () => {
    const args = forgeCodexConfigArgs({ FORGE_SOCKET: '/s.sock', FORGE_AGENT_ID: 'a1', FORGE_MCP_ENTRY: '/My App/forgeMcp.js' })
    expect(args).toContain('mcp_servers.forge.args=["/My App/forgeMcp.js"]')
  })
})

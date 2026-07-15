import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * TOML value serializers for codex `-c key=value` overrides. codex parses the value
 * part as TOML, so strings must be valid TOML basic strings. execa passes argv as an
 * array (no shell), so no shell quoting is needed — only valid TOML.
 */
export function tomlString(s: string): string {
  let out = '"'
  for (const ch of s) {
    if (ch === '\\') out += '\\\\'
    else if (ch === '"') out += '\\"'
    else if (ch === '\n') out += '\\n'
    else if (ch === '\t') out += '\\t'
    else if (ch === '\r') out += '\\r'
    else if (ch < '\x20' || (ch >= '\x7f' && ch <= '\x9f')) out += '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0')
    else out += ch
  }
  return out + '"'
}

export function tomlArray(arr: string[]): string {
  return '[' + arr.map(tomlString).join(', ') + ']'
}

// Keys are bare (FORGE_* and ELECTRON_RUN_AS_NODE match [A-Za-z0-9_]); values are TOML strings.
export function tomlInlineTable(obj: Record<string, string>): string {
  return '{' + Object.entries(obj).map(([k, v]) => `${k}=${tomlString(v)}`).join(', ') + '}'
}

export interface ForgeServerSpec { command: string; args: string[]; env: Record<string, string> }

/**
 * Single source of truth for the forge MCP server definition. Returns the spec when all
 * three FORGE_* env vars are present, else null (= no injection). Consumed by both the
 * claude (--mcp-config file) and codex (-c TOML overrides) injection paths.
 */
export function forgeServerSpec(env: NodeJS.ProcessEnv): ForgeServerSpec | null {
  const socket = env.FORGE_SOCKET
  const agentId = env.FORGE_AGENT_ID
  const mcpEntry = env.FORGE_MCP_ENTRY
  if (!socket || !agentId || !mcpEntry) return null
  const spawnEnv: Record<string, string> = { ELECTRON_RUN_AS_NODE: '1', FORGE_SOCKET: socket, FORGE_AGENT_ID: agentId }
  // The MCP child inherits ONLY this env block (the stdio transport doesn't pass through the
  // CLI's full env), so the tool allowlist must travel here or it's silently dropped.
  if (env.FORGE_TOOLS) spawnEnv.FORGE_TOOLS = env.FORGE_TOOLS
  return {
    command: process.execPath,
    args: [mcpEntry],
    env: spawnEnv
  }
}

/**
 * When env contains FORGE_SOCKET, FORGE_AGENT_ID, and FORGE_MCP_ENTRY, writes a per-agent
 * MCP config JSON file next to the socket and returns ['--mcp-config', <path>] to be
 * appended to the claude CLI args.
 *
 * Returns [] when any of the three env vars is absent (no MCP injection).
 *
 * Exported as a pure helper so it can be unit-tested without spawning a real process.
 */
export function forgeMcpArgs(env: NodeJS.ProcessEnv): string[] {
  const spec = forgeServerSpec(env)
  if (!spec) return []

  // Sanitize agentId for use in a filename
  const safeId = (env.FORGE_AGENT_ID as string).replace(/[^a-zA-Z0-9_-]/g, '_')
  const cfgDir = dirname(env.FORGE_SOCKET as string)
  const cfgFile = join(cfgDir, `mcp.${safeId}.json`)

  const config = { mcpServers: { forge: spec } }

  writeFileSync(cfgFile, JSON.stringify(config, null, 2), 'utf8')
  return ['--mcp-config', cfgFile]
}

/**
 * The forge MCP tools as CLI-facing permission names (`mcp__forge__<tool>`), derived from
 * FORGE_TOOLS. Non-interactive CLIs (claude/qoder) BLOCK an MCP tool call unless its name is
 * pre-granted via --allowedTools / --allowed-tools — otherwise the call fails with "requested
 * permissions to use mcp__forge__… but you haven't granted it yet" and the tool never runs (this
 * is why chat-initiated forge_delegate / forge_propose_plan silently failed). Returns [] when
 * forge isn't injected (missing socket/agentId/entry) or FORGE_TOOLS is empty.
 */
export function forgeAllowedToolNames(env: NodeJS.ProcessEnv): string[] {
  if (!forgeServerSpec(env)) return []
  return (env.FORGE_TOOLS ?? '')
    .split(',')
    .map(t => t.trim())
    .filter(Boolean)
    .map(t => `mcp__forge__${t}`)
}

/**
 * codex has no `--mcp-config` equivalent; an MCP server can only be registered in-place via
 * `-c mcp_servers.<name>.*` overrides (value parsed as TOML). Returns the three -c overrides
 * registering the forge server, or [] when env is incomplete (no injection).
 */
export function forgeCodexConfigArgs(env: NodeJS.ProcessEnv): string[] {
  const spec = forgeServerSpec(env)
  if (!spec) return []
  return [
    '-c', `mcp_servers.forge.command=${tomlString(spec.command)}`,
    '-c', `mcp_servers.forge.args=${tomlArray(spec.args)}`,
    '-c', `mcp_servers.forge.env=${tomlInlineTable(spec.env)}`
  ]
}

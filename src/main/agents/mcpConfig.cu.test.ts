import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { COMPUTER_TOOLS } from '@shared/computerUse'
import { forgeCodexConfigArgs, forgeMcpArgs, forgeMcpConfigFile } from './mcpConfig'

// I-1: a computer-use token (`cu.…`) must not show up in argv (`ps` shows every process's args to every local
// user) or in a directory listing. Non-cu agent ids keep today's behaviour (mcpConfig.test.ts is unchanged).
const TOKEN = 'cu.ABCDEFGHJKLMNPQR'
let dir: string
const env = () => ({
  FORGE_SOCKET: join(dir, 'cu.sock'), FORGE_MCP_DIR: dir, FORGE_AGENT_ID: TOKEN,
  FORGE_MCP_ENTRY: '/x/forgeMcp.js', FORGE_TOOLS: COMPUTER_TOOLS.join(','),
})
const leaks = (s: string) => s.includes('ABCDEFGHJKLMNPQR')

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mcpcu-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('claude: --mcp-config for a cu token', () => {
  it('the file name does not carry the token; the content does; the file is 0600', () => {
    const args = forgeMcpArgs(env())
    expect(args[0]).toBe('--mcp-config')
    expect(args.some(leaks)).toBe(false)
    expect(args[1]).toBe(forgeMcpConfigFile(dir, TOKEN))
    expect(readFileSync(args[1], 'utf8')).toContain(TOKEN)
    expect(statSync(args[1]).mode & 0o777).toBe(0o600)
  })

  it('forgeMcpConfigFile is stable per token and differs between tokens', () => {
    expect(forgeMcpConfigFile(dir, TOKEN)).toBe(forgeMcpConfigFile(dir, TOKEN))
    expect(forgeMcpConfigFile(dir, TOKEN)).not.toBe(forgeMcpConfigFile(dir, 'cu.ZZZZZZZZZZZZZZZZ'))
  })

  it('non-cu ids keep mcp.<safeId>.json', () => {
    expect(forgeMcpConfigFile(dir, 'stage:dev-1')).toBe(join(dir, 'mcp.stage_dev-1.json'))
  })
})

describe('codex: -c overrides for a cu token', () => {
  it('no argv element carries the token; FORGE_AGENT_ID is forwarded from codex\'s env instead', () => {
    const args = forgeCodexConfigArgs(env())
    expect(args.some(leaks)).toBe(false)
    expect(args).toContain('mcp_servers.forge.env_vars=["FORGE_AGENT_ID"]')
    const envArg = args[args.indexOf('-c', args.findIndex((a) => a.startsWith('mcp_servers.forge.env=')) - 1) + 1]
    expect(envArg).toMatch(/FORGE_SOCKET=/)
    expect(envArg).not.toMatch(/FORGE_AGENT_ID/)
  })

  it('non-cu ids keep FORGE_AGENT_ID inline and add no env_vars', () => {
    const args = forgeCodexConfigArgs({ ...env(), FORGE_AGENT_ID: 'stage:dev' })
    expect(args.some((a) => a.includes('env_vars'))).toBe(false)
    expect(args.find((a) => a.startsWith('mcp_servers.forge.env='))).toMatch(/FORGE_AGENT_ID="stage:dev"/)
  })
})

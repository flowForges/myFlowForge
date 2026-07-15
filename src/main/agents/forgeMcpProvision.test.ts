import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { provisionForgeMcp } from './forgeMcpProvision'
import { forgeServerSpec } from './mcpConfig'

let cwd: string
const env = () => ({ FORGE_SOCKET: join(cwd, '.forge/x/forge.sock'), FORGE_AGENT_ID: 'chat', FORGE_MCP_ENTRY: '/app/out/main/forgeMcp.js', FORGE_TOOLS: 'forge_propose_plan,forge_delegate' })
beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), 'prov-')) })
afterEach(() => rmSync(cwd, { recursive: true, force: true }))

it('forge 未注入 → 空 extraArgs', () => {
  expect(provisionForgeMcp('cursor', { }, cwd)).toEqual({ extraArgs: [] })
})

it('copilot（Tier1）→ --additional-mcp-config JSON + --allow-all-tools，不落文件', () => {
  const r = provisionForgeMcp('copilot', env(), cwd)
  expect(r.extraArgs[0]).toBe('--additional-mcp-config')
  expect(JSON.parse(r.extraArgs[1]).mcpServers.forge.command).toBe(process.execPath) // forgeServerSpec.command = execPath
  expect(r.extraArgs).toContain('--allow-all-tools')
  expect(r.gitignoreHint).toBeUndefined()
  expect(existsSync(join(cwd, '.cursor/mcp.json'))).toBe(false)
})

it('cursor（Tier2）→ 写 .cursor/mcp.json 合并 + --approve-mcps + hint', () => {
  const r = provisionForgeMcp('cursor', env(), cwd)
  expect(r.extraArgs).toContain('--approve-mcps')
  expect(r.gitignoreHint).toBe('.cursor/mcp.json')
  const cfg = JSON.parse(readFileSync(join(cwd, '.cursor/mcp.json'), 'utf8'))
  expect(cfg.mcpServers.forge.env.FORGE_SOCKET).toBe(env().FORGE_SOCKET)
})

it('cursor 合并保留用户已有 server', () => {
  mkdirSync(join(cwd, '.cursor'), { recursive: true })
  writeFileSync(join(cwd, '.cursor/mcp.json'), JSON.stringify({ mcpServers: { mine: { command: 'x' } } }))
  provisionForgeMcp('cursor', env(), cwd)
  const cfg = JSON.parse(readFileSync(join(cwd, '.cursor/mcp.json'), 'utf8'))
  expect(cfg.mcpServers.mine).toBeTruthy()
  expect(cfg.mcpServers.forge).toBeTruthy()
})

it('cursor 配置损坏 → 备份 .forge-bak 再新建', () => {
  mkdirSync(join(cwd, '.cursor'), { recursive: true })
  writeFileSync(join(cwd, '.cursor/mcp.json'), '{ not json')
  provisionForgeMcp('cursor', env(), cwd)
  expect(existsSync(join(cwd, '.cursor/mcp.json.forge-bak'))).toBe(true)
  expect(JSON.parse(readFileSync(join(cwd, '.cursor/mcp.json'), 'utf8')).mcpServers.forge).toBeTruthy()
})

it('gemini → .gemini/settings.json forge.trust=true + yolo 参数', () => {
  const r = provisionForgeMcp('gemini', env(), cwd)
  expect(r.extraArgs).toEqual(expect.arrayContaining(['--approval-mode', 'yolo', '--allowed-mcp-server-names', 'forge']))
  const cfg = JSON.parse(readFileSync(join(cwd, '.gemini/settings.json'), 'utf8'))
  expect(cfg.mcpServers.forge.trust).toBe(true)
})

it('qwen → .qwen/settings.json（与 gemini 同结构）', () => {
  provisionForgeMcp('qwen', env(), cwd)
  expect(existsSync(join(cwd, '.qwen/settings.json'))).toBe(true)
})

it('opencode → opencode.json mcp.forge type=local enabled', () => {
  const r = provisionForgeMcp('opencode', env(), cwd)
  const cfg = JSON.parse(readFileSync(join(cwd, 'opencode.json'), 'utf8'))
  expect(cfg.mcp.forge.type).toBe('local')
  expect(cfg.mcp.forge.enabled).toBe(true)
  expect(cfg.mcp.forge.command[0]).toBe(env2command()) // command 数组首项=execPath
  expect(r.gitignoreHint).toBe('opencode.json')
})
function env2command() { return forgeServerSpec(env())!.command }

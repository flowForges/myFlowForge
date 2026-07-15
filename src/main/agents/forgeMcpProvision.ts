import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { forgeServerSpec, type ForgeServerSpec } from './mcpConfig'

export interface ForgeProvision {
  /** 拼进该 CLI 的 chat/run 参数。 */
  extraArgs: string[]
  /** Tier 2：写入项目的相对路径，供上层一次性提示用户 gitignore。 */
  gitignoreHint?: string
}

function readJson(path: string): Record<string, any> {
  if (!existsSync(path)) return {}
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch {
    try { writeFileSync(path + '.forge-bak', readFileSync(path)) } catch { /* best-effort */ }
    return {}
  }
}
function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf8')
}

/** Tier 1: copilot 每次调用内联 MCP（不落项目文件）。 */
function copilot(spec: ForgeServerSpec): ForgeProvision {
  return { extraArgs: ['--additional-mcp-config', JSON.stringify({ mcpServers: { forge: spec } }), '--allow-all-tools'] }
}

/** Tier 2: cursor —— .cursor/mcp.json（Cursor MCP 结构 = claude 风格）。 */
function cursor(spec: ForgeServerSpec, cwd: string): ForgeProvision {
  const rel = '.cursor/mcp.json'
  const path = join(cwd, rel)
  const cfg = readJson(path)
  cfg.mcpServers = { ...(cfg.mcpServers ?? {}), forge: spec }
  writeJson(path, cfg)
  return { extraArgs: ['--approve-mcps'], gitignoreHint: rel }
}

/** Tier 2: gemini/qwen —— <dir>/settings.json，forge.trust=true 绕单条审批 + 运行时 yolo。 */
function geminiFamily(spec: ForgeServerSpec, cwd: string, dir: '.gemini' | '.qwen'): ForgeProvision {
  const rel = `${dir}/settings.json`
  const path = join(cwd, rel)
  const cfg = readJson(path)
  cfg.mcpServers = { ...(cfg.mcpServers ?? {}), forge: { command: spec.command, args: spec.args, env: spec.env, trust: true } }
  writeJson(path, cfg)
  return { extraArgs: ['--approval-mode', 'yolo', '--allowed-mcp-server-names', 'forge'], gitignoreHint: rel }
}

/** Tier 2: opencode —— opencode.json mcp.forge（command 为数组）。审批键在 Task 6 按实测定，先给默认。 */
function opencode(spec: ForgeServerSpec, cwd: string): ForgeProvision {
  const rel = 'opencode.json'
  const path = join(cwd, rel)
  const cfg = readJson(path)
  cfg.mcp = { ...(cfg.mcp ?? {}), forge: { type: 'local', command: [spec.command, ...spec.args], environment: spec.env, enabled: true } }
  writeJson(path, cfg)
  return { extraArgs: [], gitignoreHint: rel }
}

export function provisionForgeMcp(providerId: string, env: NodeJS.ProcessEnv, cwd: string): ForgeProvision {
  const spec = forgeServerSpec(env)
  if (!spec) return { extraArgs: [] }
  switch (providerId) {
    case 'copilot': return copilot(spec)
    case 'cursor': return cursor(spec, cwd)
    case 'gemini': return geminiFamily(spec, cwd, '.gemini')
    case 'qwen': return geminiFamily(spec, cwd, '.qwen')
    case 'opencode': return opencode(spec, cwd)
    default: return { extraArgs: [] }
  }
}

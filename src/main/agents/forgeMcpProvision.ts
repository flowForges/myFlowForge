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

/** Tier 2: gemini —— .gemini/settings.json，forge.trust=true 绕单条审批 + 运行时 yolo。 */
function geminiFamily(spec: ForgeServerSpec, cwd: string, dir: '.gemini'): ForgeProvision {
  const rel = `${dir}/settings.json`
  const path = join(cwd, rel)
  const cfg = readJson(path)
  cfg.mcpServers = { ...(cfg.mcpServers ?? {}), forge: { command: spec.command, args: spec.args, env: spec.env, trust: true } }
  writeJson(path, cfg)
  return { extraArgs: ['--approval-mode', 'yolo', '--allowed-mcp-server-names', 'forge'], gitignoreHint: rel }
}

/**
 * Tier 2: qwen —— .qwen/settings.json，forge.trust=true 绕单条审批。
 * qwen (installed: v0.19.10) is an OLD gemini-cli fork WITHOUT `--approval-mode`/`--yolo`/
 * `--allowed-mcp-server-names` flags (verified via `qwen --help`; passing them errors "unknown
 * option"). So unlike gemini, qwen has no runtime flag to bypass tool-confirmation — it relies
 * solely on the config-level `trust: true` in the server entry. extraArgs stays empty.
 */
function qwen(spec: ForgeServerSpec, cwd: string): ForgeProvision {
  const rel = '.qwen/settings.json'
  const path = join(cwd, rel)
  const cfg = readJson(path)
  cfg.mcpServers = { ...(cfg.mcpServers ?? {}), forge: { command: spec.command, args: spec.args, env: spec.env, trust: true } }
  writeJson(path, cfg)
  return { extraArgs: [], gitignoreHint: rel }
}

/**
 * Tier 2: opencode —— opencode.json mcp.forge（command 为数组）。
 * 实测（opencode 1.3.13）：MCP 工具名不在 permission 白名单枚举（read/edit/bash/…/doom_loop/
 * external_directory）里，按文档 "Most permissions default to allow" 走默认放行；`opencode mcp
 * list` 确认 forge 已连接，`opencode run` headless 调用 forge_delegate 直接 completed（无 ask 卡
 * 住、无需交互）。故 enabled:true 已足够，不需要额外 permission 键。
 */
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
    case 'qwen': return qwen(spec, cwd)
    case 'opencode': return opencode(spec, cwd)
    default: return { extraArgs: [] }
  }
}

/**
 * Tier-2 providers inject the forge MCP server by writing a FIXED project-relative config file into the
 * agent's cwd (.cursor/mcp.json · .gemini|.qwen/settings.json · opencode.json). That file embeds
 * FORGE_AGENT_ID and is the ONLY channel the spawned MCP child reads its identity from — the CLIs do NOT
 * pass their process env through to the stdio MCP child (empirically verified for opencode). So two
 * same-cwd agents with DIFFERENT FORGE_AGENT_IDs read-modify-write the SAME file (last-writer-wins) and
 * the earlier agent's CLI ends up reading a config carrying the LATER agent's id → its forge_heartbeat /
 * forge_handoff / forge_write_artifact calls are mis-attributed at the bridge.
 *
 * Tier-1 providers are immune and must NOT be serialized: claude/qoder write per-agent mcp.<id>.json,
 * codex uses `-c` inline overrides, copilot inlines the server on the argv — no shared file.
 */
const SHARED_FORGE_CONFIG_PROVIDERS = new Set(['cursor', 'gemini', 'qwen', 'opencode'])
export function usesSharedForgeConfig(providerId: string): boolean {
  return SHARED_FORGE_CONFIG_PROVIDERS.has(providerId)
}

// key (cwd) → tail of that key's serialization chain. Absent key = no one holds the lock.
const cwdLockTails = new Map<string, Promise<void>>()

/**
 * Per-key async mutex that serializes the vulnerable write→spawn→CLI-reads-config window for same-cwd
 * Tier-2 agents (see usesSharedForgeConfig). `fn` (the agent's whole run) runs to completion before the
 * next same-key `fn` starts, so no agent overwrites the shared config until the previous same-cwd CLI has
 * finished reading it. DISTINCT keys never block each other — distinct-cwd fan-out stays fully parallel —
 * and callers gate on usesSharedForgeConfig() so Tier-1 providers never take the lock at all.
 *
 * Tradeoff: same-cwd Tier-2 agents (today only multi-lens review with a Tier-2 provider) run serially.
 * Releasing on the agent's run completing is coarser than releasing the instant the MCP child connects to
 * the bridge, but it needs no signal from the child and is unconditionally correct.
 */
export function withCwdMcpLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = cwdLockTails.get(key) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>(res => { release = res })
  cwdLockTails.set(key, gate)
  // Run fn only after the previous holder settles (recover from its rejection so the chain never wedges).
  const result = prev.then(fn, fn)
  // Release the next waiter once fn settles, then GC the map entry if we're still the tail.
  result.then(release, release).then(() => { if (cwdLockTails.get(key) === gate) cwdLockTails.delete(key) })
  return result
}

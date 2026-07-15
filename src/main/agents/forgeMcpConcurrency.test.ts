import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { provisionForgeMcp, usesSharedForgeConfig, withCwdMcpLock } from './forgeMcpProvision'

// Reproduces the same-cwd Tier-2 config-clobber race. Tier-2 providers inject the forge MCP server by
// writing a FIXED project-relative config file into the agent's cwd; that file embeds FORGE_AGENT_ID and
// is the ONLY channel the spawned MCP child reads its identity from. Two same-cwd agents with different
// ids read-modify-write the SAME file, and the CLI reads it asynchronously AFTER spawn — so the earlier
// agent's CLI observes a config carrying the LATER agent's id → mis-attributed forge_* calls.

let cwd: string
let cwdB: string
const envFor = (agentId: string, base = cwd) => ({
  FORGE_SOCKET: join(base, '.forge/x/forge.sock'),
  FORGE_AGENT_ID: agentId,
  FORGE_MCP_ENTRY: '/app/out/main/forgeMcp.js',
  FORGE_TOOLS: 'forge_handoff',
})

// Model one agent: provision the shared config (synchronous write at spawn), then read the config back
// after an async tick (the CLI reads it later, out of band) and record which id its MCP child would see.
async function runAgent(dir: string, agentId: string, observed: { agentId: string; seen: string }[]) {
  provisionForgeMcp('opencode', envFor(agentId, dir), dir)
  await new Promise(r => setTimeout(r, 8))
  const cfg = JSON.parse(readFileSync(join(dir, 'opencode.json'), 'utf8'))
  observed.push({ agentId, seen: cfg.mcp.forge.environment.FORGE_AGENT_ID })
}

beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), 'mcpc-a-')); cwdB = mkdtempSync(join(tmpdir(), 'mcpc-b-')) })
afterEach(() => { rmSync(cwd, { recursive: true, force: true }); rmSync(cwdB, { recursive: true, force: true }) })

describe('forge MCP same-cwd Tier-2 concurrency', () => {
  it('predicate marks only shared-config (Tier-2) providers', () => {
    for (const p of ['cursor', 'gemini', 'qwen', 'opencode']) expect(usesSharedForgeConfig(p)).toBe(true)
    for (const p of ['claude', 'qoder', 'codex', 'copilot']) expect(usesSharedForgeConfig(p)).toBe(false)
  })

  it('REPRO: parallel same-cwd Tier-2 without the lock mis-attributes the agent id', async () => {
    const observed: { agentId: string; seen: string }[] = []
    await Promise.all([runAgent(cwd, 'agent-A', observed), runAgent(cwd, 'agent-B', observed)])
    // Both CLIs read the same file after both writes landed → at least one sees the wrong id.
    const misattributed = observed.filter(o => o.seen !== o.agentId)
    expect(misattributed.length).toBeGreaterThan(0)
  })

  it('withCwdMcpLock serializes same cwd → each agent observes its OWN id', async () => {
    const observed: { agentId: string; seen: string }[] = []
    await Promise.all([
      withCwdMcpLock(cwd, () => runAgent(cwd, 'agent-A', observed)),
      withCwdMcpLock(cwd, () => runAgent(cwd, 'agent-B', observed)),
    ])
    expect(observed).toHaveLength(2)
    for (const o of observed) expect(o.seen).toBe(o.agentId)
  })

  it('withCwdMcpLock does NOT serialize distinct cwds (fan-out stays parallel)', async () => {
    const order: string[] = []
    const task = (key: string, label: string) => withCwdMcpLock(key, async () => {
      order.push(`${label}:start`)
      await new Promise(r => setTimeout(r, 20))
      order.push(`${label}:end`)
    })
    await Promise.all([task(cwd, 'A'), task(cwdB, 'B')])
    // Distinct keys overlap: both start before either ends.
    expect(order.indexOf('A:start')).toBeLessThan(order.indexOf('B:end'))
    expect(order.indexOf('B:start')).toBeLessThan(order.indexOf('A:end'))
  })

  it('withCwdMcpLock same key runs strictly one-at-a-time', async () => {
    const order: string[] = []
    const task = (label: string) => withCwdMcpLock(cwd, async () => {
      order.push(`${label}:start`)
      await new Promise(r => setTimeout(r, 15))
      order.push(`${label}:end`)
    })
    await Promise.all([task('A'), task('B')])
    // Serial: A fully finishes before B starts (no interleave).
    expect(order).toEqual(['A:start', 'A:end', 'B:start', 'B:end'])
  })

  it('withCwdMcpLock survives a rejecting critical section (next waiter still runs)', async () => {
    const ran: string[] = []
    const bad = withCwdMcpLock(cwd, async () => { throw new Error('boom') })
    const good = withCwdMcpLock(cwd, async () => { ran.push('good') })
    await expect(bad).rejects.toThrow('boom')
    await good
    expect(ran).toEqual(['good'])
  })
})

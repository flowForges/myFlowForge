import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseOpencodeEvent, opencodeErrorMessage, opencodeUsage, parseOpencodeModels, opencodeDelta, makeOpencodeProvider, opencodeReadonlyEnv, OPENCODE_READONLY_AGENT } from './opencode'
import type { PermissionMode } from '@shared/permissions'

describe('opencodeDelta (cumulative part.text → incremental delta)', () => {
  it('emits only the growth for cumulative snapshots (the real opencode --format json shape)', () => {
    // opencode streams the FULL text of a part on every update; feeding those as deltas must yield
    // the original text once, not a quadratic pile-up.
    const snaps = ['分', '分析', '分析仓', '分析仓库']
    let prev = ''
    let assembled = ''
    for (const s of snaps) { assembled += opencodeDelta(prev, s); prev = s }
    expect(assembled).toBe('分析仓库')   // NOT '分分析分析仓分析仓库'
  })
  it('passes genuine incremental deltas through unchanged (prefix check auto-detects)', () => {
    const deltas = ['Hello', ' world', ' foo']
    let prev = ''
    let assembled = ''
    for (const d of deltas) { assembled += opencodeDelta(prev, d); prev = d }
    expect(assembled).toBe('Hello world foo')
  })
  it('resets cleanly when a new part starts (text no longer extends the previous)', () => {
    expect(opencodeDelta('Hello world', 'OK')).toBe('OK')
  })
})

describe('parseOpencodeEvent', () => {
  it('reasoning → think', () => {
    expect(parseOpencodeEvent({ type: 'reasoning', part: { type: 'reasoning', text: 'thinking…' } }))
      .toEqual([{ kind: 'think', text: 'thinking…' }])
  })
  it('text → assistant', () => {
    expect(parseOpencodeEvent({ type: 'text', part: { type: 'text', text: 'hi' } }))
      .toEqual([{ kind: 'assistant', text: 'hi' }])
  })
  it('step_start → session id', () => {
    expect(parseOpencodeEvent({ type: 'step_start', sessionID: 'ses_1', part: {} }))
      .toEqual([{ kind: 'session', id: 'ses_1' }])
  })
  it('empty text is ignored; non-object → []', () => {
    expect(parseOpencodeEvent({ type: 'text', part: { text: '' } })).toEqual([])
    expect(parseOpencodeEvent(null)).toEqual([])
  })
})

describe('opencodeErrorMessage', () => {
  it('extracts the nested API error message (401 etc.)', () => {
    const ev = { type: 'error', error: { name: 'APIError', data: { message: 'The API key status is not active', statusCode: 401 } } }
    expect(opencodeErrorMessage(ev)).toBe('The API key status is not active')
  })
  it('non-error event → null', () => {
    expect(opencodeErrorMessage({ type: 'text', part: { text: 'hi' } })).toBeNull()
  })
})

describe('opencodeUsage', () => {
  it('reads tokens.total from step_finish', () => {
    expect(opencodeUsage({ type: 'step_finish', part: { tokens: { total: 19894 } } })).toBe(19894)
    expect(opencodeUsage({ type: 'text', part: { text: 'x' } })).toBeNull()
  })
})

describe('parseOpencodeModels', () => {
  it('maps "provider/model" lines, keeping the full id, label=model, desc=provider', () => {
    const out = parseOpencodeModels('opencode/big-pickle\nmyprovider/ark-code-latest\n\ngarbage')
    expect(out).toEqual([
      { id: 'opencode/big-pickle', label: 'big-pickle', description: 'opencode' },
      { id: 'myprovider/ark-code-latest', label: 'ark-code-latest', description: 'myprovider' },
    ])
  })
})

// ── readonly launch (fake CLI dumps argv + the env vars that matter) ──────────

describe('opencode readonly', () => {
  let dir: string, bin: string, out: string
  const DUMP = `#!/usr/bin/env node
require('node:fs').writeFileSync(process.env.DUMP_OUT, JSON.stringify({ argv: process.argv.slice(2),
  content: process.env.OPENCODE_CONFIG_CONTENT ?? null, noProject: process.env.OPENCODE_DISABLE_PROJECT_CONFIG ?? null,
  keep: process.env.KEEP_ME ?? null }))
process.stdout.write(JSON.stringify({ type: 'text', part: { text: 'ok' } }) + '\\n')
process.exit(0)
`
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oc-ro-'))
    bin = join(dir, 'dump.js'); writeFileSync(bin, DUMP); chmodSync(bin, 0o755)
    out = join(dir, 'out.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  type Dump = { argv: string[]; content: string | null; noProject: string | null; keep: string | null }
  const env = (extra: NodeJS.ProcessEnv = {}) => ({ ...process.env, DUMP_OUT: out, KEEP_ME: 'yes', OPENCODE_CONFIG_CONTENT: undefined, OPENCODE_DISABLE_PROJECT_CONFIG: undefined, ...extra })
  const runDump = async (mode: PermissionMode | undefined, extra: NodeJS.ProcessEnv = {}): Promise<Dump> => {
    const cb = { onLog() {}, onState() {}, onConfirm: async () => 'allow' as const, onInput: async () => '', onDone() {}, onError() {} }
    await makeOpencodeProvider({ bin, defaultModels: [] }).run({ stageKey: 's', agentId: 'a', name: 'n', prompt: 'hello', cwd: dir, model: 'default', permissionMode: mode }, cb, env(extra)).done
    return JSON.parse(readFileSync(out, 'utf8'))
  }
  const chatDump = async (mode: PermissionMode | undefined, extra: NodeJS.ProcessEnv = {}): Promise<Dump> => {
    const cb = { onSession() {}, onAssistantDelta() {}, onThinkDelta() {}, onDone() {}, onError() {} }
    await makeOpencodeProvider({ bin, defaultModels: [] }).chat!({ id: 'c', prompt: 'hello', model: 'default', cwd: dir, sessionId: 'ses_1', permissionMode: mode }, cb, env(extra)).done
    return JSON.parse(readFileSync(out, 'utf8'))
  }
  const expectReadonlyAgent = (content: string | null) => {
    const perm = JSON.parse(content!).agent[OPENCODE_READONLY_AGENT].permission
    expect(Object.keys(perm)[0]).toBe('*')          // last match wins → the catch-all deny must come first
    expect(perm['*']).toBe('deny')
    for (const t of ['read', 'grep', 'glob', 'list']) expect(perm[t]).toBe('allow')
    for (const t of ['edit', 'bash', 'task', 'question', 'webfetch', 'external_directory']) expect(perm[t]).toBe('deny')
  }

  it('run(): --agent forge-readonly + config via env + project config disabled, other env kept', async () => {
    const d = await runDump('readonly')
    expect(d.argv).toEqual(['run', '--format', 'json', '--thinking', '--agent', OPENCODE_READONLY_AGENT, '--dir', dir, 'hello'])
    expectReadonlyAgent(d.content)
    expect(d.noProject).toBe('1')
    expect(d.keep).toBe('yes')
  })
  it('chat(): same, with -s resume', async () => {
    const d = await chatDump('readonly')
    expect(d.argv).toEqual(['run', '--format', 'json', '--thinking', '-s', 'ses_1', '--agent', OPENCODE_READONLY_AGENT, '--dir', dir, 'hello'])
    expectReadonlyAgent(d.content)
    expect(d.noProject).toBe('1')
  })
  it.each(['auto', 'full', undefined] as const)('%s: unchanged argv, no injected env', async (m) => {
    {
      const r = await runDump(m)
      expect(r.argv).toEqual(['run', '--format', 'json', '--thinking', '--dir', dir, 'hello'])
      expect(r.content).toBeNull(); expect(r.noProject).toBeNull()
      const c = await chatDump(m)
      expect(c.argv).toEqual(['run', '--format', 'json', '--thinking', '-s', 'ses_1', '--dir', dir, 'hello'])
      expect(c.content).toBeNull()
    }
  })
  it('merges into a user-supplied OPENCODE_CONFIG_CONTENT instead of clobbering it', () => {
    const e = opencodeReadonlyEnv({ OPENCODE_CONFIG_CONTENT: JSON.stringify({ theme: 'x', agent: { mine: { mode: 'primary' } } }), PATH: '/bin' })
    const cfg = JSON.parse(e.OPENCODE_CONFIG_CONTENT!)
    expect(cfg.theme).toBe('x')
    expect(cfg.agent.mine).toEqual({ mode: 'primary' })
    expectReadonlyAgent(e.OPENCODE_CONFIG_CONTENT!)
    expect(e.PATH).toBe('/bin')
    // unparsable user value → ours wins (readonly must not silently fail open)
    expectReadonlyAgent(opencodeReadonlyEnv({ OPENCODE_CONFIG_CONTENT: '{nope' }).OPENCODE_CONFIG_CONTENT!)
  })
  it('forge env present: forge MCP rides the same OPENCODE_CONFIG_CONTENT and its tools are allowed after "*":"deny"', () => {
    const e = opencodeReadonlyEnv({ FORGE_SOCKET: '/tmp/f.sock', FORGE_AGENT_ID: 'a1', FORGE_MCP_ENTRY: '/x/forgeMcp.js', FORGE_TOOLS: 'forge_handoff,forge_ask' })
    const cfg = JSON.parse(e.OPENCODE_CONFIG_CONTENT!)
    expect(cfg.mcp.forge).toMatchObject({ type: 'local', enabled: true, command: [process.execPath, '/x/forgeMcp.js'] })
    expect(cfg.mcp.forge.environment).toMatchObject({ FORGE_SOCKET: '/tmp/f.sock', FORGE_AGENT_ID: 'a1', FORGE_TOOLS: 'forge_handoff,forge_ask' })
    const perm = cfg.agent[OPENCODE_READONLY_AGENT].permission
    const keys = Object.keys(perm)
    // exact opencode names (<server>_<tool>), never a forge_* wildcard that would also cover a user server like forge_tools
    expect(perm['forge_*']).toBeUndefined()
    expect(perm.forge_forge_handoff).toBe('allow')
    expect(perm.forge_forge_ask).toBe('allow')
    expect(keys.filter(k => k.startsWith('forge_'))).toEqual(['forge_forge_handoff', 'forge_forge_ask'])
    expect(keys.indexOf('forge_forge_handoff')).toBeGreaterThan(keys.indexOf('*'))
  })
  it('forge env without FORGE_TOOLS: forge server injected but no allow entries (nothing to name exactly)', () => {
    const cfg = JSON.parse(opencodeReadonlyEnv({ FORGE_SOCKET: '/s', FORGE_AGENT_ID: 'a', FORGE_MCP_ENTRY: '/e' }).OPENCODE_CONFIG_CONTENT!)
    expect(cfg.mcp.forge).toBeTruthy()
    expect(Object.keys(cfg.agent[OPENCODE_READONLY_AGENT].permission).some(k => k.startsWith('forge_'))).toBe(false)
  })
  it('no forge env: no mcp key, no forge allow rule (council seats)', () => {
    const cfg = JSON.parse(opencodeReadonlyEnv({}).OPENCODE_CONFIG_CONTENT!)
    expect(cfg.mcp).toBeUndefined()
    expect(cfg.agent[OPENCODE_READONLY_AGENT].permission['forge_*']).toBeUndefined()
  })
  it('keeps the user\'s other MCP servers in the merged config (they stay denied by "*")', () => {
    const e = opencodeReadonlyEnv({ OPENCODE_CONFIG_CONTENT: JSON.stringify({ mcp: { mine: { type: 'remote', url: 'x' } } }), FORGE_SOCKET: '/s', FORGE_AGENT_ID: 'a', FORGE_MCP_ENTRY: '/e' })
    const cfg = JSON.parse(e.OPENCODE_CONFIG_CONTENT!)
    expect(cfg.mcp.mine).toEqual({ type: 'remote', url: 'x' })
    expect(cfg.mcp.forge).toBeTruthy()
  })
  it('OPENCODE_PERMISSION backstop: edit/bash/task/webfetch denied, merged over the user\'s own value', () => {
    expect(JSON.parse(opencodeReadonlyEnv({}).OPENCODE_PERMISSION!)).toEqual({ edit: 'deny', bash: 'deny', task: 'deny', webfetch: 'deny' })
    const merged = JSON.parse(opencodeReadonlyEnv({ OPENCODE_PERMISSION: JSON.stringify({ read: 'allow', bash: 'allow' }) }).OPENCODE_PERMISSION!)
    expect(merged).toEqual({ read: 'allow', bash: 'deny', edit: 'deny', task: 'deny', webfetch: 'deny' })
    expect(JSON.parse(opencodeReadonlyEnv({ OPENCODE_PERMISSION: 'nope' }).OPENCODE_PERMISSION!).bash).toBe('deny')
  })
})

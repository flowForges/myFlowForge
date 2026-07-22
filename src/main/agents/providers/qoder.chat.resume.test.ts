import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeQoderProvider } from './qoder'
import { getAppLog, clearAppLog } from '../../log/appLog'
import type { ChatCallbacks } from '../types'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'qoder-resume-')); clearAppLog() })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

// Fake qodercli: rejects a --resume with "invalid session identifier" (exit 1), but succeeds fresh.
const FAKE_INVALID_RESUME = `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args.includes('--resume')) { process.stderr.write('invalid session identifier\\n'); process.exit(1) }
const out = o => process.stdout.write(JSON.stringify(o) + '\\n')
out({ session_id: 'fresh-qoder-id' })
out({ type: 'assistant', text: '你好(已新开会话)' })
out({ type: 'result' })
process.exit(0)
`

// Fake qodercli: a genuine auth error — fails regardless of --resume (must NOT be retried).
const FAKE_AUTH_FAIL = `#!/usr/bin/env node
process.stderr.write('authentication failed: please login\\n'); process.exit(1)
`

// Fake qodercli: rejects a --resume because the resumed session references a forge MCP config
// path (a pre-run2 session's --mcp-config <ws>/.forge/runs/chat-bridge/mcp.chat.json, which
// bridge.close() deleted and the current build never re-writes for plain chat), but succeeds fresh.
const FAKE_STALE_MCP_CONFIG = `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args.includes('--resume')) { process.stderr.write("Error: ENOENT: no such file or directory, open '.forge/runs/chat-bridge/mcp.chat.json' (--mcp-config)\\n"); process.exit(1) }
const out = o => process.stdout.write(JSON.stringify(o) + '\\n')
out({ session_id: 'fresh-qoder-id-2' })
out({ type: 'assistant', text: '你好(MCP 配置失效已新开会话)' })
out({ type: 'result' })
process.exit(0)
`

function mkCb() {
  const state = { text: '', think: '', sessions: [] as string[], errored: false }
  const cb: ChatCallbacks = {
    onSession: id => state.sessions.push(id),
    onAssistantDelta: t => { state.text += t },
    onThinkDelta: t => { state.think += t },
    onDone: () => {},
    onError: () => { state.errored = true },
  }
  return { cb, state }
}

describe('qoder chat() self-heals an invalid resume session id', () => {
  it('retries without --resume and emits a fresh session id when the resume id is rejected', async () => {
    const bin = join(dir, 'qoder.js'); writeFileSync(bin, FAKE_INVALID_RESUME); chmodSync(bin, 0o755)
    const provider = makeQoderProvider({ bin, defaultModels: [] })
    const { cb, state } = mkCb()
    const s = provider.chat!({ id: 'a1', prompt: 'hi', model: 'default', cwd: dir, sessionId: 'stale-foreign-id' }, cb, process.env)
    await s.done
    // Retried fresh → got the real reply, not the failure bubble.
    expect(state.text).toContain('已新开会话')
    expect(state.text).not.toContain('Qoder 执行失败')
    // Emitted the fresh, valid qoder id → chatService overwrites the bad stored id (self-heal).
    expect(state.sessions).toContain('fresh-qoder-id')
    // Logged for diagnosability.
    expect(getAppLog().some(e => e.scope === 'qoder' && /resume/.test(e.msg))).toBe(true)
  })

  it('does NOT retry on a non-session failure (e.g. auth) — surfaces the error', async () => {
    const bin = join(dir, 'qoder.js'); writeFileSync(bin, FAKE_AUTH_FAIL); chmodSync(bin, 0o755)
    const provider = makeQoderProvider({ bin, defaultModels: [] })
    const { cb, state } = mkCb()
    const s = provider.chat!({ id: 'a1', prompt: 'hi', model: 'default', cwd: dir, sessionId: 'some-id' }, cb, process.env)
    await s.done
    expect(state.text).toContain('Qoder 执行失败')
    expect(state.text).toContain('authentication failed')
    expect(getAppLog().some(e => e.scope === 'qoder' && e.level === 'error')).toBe(true)
  })

  it('retries without --resume when resume fails because the resumed session references a missing forge mcp-config', async () => {
    const bin = join(dir, 'qoder.js'); writeFileSync(bin, FAKE_STALE_MCP_CONFIG); chmodSync(bin, 0o755)
    const provider = makeQoderProvider({ bin, defaultModels: [] })
    const { cb, state } = mkCb()
    const s = provider.chat!({ id: 'a1', prompt: 'hi', model: 'default', cwd: dir, sessionId: 'stale-pre-run2-id' }, cb, process.env)
    await s.done
    // Retried fresh → got the real reply, not the failure bubble.
    expect(state.text).toContain('MCP 配置失效已新开会话')
    expect(state.text).not.toContain('Qoder 执行失败')
    // Emitted the fresh, valid qoder id → chatService overwrites the bad stored id (self-heal).
    expect(state.sessions).toContain('fresh-qoder-id-2')
    // Logged for diagnosability.
    expect(getAppLog().some(e => e.scope === 'qoder' && /resume/.test(e.msg))).toBe(true)
  })

  it('first turn (no sessionId) does not attempt resume and works normally', async () => {
    const bin = join(dir, 'qoder.js'); writeFileSync(bin, FAKE_INVALID_RESUME); chmodSync(bin, 0o755)
    const provider = makeQoderProvider({ bin, defaultModels: [] })
    const { cb, state } = mkCb()
    const s = provider.chat!({ id: 'a1', prompt: 'hi', model: 'default', cwd: dir }, cb, process.env)
    await s.done
    expect(state.text).toContain('已新开会话')
    expect(state.sessions).toContain('fresh-qoder-id')
  })
})

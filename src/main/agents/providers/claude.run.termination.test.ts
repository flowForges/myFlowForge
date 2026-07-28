import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeClaudeProvider } from './claude'
import type { AgentSession } from '../types'

// Regression (commit 910a98a): claude run() was switched to the control protocol
// (`--input-format stream-json`, prompt via stdin, stdin held open for permission responses). In that
// mode claude does NOT self-exit after finishing its turn — it blocks waiting for the next stdin
// message that never comes. workOrder.runWorkOrder resolves a lane only when `session.done`
// (= child process EXIT) resolves, so every stage agent hung forever AFTER already handing off →
// the whole workflow wedged at 0/N for as long as it was left open. run() must treat the `result`
// event (claude's authoritative end-of-turn signal) as completion and terminate the lingering child.
let dir: string
let live: AgentSession | null = null
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'claude-term-')) })
afterEach(() => { try { live?.cancel() } catch { /* already gone */ }; live = null; rmSync(dir, { recursive: true, force: true }) })

// A fake claude that emits its stream then, like real claude under --input-format stream-json,
// holds stdin open and never self-exits. If run() doesn't terminate it, session.done hangs.
function hangingBin(lines: object[]): string {
  const cli = join(dir, 'hang.js')
  const body = `#!/usr/bin/env node
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
const lines = ${JSON.stringify(lines)}
for (const l of lines) out(l)
process.stdin.resume()            // hold stdin open (permission-response channel)
setInterval(() => {}, 1000)       // never self-exit
`
  writeFileSync(cli, body); chmodSync(cli, 0o755)
  return cli
}

const HANG = Symbol('hang')
async function settleOrHang(p: Promise<unknown>, ms: number): Promise<unknown> {
  return Promise.race([p, new Promise((r) => setTimeout(() => r(HANG), ms))])
}

describe('claude run() — terminates on the result event (no post-handoff hang)', () => {
  it('resolves session.done with ok:true after a successful result, even though the process never self-exits', async () => {
    const stream = [
      { type: 'assistant', message: { content: [{ type: 'text', text: '已完成探查并产出设计文档' }] } },
      { type: 'result', subtype: 'success', is_error: false, result: 'ok' },
    ]
    const cli = hangingBin(stream)
    const provider = makeClaudeProvider({ bin: 'node', preArgs: [cli], defaultModels: [] })
    live = provider.run(
      { stageKey: 'design', agentId: 'design:go-blog', name: 'D', prompt: 'x', cwd: dir, model: 'opus-4.8' },
      { onLog: () => {}, onState: () => {}, onConfirm: async () => 'allow', onInput: async () => '', onDone: () => {}, onError: () => {} },
      process.env,
    )
    const result = await settleOrHang(live.done, 4000)
    expect(result).not.toBe(HANG)                    // before fix: process never exits → hangs
    expect((result as { ok: boolean }).ok).toBe(true) // a clean result is success, not `退出码 143`
  })

  it('reports failure when the result event is an error, despite the same non-exiting process', async () => {
    const stream = [
      { type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } },
      { type: 'result', subtype: 'error_max_turns', is_error: true, result: 'hit limit' },
    ]
    const cli = hangingBin(stream)
    const provider = makeClaudeProvider({ bin: 'node', preArgs: [cli], defaultModels: [] })
    live = provider.run(
      { stageKey: 'design', agentId: 'design:zgh', name: 'D', prompt: 'x', cwd: dir, model: 'opus-4.8' },
      { onLog: () => {}, onState: () => {}, onConfirm: async () => 'allow', onInput: async () => '', onDone: () => {}, onError: () => {} },
      process.env,
    )
    const result = await settleOrHang(live.done, 4000)
    expect(result).not.toBe(HANG)
    expect((result as { ok: boolean }).ok).toBe(false)
  })
})

describe('claude chat() — terminates on the result event (turn ends promptly, no busy-hang)', () => {
  it('fires onDone / resolves right after a successful result, even though the process never self-exits', async () => {
    // The reported bug: Claude asks a question in its text and the turn stays `busy` (input just queues,
    // user must 停止) because claude under --input-format stream-json holds stdin open and never exits —
    // the turn only ended when the 240s idle watchdog fired. run() already terminated on `result`; chat()
    // didn't. This proves chat() now does too.
    const stream = [
      { type: 'assistant', session_id: 's', message: { role: 'assistant', content: [{ type: 'text', text: '你想按哪种方式执行？' }] } },
      { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 's' },
    ]
    const cli = hangingBin(stream)
    const provider = makeClaudeProvider({ bin: 'node', preArgs: [cli], defaultModels: [] })
    let doneFired = false
    let text = ''
    live = provider.chat!(
      { id: 'a1', prompt: 'x', model: 'opus-4.8', cwd: dir },
      { onSession: () => {}, onAssistantDelta: (t) => { text += t }, onThinkDelta: () => {}, onDone: () => { doneFired = true }, onError: () => {} },
      process.env,
    )
    const result = await settleOrHang(live.done, 4000)
    expect(result).not.toBe(HANG)                    // before fix: hangs busy until the 240s watchdog
    expect(doneFired).toBe(true)                     // turn ends → busy clears → the user can reply
    expect(text).toContain('你想按哪种方式执行')
    expect((result as { ok: boolean }).ok).toBe(true)
  })
})

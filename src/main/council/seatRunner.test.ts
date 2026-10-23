import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSeat, seatResumeKey, type SeatRunCallbacks, type SeatRunDeps } from './seatRunner'
import { readSession } from '../chat/chatStore'
import type { AgentProvider, ChatCallbacks, ChatTask, ConfirmDecision, ConfirmReq } from '../agents/types'
import type { CouncilSeat } from '@shared/council'

let ws: string
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'seat-runner-')) })
afterEach(() => { vi.useRealTimers(); rmSync(ws, { recursive: true, force: true }) })

const seat = (id: string, provider = 'codex'): CouncilSeat => ({ id, provider, model: 'm1', label: `${provider} · m1` })
const noopCb = (): SeatRunCallbacks => ({ onStart() {}, onDelta() {}, onThink() {}, onReplace() {} })

type Captured = { task?: ChatTask; env?: NodeJS.ProcessEnv; cb?: ChatCallbacks; cancelled: number }
function fakeProvider(id: string, script: (task: ChatTask, cb: ChatCallbacks, cap: Captured) => void) {
  const cap: Captured = { cancelled: 0 }
  const provider: AgentProvider = {
    id, displayName: id,
    capabilities: { structuredOutput: true, permissionHook: true, pty: false },
    async detect() { return true }, async listModels() { return [] },
    run() { return { id: 'x', cancel() {}, done: Promise.resolve({ ok: true }) } },
    chat(task, cb, env) {
      cap.task = task; cap.env = env; cap.cb = cb
      script(task, cb, cap)
      return { id: task.id, cancel() { cap.cancelled++ }, done: new Promise(() => {}) }
    },
  }
  return { provider, cap }
}
const deps = (providers: Record<string, AgentProvider>, extra: Partial<SeatRunDeps> = {}): SeatRunDeps =>
  ({ providers, env: { PATH: '/bin' }, workspacePath: ws, sessionId: 's1', cwd: ws, ...extra })
const okScript = (_t: ChatTask, cb: ChatCallbacks) => { cb.onSession('native-1'); cb.onAssistantDelta('hi'); cb.onDone({ elapsed: 1 }) }

describe('runSeat', () => {
  it('passes readonly + model, no beforeFallback key, strips FORGE_* env', async () => {
    const { provider, cap } = fakeProvider('codex', okScript)
    const r = await runSeat('c1', seat('a'), 'p', deps({ codex: provider }, { env: { PATH: '/bin', FORGE_SOCKET: 's', FORGE_AGENT_ID: 'x', FORGE_MCP_ENTRY: 'e' } }), noopCb()).done
    expect(r.ok).toBe(true)
    expect(cap.task!.permissionMode).toBe('readonly')
    expect(cap.task!.model).toBe('m1')
    expect('beforeFallback' in cap.task!).toBe(false)
    expect(cap.env!.FORGE_SOCKET).toBeUndefined()
    expect(Object.keys(cap.env!).some((k) => k.startsWith('FORGE_'))).toBe(false)
    expect(cap.env!.PATH).toBe('/bin')
  })

  it('a provider without chat() runs its seat through run() with readonly', async () => {
    let seen: { permissionMode?: string; prompt?: string; model?: string } | undefined
    const provider: AgentProvider = {
      id: 'pi', displayName: 'Pi',
      capabilities: { structuredOutput: false, permissionHook: false, pty: false },
      async detect() { return true }, async listModels() { return [] },
      run(task, cb) {
        seen = { permissionMode: task.permissionMode, prompt: task.prompt, model: task.model }
        cb.onLog({ ts: '0', text: '回答', level: 'accent' })
        return { id: task.agentId, cancel() {}, done: Promise.resolve({ ok: true }) }
      },
    }
    const r = await runSeat('c1', seat('a', 'pi'), 'p', deps({ pi: provider }), noopCb()).done
    expect(r).toMatchObject({ ok: true, text: '回答' })
    expect(seen).toEqual({ permissionMode: 'readonly', prompt: 'p', model: 'm1' })
  })

  it('passes attachments through to the provider task (default none)', async () => {
    const { provider, cap } = fakeProvider('codex', okScript)
    const att = [{ name: 'a.png', path: '/tmp/a.png', size: 3 }]
    await runSeat('c1', seat('a'), 'p', deps({ codex: provider }), noopCb(), att).done
    expect(cap.task!.attachments).toEqual(att)
    await runSeat('c1', seat('b'), 'p', deps({ codex: provider }), noopCb()).done
    expect(cap.task!.attachments).toEqual([])
  })

  it('drops callbacks the provider leaks after the run has settled', async () => {
    const { provider } = fakeProvider('codex', (_t, cb) => { cb.onError(new Error('boom')); cb.onAssistantDelta('late'); cb.onThinkDelta?.('late'); cb.onAssistantReplace?.('late') })
    const seen: string[] = []
    const r = await runSeat('c1', seat('a'), 'p', deps({ codex: provider }), {
      onStart() {}, onDelta: (_i, t) => seen.push(t), onThink: (_i, t) => seen.push(t), onReplace: (_i, t) => seen.push(t),
    }).done
    expect(r).toMatchObject({ ok: false, error: 'boom' })
    expect(seen).toEqual([])
  })

  it('streams deltas and returns accumulated text', async () => {
    const { provider } = fakeProvider('codex', (_t, cb) => { cb.onAssistantDelta('a'); cb.onAssistantDelta('b'); cb.onDone({ elapsed: 1 }) })
    const deltas: string[] = []
    const r = await runSeat('c1', seat('a'), 'p', deps({ codex: provider }), { ...noopCb(), onDelta: (_i, t) => deltas.push(t) }).done
    expect(deltas).toEqual(['a', 'b'])
    expect(r).toMatchObject({ ok: true, text: 'ab' })
  })

  it('resumes the same seat, keeps seats and normal chat keys separate', async () => {
    const { provider, cap } = fakeProvider('codex', okScript)
    const first = runSeat('c1', seat('a'), 'p', deps({ codex: provider }), noopCb())
    await first.done
    expect(first.resumed).toBe(false)
    expect(cap.task!.sessionId).toBeUndefined()
    const second = runSeat('c1', seat('a'), 'p', deps({ codex: provider }), noopCb())
    await second.done
    expect(second.resumed).toBe(true)
    expect(cap.task!.sessionId).toBe('native-1')
    const other = runSeat('c1', seat('b'), 'p', deps({ codex: provider }), noopCb())
    await other.done
    expect(other.resumed).toBe(false)
    expect(readSession(ws, 's1', 'codex')).toBeUndefined()
    expect(readSession(ws, 's1', seatResumeKey('c1', 'a'))).toBe('native-1')
  })

  it('onConfirm: readOnly allows, otherwise denies', async () => {
    const { provider, cap } = fakeProvider('codex', () => {})
    runSeat('c1', seat('a'), 'p', deps({ codex: provider }), noopCb())
    const ask = (readOnly?: boolean): Promise<ConfirmDecision> => cap.cb!.onConfirm!({ title: 't', readOnly } as ConfirmReq)
    expect(await ask(true)).toBe('allow')
    expect(await ask(false)).toBe('deny')
    expect(await ask(undefined)).toBe('deny')
  })

  it('fails fast when provider errors immediately', async () => {
    const { provider } = fakeProvider('codex', (_t, cb) => cb.onError(new Error('boom')))
    const r = await runSeat('c1', seat('a'), 'p', deps({ codex: provider }), noopCb()).done
    expect(r).toMatchObject({ ok: false, error: 'boom' })
  })

  // (没有 chat() 的 provider 改走 run(),见上面的「a provider without chat()」)
  it('unknown provider -> ok:false', async () => {
    const r = await runSeat('c1', seat('a', 'nope'), 'p', deps({}), noopCb()).done
    expect(r.ok).toBe(false)
  })

  it('times out after 300000ms of silence and cancels the provider', async () => {
    vi.useFakeTimers()
    const { provider, cap } = fakeProvider('codex', () => {})
    const run = runSeat('c1', seat('a'), 'p', deps({ codex: provider }), noopCb())
    await vi.advanceTimersByTimeAsync(299_999)
    expect(cap.cancelled).toBe(0)
    await vi.advanceTimersByTimeAsync(2)
    expect(await run.done).toMatchObject({ ok: false, error: 'timeout' })
    expect(cap.cancelled).toBe(1)
  })

  it('output resets the idle timer', async () => {
    vi.useFakeTimers()
    const { provider, cap } = fakeProvider('codex', () => {})
    const run = runSeat('c1', seat('a'), 'p', deps({ codex: provider }), noopCb())
    await vi.advanceTimersByTimeAsync(200_000)
    cap.cb!.onAssistantDelta('x')
    await vi.advanceTimersByTimeAsync(200_000)
    expect(cap.cancelled).toBe(0)
    cap.cb!.onDone({ elapsed: 1 })
    expect(await run.done).toMatchObject({ ok: true, text: 'x' })
  })
})

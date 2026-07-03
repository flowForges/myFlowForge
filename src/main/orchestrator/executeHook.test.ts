import { describe, it, expect, vi } from 'vitest'
import { executeHook } from './executeHook'
import type { AgentCallbacks, AgentProvider, AgentSession, AgentTask, LogLine } from '../agents/types'

const noopCb = (): AgentCallbacks => ({
  onLog: () => {},
  onState: () => {},
  onConfirm: async () => 'allow',
  onInput: async () => '',
  onDone: () => {},
  onError: () => {},
})

const task: AgentTask = { stageKey: 's', agentId: 'a', name: 'n', prompt: 'p', cwd: '/tmp', model: 'm' }

// A minimal fake provider whose run() drives the callbacks, then resolves/rejects done.
function fakeProvider(drive: (cb: AgentCallbacks) => Promise<{ ok: boolean }>): {
  provider: AgentProvider
  session?: AgentSession
} {
  const out: { provider: AgentProvider; session?: AgentSession } = { provider: null as never }
  out.provider = {
    id: 'claude',
    displayName: 'Claude',
    capabilities: { structuredOutput: false, permissionHook: false, pty: false },
    detect: async () => true,
    listModels: async () => [],
    run: (_task, cb) => {
      const done = drive(cb)
      out.session = { id: 'sess', cancel: vi.fn(), done } as AgentSession
      return out.session
    },
  }
  return out
}

describe('executeHook', () => {
  it('captures output-kind log text and returns ok:true', async () => {
    const fp = fakeProvider(async (cb) => {
      cb.onLog({ ts: '', text: 'xyz', level: 'info', kind: 'output' } as LogLine)
      return { ok: true }
    })
    const r = await executeHook(fp.provider, task, noopCb(), {})
    expect(r).toEqual({ ok: true, output: 'xyz', error: undefined })
  })

  it('does NOT capture an ok-level line lacking kind:output (progress chatter)', async () => {
    const fp = fakeProvider(async (cb) => {
      cb.onLog({ ts: '', text: 'done', level: 'ok' } as LogLine)
      return { ok: true }
    })
    const r = await executeHook(fp.provider, task, noopCb(), {})
    expect(r.ok).toBe(true)
    expect(r.output).toBe('')
  })

  it('joins multiple captured lines with newlines and ignores anything not kind:output', async () => {
    const fp = fakeProvider(async (cb) => {
      cb.onLog({ ts: '', text: 'a', level: 'info', kind: 'output' } as LogLine)
      cb.onLog({ ts: '', text: 'skip', level: 'info', kind: 'think' } as LogLine)
      cb.onLog({ ts: '', text: 'chatter', level: 'ok' } as LogLine)
      cb.onLog({ ts: '', text: 'b', level: 'ok', kind: 'output' } as LogLine)
      return { ok: true }
    })
    const r = await executeHook(fp.provider, task, noopCb(), {})
    expect(r.output).toBe('a\nb')
  })

  it('returns ok:false when onState("err") fires', async () => {
    const fp = fakeProvider(async (cb) => {
      cb.onState('err')
      return { ok: true }
    })
    const r = await executeHook(fp.provider, task, noopCb(), {})
    expect(r.ok).toBe(false)
  })

  it('returns ok:false + error message when session.done rejects', async () => {
    const fp = fakeProvider(async () => {
      throw new Error('boom')
    })
    const r = await executeHook(fp.provider, task, noopCb(), {})
    expect(r.ok).toBe(false)
    expect(r.error).toBe('boom')
  })

  it('resolves ok:false (does NOT reject) when provider.run() throws synchronously', async () => {
    const provider: AgentProvider = {
      id: 'claude',
      displayName: 'Claude',
      capabilities: { structuredOutput: false, permissionHook: false, pty: false },
      detect: async () => true,
      listModels: async () => [],
      run: () => { throw new Error('boom-sync') },
    }
    const r = await executeHook(provider, task, noopCb(), {})
    expect(r.ok).toBe(false)
    expect(r.error).toContain('boom-sync')
  })

  it('calls onSession with the provider session and forwards cb', async () => {
    const seenLogs: LogLine[] = []
    const seenStates: string[] = []
    const cb: AgentCallbacks = { ...noopCb(), onLog: (l) => seenLogs.push(l), onState: (s) => seenStates.push(s) }
    const fp = fakeProvider(async (c) => {
      c.onLog({ ts: '', text: 'x', level: 'info', kind: 'output' } as LogLine)
      c.onState('ok')
      return { ok: true }
    })
    const onSession = vi.fn()
    await executeHook(fp.provider, task, cb, {}, { onSession })
    expect(onSession).toHaveBeenCalledTimes(1)
    expect(onSession).toHaveBeenCalledWith(fp.session)
    expect(seenLogs.map((l) => l.text)).toContain('x')
    expect(seenStates).toContain('ok')
  })
})
